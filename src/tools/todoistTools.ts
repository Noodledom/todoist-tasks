/**
 * Language Model Tools — exposes TodoistService operations as Copilot agent tools.
 *
 * Each tool implements vscode.LanguageModelTool<TInput> and is registered via
 * vscode.lm.registerTool() in extension.ts.
 *
 * Tools available in agent mode (@workspace / Ask):
 *   - todoist_list_tasks   — query tasks with optional filters
 *   - todoist_create_task  — create a new task
 *   - todoist_update_task  — update fields on an existing task
 *   - todoist_complete_task — mark a task complete
 *   - todoist_delete_task  — delete a task
 */

import * as vscode from 'vscode';
import { TodoistService } from '../todoist/todoistService';
import { Priority } from '../todoist/types';

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

function notInitialisedResult(): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
            'Todoist is not initialised. Ask the user to run "Todoist: Set API Token" first.'
        ),
    ]);
}

// ---------------------------------------------------------------------------
// todoist_list_tasks
// ---------------------------------------------------------------------------

export interface IListTasksInput {
    /** Filter by project name (partial, case-insensitive) */
    project?: string;
    /** Filter by priority: none | low | medium | high */
    priority?: string;
    /** Filter by label name */
    label?: string;
    /** Only return tasks due on or before this date (YYYY-MM-DD) */
    due_before?: string;
    /** Include completed tasks (default false) */
    include_completed?: boolean;
    /** Max number of results to return (default 50) */
    limit?: number;
}

export class ListTasksTool implements vscode.LanguageModelTool<IListTasksInput> {
    constructor(private readonly service: TodoistService) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IListTasksInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.service.isInitialised()) { return notInitialisedResult(); }

        const { project, priority, label, due_before, include_completed, limit = 50 } = options.input;

        let tasks = this.service.getTasks(
            {
                priority: priority as Priority | undefined,
                tags: label ? [label] : undefined,
                showCompleted: include_completed ?? false,
            }
        );

        // Filter by project name (partial match)
        if (project) {
            const collections = this.service.getCollections();
            const match = collections.find(c =>
                c.name.toLowerCase().includes(project.toLowerCase())
            );
            if (match) {
                tasks = tasks.filter(t => t.collectionId === match.id);
            }
        }

        // Filter by due_before
        if (due_before) {
            tasks = tasks.filter(t => t.dueDate && t.dueDate.slice(0, 10) <= due_before);
        }

        // Limit
        tasks = tasks.slice(0, limit);

        if (tasks.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No tasks found matching the given filters.'),
            ]);
        }

        const collections = this.service.getCollections();
        const projectName = (id: string) =>
            collections.find(c => c.id === id)?.name ?? id;

        const lines = tasks.map(t => {
            const parts = [`[${t.uid}] ${t.title}`];
            parts.push(`project: ${projectName(t.collectionId)}`);
            if (t.dueDate) { parts.push(`due: ${t.dueDate.slice(0, 10)}`); }
            if (t.priority !== 'none') { parts.push(`priority: ${t.priority}`); }
            if (t.tags.length > 0) { parts.push(`labels: ${t.tags.join(', ')}`); }
            if (t.completed) { parts.push('(completed)'); }
            return parts.join(' | ');
        });

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Found ${tasks.length} task(s):\n${lines.join('\n')}`
            ),
        ]);
    }
}

// ---------------------------------------------------------------------------
// todoist_create_task
// ---------------------------------------------------------------------------

export interface ICreateTaskInput {
    /** Task title (required) */
    title: string;
    /** Project name (partial match). Defaults to inbox if omitted. */
    project?: string;
    /** Due date as YYYY-MM-DD */
    due_date?: string;
    /** Priority: none | low | medium | high */
    priority?: string;
    /** Comma-separated label names */
    labels?: string;
    /** Optional description */
    description?: string;
}

export class CreateTaskTool implements vscode.LanguageModelTool<ICreateTaskInput> {
    constructor(private readonly service: TodoistService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ICreateTaskInput>,
        _token: vscode.CancellationToken
    ) {
        const { title, project, due_date, priority, labels } = options.input;
        const details: string[] = [];
        if (project)   { details.push(`project: **${project}**`); }
        if (due_date)  { details.push(`due: **${due_date}**`); }
        if (priority && priority !== 'none') { details.push(`priority: **${priority}**`); }
        if (labels)    { details.push(`labels: **${labels}**`); }

        return {
            invocationMessage: `Creating task "${title}"…`,
            confirmationMessages: {
                title: 'Create Todoist task',
                message: new vscode.MarkdownString(
                    `Create task **"${title}"**${details.length > 0 ? '\n\n' + details.join('  \n') : ''}?`
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ICreateTaskInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.service.isInitialised()) { return notInitialisedResult(); }

        const { title, project, due_date, priority, labels, description } = options.input;

        // Resolve project id
        let collectionId: string | undefined;
        if (project) {
            const collections = this.service.getCollections();
            const match = collections.find(c =>
                c.name.toLowerCase().includes(project.toLowerCase())
            );
            collectionId = match?.id;
            if (!collectionId) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Project "${project}" not found. Available projects: ${collections.map(c => c.name).join(', ')}`
                    ),
                ]);
            }
        } else {
            // Fall back to first collection (inbox equivalent)
            const collections = this.service.getCollections();
            collectionId = collections[0]?.id;
            if (!collectionId) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('No projects found. Make sure Todoist is connected.'),
                ]);
            }
        }

        const task = await this.service.createTask({
            title,
            collectionId,
            description: description || undefined,
            dueDate: due_date || undefined,
            priority: (priority as Priority) || 'none',
            tags: labels ? labels.split(',').map(l => l.trim()).filter(Boolean) : [],
        });

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Task created: [${task.uid}] "${task.title}"`
            ),
        ]);
    }
}

// ---------------------------------------------------------------------------
// todoist_update_task
// ---------------------------------------------------------------------------

export interface IUpdateTaskInput {
    /** The task ID (uid) from a previous list_tasks call */
    task_id: string;
    /** New title */
    title?: string;
    /** New due date (YYYY-MM-DD), or empty string to clear */
    due_date?: string;
    /** New priority: none | low | medium | high */
    priority?: string;
    /** Comma-separated labels (replaces existing labels) */
    labels?: string;
    /** New description */
    description?: string;
}

export class UpdateTaskTool implements vscode.LanguageModelTool<IUpdateTaskInput> {
    constructor(private readonly service: TodoistService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IUpdateTaskInput>,
        _token: vscode.CancellationToken
    ) {
        const { task_id, title, due_date, priority, labels } = options.input;
        const task = this.service.getTask(task_id);
        const taskLabel = task ? `"${task.title}"` : `task ${task_id}`;

        const changes: string[] = [];
        if (title)    { changes.push(`title → **${title}**`); }
        if (due_date !== undefined) { changes.push(`due → **${due_date || 'none'}**`); }
        if (priority) { changes.push(`priority → **${priority}**`); }
        if (labels !== undefined)  { changes.push(`labels → **${labels || 'none'}**`); }

        return {
            invocationMessage: `Updating ${taskLabel}…`,
            confirmationMessages: {
                title: 'Update Todoist task',
                message: new vscode.MarkdownString(
                    `Update ${taskLabel}:\n\n${changes.join('  \n') || '(no changes specified)'}`
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IUpdateTaskInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.service.isInitialised()) { return notInitialisedResult(); }

        const { task_id, title, due_date, priority, labels, description } = options.input;
        const task = this.service.getTask(task_id);
        if (!task) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Task ID "${task_id}" not found. Use todoist_list_tasks to find the correct ID.`
                ),
            ]);
        }

        const updated = {
            ...task,
            title:       title       !== undefined ? title       : task.title,
            description: description !== undefined ? (description || undefined) : task.description,
            dueDate:     due_date    !== undefined ? (due_date || undefined)    : task.dueDate,
            priority:    priority    !== undefined ? (priority as Priority)     : task.priority,
            tags:        labels      !== undefined
                ? labels.split(',').map(l => l.trim()).filter(Boolean)
                : task.tags,
        };

        await this.service.updateTask(updated);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Task "${updated.title}" updated successfully.`),
        ]);
    }
}

// ---------------------------------------------------------------------------
// todoist_complete_task
// ---------------------------------------------------------------------------

export interface ICompleteTaskInput {
    /** The task ID (uid) */
    task_id: string;
    /** Also complete all subtasks (default false) */
    include_subtasks?: boolean;
}

export class CompleteTaskTool implements vscode.LanguageModelTool<ICompleteTaskInput> {
    constructor(private readonly service: TodoistService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ICompleteTaskInput>,
        _token: vscode.CancellationToken
    ) {
        const task = this.service.getTask(options.input.task_id);
        const taskLabel = task ? `"${task.title}"` : `task ${options.input.task_id}`;
        const subtaskNote = options.input.include_subtasks ? ' (and all subtasks)' : '';

        return {
            invocationMessage: `Completing ${taskLabel}…`,
            confirmationMessages: {
                title: 'Complete Todoist task',
                message: new vscode.MarkdownString(`Mark ${taskLabel}${subtaskNote} as complete?`),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ICompleteTaskInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.service.isInitialised()) { return notInitialisedResult(); }

        const { task_id, include_subtasks } = options.input;
        const task = this.service.getTask(task_id);
        if (!task) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Task ID "${task_id}" not found. Use todoist_list_tasks to find the correct ID.`
                ),
            ]);
        }

        await this.service.completeTask(task_id, include_subtasks ?? false);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Task "${task.title}" marked as complete.`),
        ]);
    }
}

// ---------------------------------------------------------------------------
// todoist_delete_task
// ---------------------------------------------------------------------------

export interface IDeleteTaskInput {
    /** The task ID (uid) */
    task_id: string;
}

export class DeleteTaskTool implements vscode.LanguageModelTool<IDeleteTaskInput> {
    constructor(private readonly service: TodoistService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IDeleteTaskInput>,
        _token: vscode.CancellationToken
    ) {
        const task = this.service.getTask(options.input.task_id);
        const taskLabel = task ? `"${task.title}"` : `task ${options.input.task_id}`;

        return {
            invocationMessage: `Deleting ${taskLabel}…`,
            confirmationMessages: {
                title: 'Delete Todoist task',
                message: new vscode.MarkdownString(
                    `⚠️ Permanently delete ${taskLabel}? This cannot be undone.`
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IDeleteTaskInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.service.isInitialised()) { return notInitialisedResult(); }

        const { task_id } = options.input;
        const task = this.service.getTask(task_id);
        if (!task) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Task ID "${task_id}" not found. Use todoist_list_tasks to find the correct ID.`
                ),
            ]);
        }

        const title = task.title;
        await this.service.deleteTask(task_id);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Task "${title}" deleted.`),
        ]);
    }
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

export function registerTodoistTools(
    context: vscode.ExtensionContext,
    service: TodoistService
): void {
    context.subscriptions.push(
        vscode.lm.registerTool('todoist_list_tasks',    new ListTasksTool(service)),
        vscode.lm.registerTool('todoist_create_task',   new CreateTaskTool(service)),
        vscode.lm.registerTool('todoist_update_task',   new UpdateTaskTool(service)),
        vscode.lm.registerTool('todoist_complete_task', new CompleteTaskTool(service)),
        vscode.lm.registerTool('todoist_delete_task',   new DeleteTaskTool(service)),
    );
}
