/**
 * Language Model Tools — exposes TodoistService operations as Copilot agent tools.
 *
 * Each tool implements vscode.LanguageModelTool<TInput> and is registered via
 * vscode.lm.registerTool() in extension.ts.
 *
 * Tools available in agent mode (@workspace / Ask):
 *   - todoist_list_projects  — list all projects
 *   - todoist_create_project — create a new project
 *   - todoist_delete_project — delete a project and all its tasks
 *   - todoist_rename_project — rename a project
 *   - todoist_list_tasks     — query tasks with optional filters
 *   - todoist_create_task    — create a new task
 *   - todoist_update_task    — update fields on an existing task
 *   - todoist_move_task      — move task to a different project or make it a subtask
 *   - todoist_complete_task  — mark a task complete
 *   - todoist_reopen_task    — reopen a completed task
 *   - todoist_delete_task    — delete a task
 *   - todoist_add_comment    — add a comment to a task
 *   - todoist_list_comments  — list comments on a task
 *   - todoist_list_labels    — list all available labels
 *   - todoist_create_label   — create a new label
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
// todoist_list_projects
// ---------------------------------------------------------------------------

export class ListProjectsTool implements vscode.LanguageModelTool<Record<string, never>> {
    constructor(private readonly service: TodoistService) {}

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.service.isInitialised()) { return notInitialisedResult(); }

        const projects = this.service.getCollections();
        if (projects.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No projects found.'),
            ]);
        }

        const lines = projects.map(p => {
            const parts = [`[${p.id}] ${p.name}`];
            if (p.parentId) { parts.push(`parent: ${projects.find(x => x.id === p.parentId)?.name ?? p.parentId}`); }
            return parts.join(' | ');
        });

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Found ${projects.length} project(s):\n${lines.join('\n')}`),
        ]);
    }
}

// ---------------------------------------------------------------------------
// todoist_create_project
// ---------------------------------------------------------------------------

export interface ICreateProjectInput {
    /** Project name (required) */
    name: string;
}

export class CreateProjectTool implements vscode.LanguageModelTool<ICreateProjectInput> {
    constructor(private readonly service: TodoistService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ICreateProjectInput>,
        _token: vscode.CancellationToken
    ) {
        return {
            invocationMessage: `Creating project "${options.input.name}"…`,
            confirmationMessages: {
                title: 'Create Todoist project',
                message: new vscode.MarkdownString(`Create project **"${options.input.name}"**?`),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ICreateProjectInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.service.isInitialised()) { return notInitialisedResult(); }
        const { name } = options.input;
        if (!name?.trim()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Project name is required.'),
            ]);
        }
        await this.service.createProject(name.trim());
        const created = this.service.getCollections().find(c => c.name === name.trim());
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Project "${name.trim()}" created${created ? ` with ID ${created.id}` : ''}.`
            ),
        ]);
    }
}

// ---------------------------------------------------------------------------
// todoist_delete_project
// ---------------------------------------------------------------------------

export interface IDeleteProjectInput {
    /** Project name (partial match) or ID */
    project: string;
}

export class DeleteProjectTool implements vscode.LanguageModelTool<IDeleteProjectInput> {
    constructor(private readonly service: TodoistService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IDeleteProjectInput>,
        _token: vscode.CancellationToken
    ) {
        return {
            invocationMessage: `Deleting project "${options.input.project}"…`,
            confirmationMessages: {
                title: 'Delete Todoist project',
                message: new vscode.MarkdownString(
                    `⚠️ Permanently delete project **"${options.input.project}"** and ALL its tasks? This cannot be undone.`
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IDeleteProjectInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.service.isInitialised()) { return notInitialisedResult(); }
        const collections = this.service.getCollections();
        const match = collections.find(c =>
            c.id === options.input.project ||
            c.name.toLowerCase().includes(options.input.project.toLowerCase())
        );
        if (!match) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Project "${options.input.project}" not found. Available: ${collections.map(c => c.name).join(', ')}`
                ),
            ]);
        }
        await this.service.deleteProject(match.id);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Project "${match.name}" deleted.`),
        ]);
    }
}

// ---------------------------------------------------------------------------
// todoist_rename_project
// ---------------------------------------------------------------------------

export interface IRenameProjectInput {
    /** Project name (partial match) or ID */
    project: string;
    /** New name */
    new_name: string;
}

export class RenameProjectTool implements vscode.LanguageModelTool<IRenameProjectInput> {
    constructor(private readonly service: TodoistService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IRenameProjectInput>,
        _token: vscode.CancellationToken
    ) {
        return {
            invocationMessage: `Renaming project "${options.input.project}" to "${options.input.new_name}"…`,
            confirmationMessages: {
                title: 'Rename Todoist project',
                message: new vscode.MarkdownString(
                    `Rename **"${options.input.project}"** → **"${options.input.new_name}"**?`
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IRenameProjectInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.service.isInitialised()) { return notInitialisedResult(); }
        const { project, new_name } = options.input;
        if (!new_name?.trim()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('New name is required.'),
            ]);
        }
        const collections = this.service.getCollections();
        const match = collections.find(c =>
            c.id === project || c.name.toLowerCase().includes(project.toLowerCase())
        );
        if (!match) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Project "${project}" not found. Available: ${collections.map(c => c.name).join(', ')}`
                ),
            ]);
        }
        await this.service.renameProject(match.id, new_name.trim());
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Project "${match.name}" renamed to "${new_name.trim()}".`),
        ]);
    }
}

// ---------------------------------------------------------------------------
// todoist_move_task
// ---------------------------------------------------------------------------

export interface IMoveTaskInput {
    /** The task ID (uid) */
    task_id: string;
    /** Destination project name (partial match) or ID */
    project?: string;
    /** Make this task a subtask of this task ID. Pass empty string to promote to top-level. */
    parent_task_id?: string;
}

export class MoveTaskTool implements vscode.LanguageModelTool<IMoveTaskInput> {
    constructor(private readonly service: TodoistService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IMoveTaskInput>,
        _token: vscode.CancellationToken
    ) {
        const task = this.service.getTask(options.input.task_id);
        const taskLabel = task ? `"${task.title}"` : `task ${options.input.task_id}`;
        const details: string[] = [];
        if (options.input.project) { details.push(`project: **${options.input.project}**`); }
        if (options.input.parent_task_id !== undefined) {
            details.push(options.input.parent_task_id
                ? `subtask of: **${options.input.parent_task_id}**`
                : 'promote to top-level');
        }
        return {
            invocationMessage: `Moving ${taskLabel}…`,
            confirmationMessages: {
                title: 'Move Todoist task',
                message: new vscode.MarkdownString(`Move ${taskLabel}\n\n${details.join('  \n')}`),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IMoveTaskInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.service.isInitialised()) { return notInitialisedResult(); }
        const { task_id, project, parent_task_id } = options.input;
        const task = this.service.getTask(task_id);
        if (!task) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Task ID "${task_id}" not found.`),
            ]);
        }

        let projectId: string | undefined;
        if (project) {
            const collections = this.service.getCollections();
            const match = collections.find(c =>
                c.id === project || c.name.toLowerCase().includes(project.toLowerCase())
            );
            if (!match) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Project "${project}" not found. Available: ${collections.map(c => c.name).join(', ')}`
                    ),
                ]);
            }
            projectId = match.id;
        }

        const parentUid: string | null | undefined = parent_task_id !== undefined
            ? (parent_task_id === '' ? null : parent_task_id)
            : undefined;

        await this.service.moveTask(task_id, { projectId, parentUid });
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Task "${task.title}" moved successfully.`),
        ]);
    }
}

// ---------------------------------------------------------------------------
// todoist_reopen_task
// ---------------------------------------------------------------------------

export interface IReopenTaskInput {
    /** The task ID (uid) */
    task_id: string;
}

export class ReopenTaskTool implements vscode.LanguageModelTool<IReopenTaskInput> {
    constructor(private readonly service: TodoistService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IReopenTaskInput>,
        _token: vscode.CancellationToken
    ) {
        const task = this.service.getTask(options.input.task_id);
        const taskLabel = task ? `"${task.title}"` : `task ${options.input.task_id}`;
        return {
            invocationMessage: `Reopening ${taskLabel}…`,
            confirmationMessages: {
                title: 'Reopen Todoist task',
                message: new vscode.MarkdownString(`Mark ${taskLabel} as incomplete?`),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IReopenTaskInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.service.isInitialised()) { return notInitialisedResult(); }
        const { task_id } = options.input;
        const task = this.service.getTask(task_id);
        if (!task) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Task ID "${task_id}" not found.`),
            ]);
        }
        await this.service.reopenTask(task_id);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Task "${task.title}" reopened.`),
        ]);
    }
}

// ---------------------------------------------------------------------------
// todoist_add_comment
// ---------------------------------------------------------------------------

export interface IAddCommentInput {
    /** The task ID (uid) */
    task_id: string;
    /** Comment text */
    content: string;
}

export class AddCommentTool implements vscode.LanguageModelTool<IAddCommentInput> {
    constructor(private readonly service: TodoistService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IAddCommentInput>,
        _token: vscode.CancellationToken
    ) {
        const task = this.service.getTask(options.input.task_id);
        const taskLabel = task ? `"${task.title}"` : `task ${options.input.task_id}`;
        return {
            invocationMessage: `Adding comment to ${taskLabel}…`,
            confirmationMessages: {
                title: 'Add comment',
                message: new vscode.MarkdownString(
                    `Add comment to ${taskLabel}:\n\n> ${options.input.content}`
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IAddCommentInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.service.isInitialised()) { return notInitialisedResult(); }
        const { task_id, content } = options.input;
        const task = this.service.getTask(task_id);
        if (!task) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Task ID "${task_id}" not found.`),
            ]);
        }
        if (!content?.trim()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Comment content is required.'),
            ]);
        }
        await this.service.addComment(task_id, content.trim());
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Comment added to "${task.title}".`),
        ]);
    }
}

// ---------------------------------------------------------------------------
// todoist_list_comments
// ---------------------------------------------------------------------------

export interface IListCommentsInput {
    /** The task ID (uid) */
    task_id: string;
}

export class ListCommentsTool implements vscode.LanguageModelTool<IListCommentsInput> {
    constructor(private readonly service: TodoistService) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IListCommentsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.service.isInitialised()) { return notInitialisedResult(); }
        const { task_id } = options.input;
        const task = this.service.getTask(task_id);
        if (!task) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Task ID "${task_id}" not found.`),
            ]);
        }
        const comments = await this.service.getComments(task_id);
        if (comments.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`No comments on "${task.title}".`),
            ]);
        }
        const lines = comments.map(c =>
            `[${c.posted_at.slice(0, 10)}] ${c.content}`
        );
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `${comments.length} comment(s) on "${task.title}":\n${lines.join('\n')}`
            ),
        ]);
    }
}

// ---------------------------------------------------------------------------
// todoist_list_labels
// ---------------------------------------------------------------------------

export class ListLabelsTool implements vscode.LanguageModelTool<Record<string, never>> {
    constructor(private readonly service: TodoistService) {}

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.service.isInitialised()) { return notInitialisedResult(); }
        const labels = await this.service.getAllTags();
        if (labels.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No labels found.'),
            ]);
        }
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Available labels: ${labels.join(', ')}`),
        ]);
    }
}

// ---------------------------------------------------------------------------
// todoist_create_label
// ---------------------------------------------------------------------------

export interface ICreateLabelInput {
    /** Label name */
    name: string;
}

export class CreateLabelTool implements vscode.LanguageModelTool<ICreateLabelInput> {
    constructor(private readonly service: TodoistService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ICreateLabelInput>,
        _token: vscode.CancellationToken
    ) {
        return {
            invocationMessage: `Creating label "${options.input.name}"…`,
            confirmationMessages: {
                title: 'Create label',
                message: new vscode.MarkdownString(`Create label **"${options.input.name}"**?`),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ICreateLabelInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.service.isInitialised()) { return notInitialisedResult(); }
        const { name } = options.input;
        if (!name?.trim()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Label name is required.'),
            ]);
        }
        const created = await this.service.createLabel(name.trim());
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Label "${created}" created.`),
        ]);
    }
}

// ---------------------------------------------------------------------------
// todoist_update_task_labels
// ---------------------------------------------------------------------------

export interface IUpdateTaskLabelsInput {
    /** The task ID (uid) to update labels on */
    task_id: string;
    /** Label names to act on */
    labels: string[];
    /**
     * How to apply the labels:
     * - replace (default) — set labels to exactly this list
     * - add               — add to existing labels
     * - remove            — remove from existing labels
     */
    mode?: 'replace' | 'add' | 'remove';
}

export class UpdateTaskLabelsTool implements vscode.LanguageModelTool<IUpdateTaskLabelsInput> {
    constructor(private readonly service: TodoistService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IUpdateTaskLabelsInput>,
        _token: vscode.CancellationToken
    ) {
        const { task_id, labels, mode = 'replace' } = options.input;
        const task = this.service.getTask(task_id);
        const title = task?.title ?? task_id;
        const labelList = labels.join(', ');
        const action = mode === 'add' ? `Add [${labelList}] to` : mode === 'remove' ? `Remove [${labelList}] from` : `Set labels on`;
        return {
            invocationMessage: `${action} "${title}"…`,
            confirmationMessages: {
                title: 'Update labels',
                message: new vscode.MarkdownString(
                    `${action} **"${title}"** → \`${labelList}\`?`
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IUpdateTaskLabelsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.service.isInitialised()) { return notInitialisedResult(); }
        const { task_id, labels, mode = 'replace' } = options.input;
        if (!task_id) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('task_id is required.'),
            ]);
        }
        const task = this.service.getTask(task_id);
        if (!task) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Task "${task_id}" not found.`),
            ]);
        }
        await this.service.updateTaskLabels(task_id, labels ?? [], mode);
        const updated = this.service.getTask(task_id);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Labels on "${task.title}" updated. Current labels: ${updated?.tags.join(', ') || '(none)'}`
            ),
        ]);
    }
}

// ---------------------------------------------------------------------------
// todoist_delete_label
// ---------------------------------------------------------------------------

export interface IDeleteLabelInput {
    /** Label name to delete */
    name: string;
}

export class DeleteLabelTool implements vscode.LanguageModelTool<IDeleteLabelInput> {
    constructor(private readonly service: TodoistService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IDeleteLabelInput>,
        _token: vscode.CancellationToken
    ) {
        return {
            invocationMessage: `Deleting label "${options.input.name}"…`,
            confirmationMessages: {
                title: 'Delete label',
                message: new vscode.MarkdownString(
                    `Delete label **"${options.input.name}"**? This removes it from all tasks.`
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IDeleteLabelInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.service.isInitialised()) { return notInitialisedResult(); }
        const { name } = options.input;
        if (!name?.trim()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Label name is required.'),
            ]);
        }
        try {
            await this.service.deleteLabel(name.trim());
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Label "${name}" deleted.`),
            ]);
        } catch (e: unknown) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Failed: ${(e as Error).message}`),
            ]);
        }
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
        vscode.lm.registerTool('todoist_list_projects',  new ListProjectsTool(service)),
        vscode.lm.registerTool('todoist_create_project', new CreateProjectTool(service)),
        vscode.lm.registerTool('todoist_delete_project', new DeleteProjectTool(service)),
        vscode.lm.registerTool('todoist_rename_project', new RenameProjectTool(service)),
        vscode.lm.registerTool('todoist_list_tasks',     new ListTasksTool(service)),
        vscode.lm.registerTool('todoist_create_task',    new CreateTaskTool(service)),
        vscode.lm.registerTool('todoist_update_task',    new UpdateTaskTool(service)),
        vscode.lm.registerTool('todoist_move_task',      new MoveTaskTool(service)),
        vscode.lm.registerTool('todoist_complete_task',  new CompleteTaskTool(service)),
        vscode.lm.registerTool('todoist_reopen_task',    new ReopenTaskTool(service)),
        vscode.lm.registerTool('todoist_delete_task',    new DeleteTaskTool(service)),
        vscode.lm.registerTool('todoist_add_comment',    new AddCommentTool(service)),
        vscode.lm.registerTool('todoist_list_comments',  new ListCommentsTool(service)),
        vscode.lm.registerTool('todoist_list_labels',         new ListLabelsTool(service)),
        vscode.lm.registerTool('todoist_create_label',        new CreateLabelTool(service)),
        vscode.lm.registerTool('todoist_update_task_labels',  new UpdateTaskLabelsTool(service)),
        vscode.lm.registerTool('todoist_delete_label',        new DeleteLabelTool(service)),
    );
}
