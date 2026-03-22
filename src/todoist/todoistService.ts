/**
 * TodoistService — business-logic layer backed by the Todoist REST API.
 *
 * Maintains an in-memory cache and polls the API on a configurable interval.
 */

import * as vscode from 'vscode';
import { TodoistApiClient } from './apiClient';
import {
    Task,
    Collection,
    TaskFilter,
    TaskSort,
    Priority,
    TodoistTask,
    TodoistProject,
    TodoistComment,
} from './types';

// ---------------------------------------------------------------------------
// Priority mapping helpers
// ---------------------------------------------------------------------------
// Todoist: 1 = normal/none, 2 = low, 3 = medium, 4 = urgent/high
// Our model: 'none' | 'low' | 'medium' | 'high'

function todoistPriorityToLocal(p: number): Priority {
    switch (p) {
        case 4: return 'high';
        case 3: return 'medium';
        case 2: return 'low';
        default: return 'none';
    }
}

function localPriorityToTodoist(p: Priority): number {
    switch (p) {
        case 'high':   return 4;
        case 'medium': return 3;
        case 'low':    return 2;
        default:       return 1;
    }
}

// ---------------------------------------------------------------------------
// Mapping: raw Todoist → domain Task / Collection
// ---------------------------------------------------------------------------

function mapTask(raw: TodoistTask): Task {
    // Prefer datetime (has time component) over date-only
    const rawDatetime = raw.due?.datetime;   // e.g. "2026-04-07T09:00:00"
    const rawDate     = raw.due?.date;       // e.g. "2026-04-07"
    const dueDate = rawDatetime?.slice(0, 10) ?? rawDate ?? undefined;
    // Extract HH:MM from datetime if present
    const dueTime = rawDatetime ? rawDatetime.slice(11, 16) : undefined;
    return {
        uid: raw.id,
        collectionId: raw.project_id,
        title: raw.content,
        description: raw.description || undefined,
        priority: todoistPriorityToLocal(raw.priority),
        dueDate: dueDate || undefined,
        dueTime: dueTime || undefined,
        dueString: raw.due?.string || undefined,
        isRecurring: raw.due?.is_recurring ?? false,
        createdAt: raw.added_at,
        completed: raw.checked,
        tags: raw.labels ?? [],
        parentUid: raw.parent_id || undefined,
        order: raw.child_order,
    };
}

function mapProject(raw: TodoistProject): Collection {
    return {
        id: raw.id,
        name: raw.name,
        color: raw.color,
        parentId: raw.parent_id || undefined,
    };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TodoistService implements vscode.Disposable {
    private client: TodoistApiClient | undefined;
    private store: { projects: TodoistProject[]; tasks: TodoistTask[] } = { projects: [], tasks: [] };
    private pollTimer: ReturnType<typeof setInterval> | undefined;
    private readonly pollIntervalMs: number;
    private consecutiveFailures = 0;

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(pollIntervalSeconds = 60) {
        this.pollIntervalMs = pollIntervalSeconds * 1000;
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    /** Call after the API token is available */
    init(token: string): void {
        this.client = new TodoistApiClient(token);
        this._startPolling();
    }

    /** Replace the token (e.g. user re-entered it) and reload */
    setToken(token: string): void {
        this.init(token);
    }

    /** Returns true if the service has been initialised with an API token */
    isInitialised(): boolean {
        return this.client !== undefined;
    }

    private _startPolling(): void {
        this._stopPolling();
        // Immediate load
        this._load().catch(err =>
            vscode.window.showErrorMessage(`Todoist: Failed to load data — ${err.message}`)
        );
        // Periodic refresh
        this.pollTimer = setInterval(() => {
            this._load().catch(() => {
                this.consecutiveFailures++;
                if (this.consecutiveFailures === 3) {
                    vscode.window.showWarningMessage(
                        'Todoist: Unable to sync — check your API token and network connection.'
                    );
                }
            });
        }, this.pollIntervalMs);
    }

    private _stopPolling(): void {
        if (this.pollTimer !== undefined) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
    }

    async reload(): Promise<void> {
        if (!this.client) { return; }
        await this._load();
    }

    private async _load(): Promise<void> {
        if (!this.client) { return; }
        const [projects, tasks] = await Promise.all([
            this.client.getProjects(),
            this.client.getTasks(),
        ]);
        this.store = { projects, tasks };
        this.consecutiveFailures = 0;
        this._onDidChange.fire();
    }

    // -------------------------------------------------------------------------
    // Collections (Projects)
    // -------------------------------------------------------------------------

    getCollections(): Collection[] {
        return this.store.projects.map(mapProject);
    }

    async createProject(name: string): Promise<void> {
        if (!this.client) { throw new Error('Todoist: not initialised'); }
        const raw = await this.client.createProject(name);
        this.store.projects.push(raw);
        this._onDidChange.fire();
    }

    async deleteProject(id: string): Promise<void> {
        if (!this.client) { throw new Error('Todoist: not initialised'); }
        await this.client.deleteProject(id);
        this.store.projects = this.store.projects.filter(p => p.id !== id);
        this.store.tasks = this.store.tasks.filter(t => t.project_id !== id);
        this._onDidChange.fire();
    }

    async renameProject(id: string, name: string): Promise<void> {
        if (!this.client) { throw new Error('Todoist: not initialised'); }
        const updated = await this.client.updateProject(id, { name });
        const raw = this.store.projects.find(p => p.id === id);
        if (raw) { raw.name = updated.name; }
        this._onDidChange.fire();
    }

    // -------------------------------------------------------------------------
    // Tasks — read
    // -------------------------------------------------------------------------

    getTasks(filter?: TaskFilter, sort?: TaskSort): Task[] {
        let tasks = this.store.tasks.map(mapTask);

        if (filter) {
            if (filter.collectionId) {
                tasks = tasks.filter(t => t.collectionId === filter.collectionId);
            }
            if (!filter.showCompleted) {
                tasks = tasks.filter(t => !t.completed);
            }
            if (filter.priority) {
                tasks = tasks.filter(t => t.priority === filter.priority);
            }
            if (filter.tags && filter.tags.length > 0) {
                tasks = tasks.filter(t => filter.tags!.some(tag => t.tags.includes(tag)));
            }
            if (filter.searchQuery) {
                const q = filter.searchQuery.toLowerCase();
                tasks = tasks.filter(t => t.title.toLowerCase().includes(q));
            }
        } else {
            // No filter passed → hide completed by default
            tasks = tasks.filter(t => !t.completed);
        }

        if (sort) {
            tasks = this._sort(tasks, sort);
        }

        return tasks;
    }

    getTask(uid: string): Task | undefined {
        const raw = this.store.tasks.find(t => t.id === uid);
        return raw ? mapTask(raw) : undefined;
    }

    getSubtasks(parentUid: string): Task[] {
        return this.store.tasks
            .filter(t => t.parent_id === parentUid)
            .map(mapTask);
    }

    async getAllTags(): Promise<string[]> {
        if (!this.client) { return []; }
        try {
            return await this.client.getLabels();
        } catch {
            // Fallback: scrape from cached tasks
            const tags = new Set<string>();
            this.store.tasks.forEach(t => (t.labels ?? []).forEach(l => tags.add(l)));
            return Array.from(tags).sort();
        }
    }

    async createLabel(name: string): Promise<string> {
        if (!this.client) { throw new Error('Todoist: not initialised'); }
        const label = await this.client.createLabel(name);
        return label.name;
    }

    async deleteLabel(name: string): Promise<void> {
        if (!this.client) { throw new Error('Todoist: not initialised'); }
        // Find the label id by name
        const labels = await this.client.getPersonalLabels();
        const found = labels.find(l => l.name === name);
        if (!found) { throw new Error(`Label "${name}" not found`); }
        await this.client.deleteLabel(found.id);
    }

    async renameLabel(oldName: string, newName: string): Promise<void> {
        if (!this.client) { throw new Error('Todoist: not initialised'); }
        const labels = await this.client.getPersonalLabels();
        const found = labels.find(l => l.name === oldName);
        if (!found) { throw new Error(`Label "${oldName}" not found`); }
        await this.client.updateLabel(found.id, { name: newName });
        // Update cached tasks that use the old label name
        this.store.tasks.forEach(t => {
            if (t.labels) {
                const idx = t.labels.indexOf(oldName);
                if (idx !== -1) { t.labels[idx] = newName; }
            }
        });
        this._onDidChange.fire();
    }

    /**
     * Update the labels on a task.
     * mode 'replace' — set labels to exactly the given list (default)
     * mode 'add'     — add labels to existing set
     * mode 'remove'  — remove labels from existing set
     */
    async updateTaskLabels(
        uid: string,
        labels: string[],
        mode: 'replace' | 'add' | 'remove' = 'replace'
    ): Promise<void> {
        if (!this.client) { throw new Error('Todoist: not initialised'); }
        const task = this.getTask(uid);
        if (!task) { throw new Error(`Task "${uid}" not found`); }

        let newLabels: string[];
        if (mode === 'add') {
            newLabels = [...new Set([...task.tags, ...labels])];
        } else if (mode === 'remove') {
            newLabels = task.tags.filter(t => !labels.includes(t));
        } else {
            newLabels = labels;
        }

        const updated = await this.client.updateTask(uid, { labels: newLabels });
        const idx = this.store.tasks.findIndex(t => t.id === uid);
        if (idx !== -1) { this.store.tasks[idx] = updated; }
        this._onDidChange.fire();
    }

    // -------------------------------------------------------------------------
    // Tasks — write
    // -------------------------------------------------------------------------

    /**
     * Ask Todoist to parse a natural-language due string and return the resolved
     * date/time back. Creates and immediately deletes a temporary task in the
     * Inbox. Returns undefined if the string is not recognised.
     */
    async parseDueString(dueString: string): Promise<{ date: string; datetime?: string; isRecurring: boolean; string: string } | undefined> {
        if (!this.client) { return undefined; }
        // Use Inbox project (first project whose inbox_project flag is set, or first project)
        const inboxProject = this.store.projects.find(p => (p as { inbox_project?: boolean }).inbox_project)
            ?? this.store.projects[0];
        if (!inboxProject) { return undefined; }
        let tempTask: TodoistTask | undefined;
        try {
            tempTask = await this.client.createTask({
                content: '__due_parse_preview__',
                project_id: inboxProject.id,
                due_string: dueString,
            });
            const due = tempTask.due;
            if (!due) { return undefined; }
            return {
                date: due.date,
                datetime: due.datetime,
                isRecurring: due.is_recurring,
                string: due.string ?? dueString,
            };
        } catch {
            return undefined;
        } finally {
            if (tempTask?.id) {
                try { await this.client.deleteTask(tempTask.id); } catch { /* best effort */ }
            }
        }
    }

    async createTask(partial: Partial<Task> & { collectionId: string; title: string }): Promise<Task> {
        if (!this.client) { throw new Error('Todoist: not initialised'); }

        const raw = await this.client.createTask({
            content: partial.title,
            description: partial.description,
            project_id: partial.collectionId,
            parent_id: partial.parentUid,
            priority: localPriorityToTodoist(partial.priority ?? 'none'),
            // Prefer natural-language due_string (supports recurrence + time)
            ...(partial.dueString
                ? { due_string: partial.dueString }
                : partial.dueDate
                    ? { due_date: partial.dueDate }
                    : {}),
            labels: partial.tags,
        });

        this.store.tasks.push(raw);
        this._onDidChange.fire();
        return mapTask(raw);
    }

    async updateTask(task: Task): Promise<void> {
        if (!this.client) { throw new Error('Todoist: not initialised'); }

        // Build due params: prefer natural-language due_string (supports recurrence + time).
        // Passing due_string: 'no date' clears the due date.
        let dueParams: { due_string?: string; due_date?: string };
        if (task.dueString) {
            dueParams = { due_string: task.dueString };
        } else if (task.dueDate) {
            dueParams = { due_date: task.dueDate };
        } else {
            dueParams = { due_string: 'no date' };
        }

        const updated = await this.client.updateTask(task.uid, {
            content: task.title,
            description: task.description,
            priority: localPriorityToTodoist(task.priority),
            ...dueParams,
            labels: task.tags,
        });

        const idx = this.store.tasks.findIndex(t => t.id === task.uid);
        if (idx !== -1) { this.store.tasks[idx] = updated; }
        this._onDidChange.fire();
    }

    async completeTask(uid: string, completeSubtasks = false): Promise<void> {
        if (!this.client) { throw new Error('Todoist: not initialised'); }

        const toComplete = [uid];
        if (completeSubtasks) {
            this.getSubtasks(uid).forEach(s => toComplete.push(s.uid));
        }

        await Promise.all(toComplete.map(id => this.client!.closeTask(id)));

        toComplete.forEach(id => {
            const raw = this.store.tasks.find(t => t.id === id);
            if (raw) { raw.checked = true; }
        });
        this._onDidChange.fire();
    }

    async reopenTask(uid: string): Promise<void> {
        if (!this.client) { throw new Error('Todoist: not initialised'); }
        await this.client.reopenTask(uid);

        const raw = this.store.tasks.find(t => t.id === uid);
        if (raw) { raw.checked = false; }
        this._onDidChange.fire();
    }

    async deleteTask(uid: string): Promise<void> {
        if (!this.client) { throw new Error('Todoist: not initialised'); }
        await this.client.deleteTask(uid);

        this.store.tasks = this.store.tasks.filter(t => t.id !== uid);
        this._onDidChange.fire();
    }

    /**
     * Move a task to a different project and/or make it a subtask of another task.
     * Pass parentUid=null to promote to a top-level task.
     */
    async moveTask(uid: string, opts: {
        projectId?: string;
        parentUid?: string | null;
    }): Promise<void> {
        if (!this.client) { throw new Error('Todoist: not initialised'); }

        const params: { project_id?: string; parent_id?: string | null } = {};
        if (opts.projectId !== undefined) { params.project_id = opts.projectId; }
        if (opts.parentUid !== undefined) { params.parent_id = opts.parentUid; }

        const updated = await this.client.moveTask(uid, params);

        const idx = this.store.tasks.findIndex(t => t.id === uid);
        if (idx !== -1) { this.store.tasks[idx] = updated; }
        this._onDidChange.fire();
    }

    async getComments(uid: string): Promise<TodoistComment[]> {
        if (!this.client) { throw new Error('Todoist: not initialised'); }
        return this.client.getComments(uid);
    }

    async addComment(uid: string, content: string): Promise<TodoistComment> {
        if (!this.client) { throw new Error('Todoist: not initialised'); }
        return this.client.addComment(uid, content);
    }

    // -------------------------------------------------------------------------
    // Sorting
    // -------------------------------------------------------------------------

    private _sort(tasks: Task[], sort: TaskSort): Task[] {
        const priorityRank: Record<Priority, number> = { high: 3, medium: 2, low: 1, none: 0 };

        return [...tasks].sort((a, b) => {
            let cmp = 0;
            switch (sort.by) {
                case 'dueDate': {
                    const da = a.dueDate ?? '9999';
                    const db = b.dueDate ?? '9999';
                    cmp = da < db ? -1 : da > db ? 1 : 0;
                    break;
                }
                case 'priority':
                    cmp = priorityRank[a.priority] - priorityRank[b.priority];
                    break;
                case 'title':
                    cmp = a.title.localeCompare(b.title);
                    break;
                case 'created': {
                    const ca = a.createdAt ?? '';
                    const cb = b.createdAt ?? '';
                    cmp = ca < cb ? -1 : ca > cb ? 1 : 0;
                    break;
                }
            }
            return sort.order === 'desc' ? -cmp : cmp;
        });
    }

    // -------------------------------------------------------------------------
    // Disposal
    // -------------------------------------------------------------------------

    dispose(): void {
        this._stopPolling();
        this.client = undefined;
        this._onDidChange.dispose();
    }
}
