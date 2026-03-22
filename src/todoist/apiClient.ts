/**
 * Thin HTTP client for the Todoist API v1.
 * Docs: https://developer.todoist.com/api/v1/
 */

import { TodoistTask, TodoistProject, TodoistComment, TodoistLabel } from './types';

const BASE_URL = 'https://api.todoist.com/api/v1';

export class TodoistApiClient {
    constructor(private readonly token: string) {}

    // -------------------------------------------------------------------------
    // Projects
    // -------------------------------------------------------------------------

    async getProjects(): Promise<TodoistProject[]> {
        return this._getAllPages<TodoistProject>('/projects');
    }

    async getProject(id: string): Promise<TodoistProject> {
        return this._get<TodoistProject>(`/projects/${id}`);
    }

    async createProject(name: string, parentId?: string): Promise<TodoistProject> {
        return this._post<TodoistProject>('/projects', {
            name,
            ...(parentId ? { parent_id: parentId } : {}),
        });
    }

    async deleteProject(id: string): Promise<void> {
        await this._delete(`/projects/${id}`);
    }

    async updateProject(id: string, params: { name?: string }): Promise<TodoistProject> {
        return this._post<TodoistProject>(`/projects/${id}`, params);
    }

    // -------------------------------------------------------------------------
    // Tasks
    // -------------------------------------------------------------------------

    async getTasks(projectId?: string): Promise<TodoistTask[]> {
        const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
        return this._getAllPages<TodoistTask>(`/tasks${query}`);
    }

    async getTask(id: string): Promise<TodoistTask> {
        return this._get<TodoistTask>(`/tasks/${id}`);
    }

    async createTask(params: {
        content: string;
        description?: string;
        project_id?: string;
        parent_id?: string;
        priority?: number;
        due_date?: string;
        due_datetime?: string;
        labels?: string[];
    }): Promise<TodoistTask> {
        return this._post<TodoistTask>('/tasks', params);
    }

    async updateTask(id: string, params: {
        content?: string;
        description?: string;
        priority?: number;
        due_date?: string;
        due_datetime?: string;
        due_string?: string;
        labels?: string[];
    }): Promise<TodoistTask> {
        return this._post<TodoistTask>(`/tasks/${id}`, params);
    }

    async closeTask(id: string): Promise<void> {
        await this._post<void>(`/tasks/${id}/close`, {});
    }

    async reopenTask(id: string): Promise<void> {
        await this._post<void>(`/tasks/${id}/reopen`, {});
    }

    async deleteTask(id: string): Promise<void> {
        await this._delete(`/tasks/${id}`);
    }

    async moveTask(id: string, params: {
        project_id?: string;
        parent_id?: string | null;
    }): Promise<TodoistTask> {
        return this._post<TodoistTask>(`/tasks/${id}/move`, params);
    }

    // -------------------------------------------------------------------------
    // Comments
    // -------------------------------------------------------------------------

    async getComments(taskId: string): Promise<TodoistComment[]> {
        return this._getAllPages<TodoistComment>(`/comments?task_id=${encodeURIComponent(taskId)}`);
    }

    async addComment(taskId: string, content: string): Promise<TodoistComment> {
        return this._post<TodoistComment>('/comments', { task_id: taskId, content });
    }

    // -------------------------------------------------------------------------
    // Labels
    // -------------------------------------------------------------------------

    async getLabels(): Promise<string[]> {
        // Fetch personal labels
        const personal = await this._getAllPages<TodoistLabel>('/labels');
        // Fetch shared labels (labels on active tasks, returned as plain strings)
        const shared = await this._getAllPages<string>('/labels/shared');
        const names = new Set<string>([
            ...personal.map(l => l.name),
            ...shared,
        ]);
        return [...names].sort();
    }

    async createLabel(name: string): Promise<TodoistLabel> {
        return this._post<TodoistLabel>('/labels', { name });
    }

    async deleteLabel(id: string): Promise<void> {
        await this._delete(`/labels/${id}`);
    }

    async updateLabel(id: string, params: { name?: string; color?: string; is_favorite?: boolean }): Promise<TodoistLabel> {
        return this._post<TodoistLabel>(`/labels/${id}`, params);
    }

    async getPersonalLabels(): Promise<TodoistLabel[]> {
        return this._getAllPages<TodoistLabel>('/labels');
    }

    // -------------------------------------------------------------------------
    // HTTP helpers
    // -------------------------------------------------------------------------

    /** Fetch all pages from a paginated endpoint (returns { results: T[], next_cursor: string|null }). */
    private async _getAllPages<T>(path: string): Promise<T[]> {
        const allResults: T[] = [];
        const sep = path.includes('?') ? '&' : '?';
        let cursor: string | null = null;
        do {
            const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
            const url = `${BASE_URL}${path}${sep}limit=200${cursorParam}`;
            const res = await fetch(url, {
                headers: { Authorization: `Bearer ${this.token}` },
            });
            if (!res.ok) {
                throw new Error(`Todoist API error ${res.status} on GET ${path}`);
            }
            const page = await res.json() as { results: T[]; next_cursor: string | null };
            allResults.push(...page.results);
            cursor = page.next_cursor;
        } while (cursor);
        return allResults;
    }

    private async _get<T>(path: string): Promise<T> {
        const res = await fetch(`${BASE_URL}${path}`, {
            headers: {
                Authorization: `Bearer ${this.token}`,
            },
        });
        if (!res.ok) {
            throw new Error(`Todoist API error ${res.status} on GET ${path}`);
        }
        return res.json() as Promise<T>;
    }

    private async _post<T>(path: string, body: object): Promise<T> {
        const res = await fetch(`${BASE_URL}${path}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            throw new Error(`Todoist API error ${res.status} on POST ${path}`);
        }
        // Some endpoints (close, reopen) return 204 No Content
        if (res.status === 204 || res.headers.get('content-length') === '0') {
            return undefined as unknown as T;
        }
        return res.json() as Promise<T>;
    }

    private async _delete(path: string): Promise<void> {
        const res = await fetch(`${BASE_URL}${path}`, {
            method: 'DELETE',
            headers: {
                Authorization: `Bearer ${this.token}`,
            },
        });
        if (!res.ok) {
            throw new Error(`Todoist API error ${res.status} on DELETE ${path}`);
        }
        // v1 returns 200 with null body; v2 returns 204 — both are success
    }
}
