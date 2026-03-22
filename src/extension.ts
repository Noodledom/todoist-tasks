import * as vscode from 'vscode';
import { TodoistService } from './todoist/todoistService';
import { TaskTreeProvider } from './views/taskTreeProvider';
import { CalendarPanel } from './views/calendarPanel';
import { Task, TaskFilter, TaskSort } from './todoist/types';
import * as settings from './config/settings';
import { registerTodoistTools } from './tools/todoistTools';

/** Extract a task uid from either a plain string or a TaskTreeItem passed by VS Code menus/inline buttons. */
function resolveUid(arg: unknown): string | undefined {
    if (typeof arg === 'string') { return arg; }
    if (arg && typeof arg === 'object') {
        // TaskTreeItem passes its .task property; uid lives on task.uid
        const item = arg as { task?: { uid?: string }; uid?: string };
        return item.task?.uid ?? item.uid;
    }
    return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
    const service = new TodoistService(settings.getPollInterval());
    const treeProvider = new TaskTreeProvider(service);
    const calPanel = new CalendarPanel(service, context.extensionUri);

    context.subscriptions.push(service, treeProvider, calPanel);

    // -------------------------------------------------------------------------
    // Language model tools (Copilot agent mode)
    // -------------------------------------------------------------------------
    registerTodoistTools(context, service);

    // -------------------------------------------------------------------------
    // Tree view registration
    // -------------------------------------------------------------------------
    const treeView = vscode.window.createTreeView('todoistTasksTree', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
        dragAndDropController: treeProvider,
        canSelectMany: true,
    });
    context.subscriptions.push(treeView);

    // -------------------------------------------------------------------------
    // Initial load
    // -------------------------------------------------------------------------
    void initOrPrompt(service, context).catch(err =>
        vscode.window.showErrorMessage(`Todoist: Initialisation failed — ${(err as Error).message}`)
    );

    // -------------------------------------------------------------------------
    // Commands
    // -------------------------------------------------------------------------

    context.subscriptions.push(
        vscode.commands.registerCommand('todoistTasks.setApiToken', async () => {
            const token = await vscode.window.showInputBox({
                prompt: 'Enter your Todoist API token',
                placeHolder: 'Paste token here…',
                password: true,
                ignoreFocusOut: true,
            });
            if (!token) { return; }
            await context.secrets.store('todoist.apiToken', token);
            service.setToken(token);
            vscode.window.showInformationMessage('Todoist: API token saved.');
        }),

        vscode.commands.registerCommand('todoistTasks.refresh', () => {
            service.reload();
        }),

        vscode.commands.registerCommand('todoistTasks.openCalendar', () => {
            calPanel.open();
        }),

        vscode.commands.registerCommand('todoistTasks.clearFilters', () => {
            treeProvider.clearFilters();
        }),

        // ---- Search Tasks ----
        vscode.commands.registerCommand('todoistTasks.searchTasks', async () => {
            const current = treeProvider.getSearchQuery();
            const query = await vscode.window.showInputBox({
                prompt: 'Search tasks by name',
                placeHolder: 'Type to filter tasks…',
                value: current,
                ignoreFocusOut: false,
            });
            if (query === undefined) { return; } // cancelled
            treeProvider.setSearchQuery(query);
            if (query.trim()) {
                treeProvider.setFilter({ showCompleted: false });
            }
        }),

        // ---- Create Task ----
        vscode.commands.registerCommand('todoistTasks.createTask', async (argOrItem?: string | { collection?: { id: string }; task?: { uid: string } }) => {
            const collections = service.getCollections();
            if (collections.length === 0) {
                vscode.window.showWarningMessage('No Todoist projects found. Make sure your API token is set.');
                return;
            }

            // If invoked from a collection row, pre-select that collection
            let preselectedCollectionId: string | undefined;
            let parentUid: string | undefined;
            if (argOrItem && typeof argOrItem === 'object') {
                preselectedCollectionId = argOrItem.collection?.id;
                parentUid = argOrItem.task?.uid; // subtask case (from task row)
            } else if (typeof argOrItem === 'string') {
                parentUid = argOrItem;
            }

            let collectionId = preselectedCollectionId;
            if (!collectionId) {
                const collectionPick = await vscode.window.showQuickPick(
                    collections.map(c => ({ label: c.name, id: c.id })),
                    { placeHolder: 'Select a project', ignoreFocusOut: true }
                );
                if (!collectionPick) { return; }
                collectionId = collectionPick.id;
            }

            // Ask for the title immediately before opening the full form
            const title = await vscode.window.showInputBox({
                title: 'New Task',
                prompt: 'Task title',
                placeHolder: 'Enter task title…',
                ignoreFocusOut: true,
                validateInput: v => v.trim().length === 0 ? 'Title is required' : undefined,
            });
            if (!title?.trim()) { return; }

            const draft: Task = {
                uid: '',
                collectionId: collectionId,
                title: title.trim(),
                priority: 'none',
                tags: [],
                completed: false,
                parentUid,
            };

            const result = await showTaskForm(draft, 'create', service);
            if (!result) { return; }

            await service.createTask({
                collectionId: result.collectionId,
                title: result.title,
                description: result.description,
                dueDate: result.dueDate,
                priority: result.priority,
                tags: result.tags,
                parentUid: result.parentUid,
            });
        }),

        // ---- Create Project ----
        vscode.commands.registerCommand('todoistTasks.createProject', async () => {
            const name = await vscode.window.showInputBox({
                title: 'New Project',
                prompt: 'Enter a name for the new project',
                placeHolder: 'e.g. Work, Personal…',
                ignoreFocusOut: true,
            });
            if (!name?.trim()) { return; }
            await service.createProject(name.trim());
        }),

        // ---- Delete Project ----
        vscode.commands.registerCommand('todoistTasks.deleteProject', async (item?: { collection?: { id: string; name: string } }) => {
            const collection = item?.collection;
            if (!collection) { return; }
            const answer = await vscode.window.showWarningMessage(
                `Delete project "${collection.name}" and all its tasks?`,
                { modal: true }, 'Delete'
            );
            if (answer === 'Delete') { await service.deleteProject(collection.id); }
        }),

        // ---- Rename Project ----
        vscode.commands.registerCommand('todoistTasks.renameProject', async (item?: { collection?: { id: string; name: string } }) => {
            const collection = item?.collection;
            if (!collection) { return; }
            const name = await vscode.window.showInputBox({
                title: 'Rename Project',
                value: collection.name,
                prompt: 'Enter a new name for the project',
                ignoreFocusOut: true,
                validateInput: v => v.trim() ? undefined : 'Name cannot be empty',
            });
            if (!name?.trim() || name.trim() === collection.name) { return; }
            await service.renameProject(collection.id, name.trim());
        }),

        // ---- Edit Task ----
        vscode.commands.registerCommand('todoistTasks.editTask', async (uidOrItem?: string | { task?: { uid: string } }) => {
            const uid = resolveUid(uidOrItem);
            if (!uid) { return; }
            const task = service.getTask(uid);
            if (!task) { return; }

            const updated = await showTaskForm(task, 'edit', service);
            if (updated) { await service.updateTask(updated); }
        }),

        // ---- Complete Task ----
        vscode.commands.registerCommand('todoistTasks.completeTask', async (uidOrItem?: string | { task?: { uid: string } }) => {
            const uid = resolveUid(uidOrItem);
            if (!uid) { return; }
            const subtasks = service.getSubtasks(uid);
            let completeSubtasks = false;
            if (subtasks.length > 0) {
                const answer = await vscode.window.showQuickPick(['Yes', 'No'], {
                    placeHolder: `Also complete ${subtasks.length} subtask(s)?`,
                });
                completeSubtasks = answer === 'Yes';
            }
            await service.completeTask(uid, completeSubtasks);
        }),

        // ---- Reopen Task ----
        vscode.commands.registerCommand('todoistTasks.reopenTask', async (uidOrItem?: string | { task?: { uid: string } }) => {
            const uid = resolveUid(uidOrItem);
            if (!uid) { return; }
            await service.reopenTask(uid);
        }),

        // ---- Toggle Complete (used by inline button and Ctrl+Enter keybinding) ----
        vscode.commands.registerCommand('todoistTasks.toggleComplete', async (
            uidOrItem?: string | { task?: { uid: string } },
            allItems?: Array<string | { task?: { uid: string } }>,
        ) => {
            // Collect all UIDs — from multi-selection or single item
            const items = allItems && allItems.length > 0 ? allItems : (uidOrItem ? [uidOrItem] : []);
            const uids = items.map(resolveUid).filter((u): u is string => !!u);
            if (uids.length === 0) { return; }

            for (const uid of uids) {
                const task = service.getTask(uid);
                if (!task) { continue; }
                if (task.completed) {
                    await service.reopenTask(uid);
                } else {
                    const subtasks = service.getSubtasks(uid);
                    let completeSubtasks = false;
                    if (subtasks.length > 0 && uids.length === 1) {
                        const answer = await vscode.window.showQuickPick(['Yes', 'No'], {
                            placeHolder: `Also complete ${subtasks.length} subtask(s)?`,
                        });
                        if (answer === undefined) { return; }  // user pressed Escape — abort
                        completeSubtasks = answer === 'Yes';
                    }
                    await service.completeTask(uid, completeSubtasks);
                }
            }
        }),

        // ---- Add Comment ----
        vscode.commands.registerCommand('todoistTasks.addComment', async (uidOrItem?: string | { task?: { uid: string } }) => {
            const uid = resolveUid(uidOrItem);
            if (!uid) { return; }
            const task = service.getTask(uid);
            if (!task) { return; }

            // Fetch and display existing comments as the prompt context
            let promptText = `Add a comment to "${task.title}"`;
            try {
                const comments = await service.getComments(uid);
                if (comments.length > 0) {
                    const lines = comments.map(c => `${c.posted_at.slice(0, 10)}: ${c.content}`);
                    promptText = lines.join(' | ') + ' — add new:';
                }
            } catch { /* network unavailable — still allow adding */ }

            const content = await vscode.window.showInputBox({
                title: `Comment — ${task.title}`,
                prompt: promptText,
                placeHolder: 'Type your comment…',
                ignoreFocusOut: true,
            });
            if (!content?.trim()) { return; }
            await service.addComment(uid, content.trim());
            vscode.window.showInformationMessage('Comment added.');
        }),

        // ---- Delete Task ----
        vscode.commands.registerCommand('todoistTasks.deleteTask', async (
            uidOrItem?: string | { task?: { uid: string } },
            allItems?: Array<string | { task?: { uid: string } }>,
        ) => {
            // Collect all UIDs — from multi-selection or single item
            const items = allItems && allItems.length > 0 ? allItems : (uidOrItem ? [uidOrItem] : []);
            const uids = items.map(resolveUid).filter((u): u is string => !!u);
            if (uids.length === 0) { return; }

            const label = uids.length === 1
                ? `"${service.getTask(uids[0])?.title ?? uids[0]}"`
                : `${uids.length} tasks`;
            const answer = await vscode.window.showWarningMessage(
                `Delete ${label}?`, { modal: true }, 'Delete'
            );
            if (answer !== 'Delete') { return; }

            await Promise.all(uids.map(uid => service.deleteTask(uid)));
        }),

        // ---- Sort ----
        vscode.commands.registerCommand('todoistTasks.sortTasks', async () => {
            const fieldPick = await vscode.window.showQuickPick(
                [
                    { label: 'Due Date', by: 'dueDate' as const },
                    { label: 'Priority', by: 'priority' as const },
                    { label: 'Title',    by: 'title' as const },
                    { label: 'Created',  by: 'created' as const },
                ],
                { placeHolder: 'Sort by…' }
            );
            if (!fieldPick) { return; }

            const orderPick = await vscode.window.showQuickPick(['Ascending', 'Descending'], {
                placeHolder: 'Order',
            });
            if (!orderPick) { return; }

            const sort: TaskSort = {
                by: fieldPick.by,
                order: orderPick === 'Descending' ? 'desc' : 'asc',
            };
            treeProvider.setSort(sort);
            await settings.setTaskSort(sort);
        }),

        // ---- Filter ----
        vscode.commands.registerCommand('todoistTasks.filterTasks', async () => {
            const tags = await service.getAllTags();
            const options: vscode.QuickPickItem[] = [
                { label: '$(pass) Show Completed', description: 'showCompleted' },
                { label: '$(circle-filled) High Priority',   description: 'priority:high' },
                { label: '$(circle-filled) Medium Priority', description: 'priority:medium' },
                { label: '$(circle-filled) Low Priority',    description: 'priority:low' },
                ...tags.map(tag => ({ label: `$(tag) ${tag}`, description: `tag:${tag}` })),
            ];

            const pick = await vscode.window.showQuickPick(options, {
                placeHolder: 'Apply filter…',
            });
            if (!pick || !pick.description) { return; }

            const val = pick.description;
            if (val === 'showCompleted') {
                treeProvider.setFilter({ showCompleted: true });
            } else if (val.startsWith('priority:')) {
                treeProvider.setFilter({ priority: val.split(':')[1] as TaskFilter['priority'] });
            } else if (val.startsWith('tag:')) {
                treeProvider.setFilter({ tags: [val.split(':')[1]] });
            }
        }),

        // ---- Filter by Tag (multi-select) ----
        vscode.commands.registerCommand('todoistTasks.filterByTag', async () => {
            const tags = await service.getAllTags();
            const CREATE = '__create__';
            const RENAME = '__rename__';
            const DELETE = '__delete__';
            type TagPickItem = vscode.QuickPickItem & { tag: string };
            const items: TagPickItem[] = [
                {
                    label: '$(add) Create new label…',
                    tag: CREATE,
                    alwaysShow: true,
                } as TagPickItem,
                ...(tags.length > 0 ? [
                    { label: '$(edit) Rename label…', tag: RENAME, alwaysShow: true } as TagPickItem,
                    { label: '$(trash) Delete label…', tag: DELETE, alwaysShow: true } as TagPickItem,
                ] : []),
                ...tags.map(tag => ({ label: `$(tag) ${tag}`, tag })),
            ];

            const picks = await vscode.window.showQuickPick(items, {
                placeHolder: tags.length === 0
                    ? 'No labels yet — create one to get started'
                    : 'Select labels to filter by, or manage labels',
                canPickMany: true,
                ignoreFocusOut: true,
            });
            if (!picks) { return; }

            const wantsCreate = picks.some(p => p.tag === CREATE);
            const wantsRename = picks.some(p => p.tag === RENAME);
            const wantsDelete = picks.some(p => p.tag === DELETE);
            const selected = picks.filter(p => p.tag !== CREATE && p.tag !== RENAME && p.tag !== DELETE).map(p => p.tag);

            if (wantsCreate) {
                const name = await vscode.window.showInputBox({
                    title: 'Create label',
                    prompt: 'Enter a name for the new label',
                    ignoreFocusOut: true,
                });
                if (name?.trim()) {
                    try {
                        await service.createLabel(name.trim());
                        vscode.window.showInformationMessage(`Label "${name.trim()}" created.`);
                    } catch (e: unknown) {
                        vscode.window.showErrorMessage(`Failed to create label: ${(e as Error).message}`);
                    }
                }
            }

            if (wantsRename) {
                const labelPick = await vscode.window.showQuickPick(
                    tags.map(t => ({ label: `$(tag) ${t}`, tag: t })),
                    { placeHolder: 'Select label to rename', ignoreFocusOut: true }
                );
                if (labelPick) {
                    const newName = await vscode.window.showInputBox({
                        title: `Rename "${labelPick.tag}"`,
                        value: labelPick.tag,
                        prompt: 'Enter the new label name',
                        ignoreFocusOut: true,
                    });
                    if (newName?.trim() && newName.trim() !== labelPick.tag) {
                        try {
                            await service.renameLabel(labelPick.tag, newName.trim());
                            vscode.window.showInformationMessage(`Label renamed to "${newName.trim()}".`);
                        } catch (e: unknown) {
                            vscode.window.showErrorMessage(`Failed to rename label: ${(e as Error).message}`);
                        }
                    }
                }
            }

            if (wantsDelete) {
                const labelPick = await vscode.window.showQuickPick(
                    tags.map(t => ({ label: `$(tag) ${t}`, tag: t })),
                    { placeHolder: 'Select label to delete', ignoreFocusOut: true }
                );
                if (labelPick) {
                    const confirm = await vscode.window.showWarningMessage(
                        `Delete label "${labelPick.tag}"? This removes it from all tasks.`,
                        { modal: true }, 'Delete'
                    );
                    if (confirm === 'Delete') {
                        try {
                            await service.deleteLabel(labelPick.tag);
                            vscode.window.showInformationMessage(`Label "${labelPick.tag}" deleted.`);
                        } catch (e: unknown) {
                            vscode.window.showErrorMessage(`Failed to delete label: ${(e as Error).message}`);
                        }
                    }
                }
            }

            if (selected.length === 0) {
                treeProvider.clearFilters();
            } else {
                treeProvider.setFilter({ tags: selected });
            }
        }),

        // ---- Manage Labels on a task (inline, no full form) ----
        vscode.commands.registerCommand('todoistTasks.manageLabels', async (uidOrItem?: string | { task?: { uid: string } }) => {
            const uid = resolveUid(uidOrItem);
            if (!uid) { return; }
            const task = service.getTask(uid);
            if (!task) { return; }

            const allTags = await service.getAllTags();
            type TagItem = vscode.QuickPickItem & { value: string };
            const tagItems: TagItem[] = allTags.map(t => ({
                label: `$(tag) ${t}`,
                value: t,
                picked: task.tags.includes(t),
            }));

            const picks = await vscode.window.showQuickPick(tagItems, {
                title: `Labels — ${task.title}`,
                placeHolder: allTags.length === 0
                    ? 'No labels yet — create one with the $(tag) toolbar button'
                    : 'Space to toggle labels, Enter to confirm',
                canPickMany: true,
                ignoreFocusOut: true,
            });
            if (picks === undefined) { return; }
            await service.updateTaskLabels(uid, picks.map(p => p.value), 'replace');
        }),

        // ---- Delete Label ----
        vscode.commands.registerCommand('todoistTasks.deleteLabel', async () => {
            const tags = await service.getAllTags();
            if (tags.length === 0) {
                vscode.window.showInformationMessage('No labels to delete.');
                return;
            }
            const pick = await vscode.window.showQuickPick(
                tags.map(t => ({ label: `$(tag) ${t}`, tag: t })),
                { placeHolder: 'Select a label to delete', ignoreFocusOut: true }
            );
            if (!pick) { return; }
            const confirm = await vscode.window.showWarningMessage(
                `Delete label "${pick.tag}"? This removes it from all tasks.`,
                { modal: true }, 'Delete'
            );
            if (confirm !== 'Delete') { return; }
            try {
                await service.deleteLabel(pick.tag);
                vscode.window.showInformationMessage(`Label "${pick.tag}" deleted.`);
            } catch (e: unknown) {
                vscode.window.showErrorMessage(`Failed: ${(e as Error).message}`);
            }
        }),
    );
}

export function deactivate(): void {}

// ---------------------------------------------------------------------------
// Init helper
// ---------------------------------------------------------------------------

async function initOrPrompt(service: TodoistService, context: vscode.ExtensionContext): Promise<void> {
    const token = await context.secrets.get('todoist.apiToken');
    if (!token) {
        const choice = await vscode.window.showWarningMessage(
            'Todoist: API token not set.',
            'Set Token'
        );
        if (choice === 'Set Token') {
            await vscode.commands.executeCommand('todoistTasks.setApiToken');
        }
        return;
    }
    service.init(token);
}

// ---------------------------------------------------------------------------
// Multi-step QuickPick form (Option B)
// ---------------------------------------------------------------------------

type TaskDraft = Pick<Task, 'uid' | 'collectionId' | 'title' | 'description' | 'dueDate' | 'dueString' | 'isRecurring' | 'priority' | 'tags' | 'completed' | 'parentUid'>;

async function showTaskForm(task: Task, mode: 'create' | 'edit', service: TodoistService): Promise<Task | undefined> {
    // Mutable working copy
    const draft: TaskDraft = {
        uid: task.uid,
        collectionId: task.collectionId,
        title: task.title,
        description: task.description,
        dueDate: task.dueDate,
        dueString: task.dueString,
        isRecurring: task.isRecurring,
        priority: task.priority,
        tags: [...task.tags],
        completed: task.completed,
        parentUid: task.parentUid,
    };

    // Loop — keep showing the summary list until Save or Cancel
    while (true) {
        const saveLabel = mode === 'create' ? '$(add) Create task' : '$(check) Save changes';
        const canSave = draft.title.trim().length > 0;

        const items: (vscode.QuickPickItem & { action: string })[] = [
            {
                label: `$(pencil) Title`,
                description: draft.title || '(required)',
                detail: canSave ? undefined : '⚠ Title is required',
                action: 'title',
            },
            {
                label: `$(calendar) Due date`,
                description: dueDateDisplay(draft),
                action: 'dueDate',
            },
            {
                label: `$(circle-filled) Priority`,
                description: draft.priority,
                action: 'priority',
            },
            {
                label: `$(note) Description`,
                description: draft.description || '(none)',
                action: 'description',
            },
            {
                label: `$(tag) Labels`,
                description: draft.tags.length > 0 ? draft.tags.join(', ') : '(none)',
                action: 'tags',
            },
            { label: '', description: '', action: '__sep__', kind: vscode.QuickPickItemKind.Separator } as unknown as vscode.QuickPickItem & { action: string },
            {
                label: canSave ? saveLabel : `$(circle-slash) ${mode === 'create' ? 'Create task' : 'Save changes'} (title required)`,
                action: 'save',
            },
            {
                label: '$(x) Cancel',
                action: 'cancel',
            },
        ];

        const pick = await vscode.window.showQuickPick(items, {
            title: mode === 'create' ? 'New Task' : `Edit: ${task.title}`,
            placeHolder: 'Select a field to edit, then Save',
            ignoreFocusOut: true,
        });

        if (!pick || pick.action === 'cancel') { return undefined; }

        if (pick.action === 'save') {
            if (!canSave) {
                vscode.window.showWarningMessage('Please enter a title before saving.');
                continue;
            }
            return { ...task, ...draft };
        }

        // ---- Edit individual fields ----
        if (pick.action === 'title') {
            const val = await vscode.window.showInputBox({
                title: 'Task title',
                prompt: 'Enter task title',
                value: draft.title,
                ignoreFocusOut: true,
            });
            if (val !== undefined) { draft.title = val; }
        }

        else if (pick.action === 'dueDate') {
            const result = await pickDueString(draft.dueString ?? draft.dueDate ?? '', service);
            if (result !== null) {          // null = cancelled
                draft.dueString = result || undefined;
                draft.dueDate   = undefined;
            }
        }

        else if (pick.action === 'priority') {
            const priorities: (vscode.QuickPickItem & { value: Task['priority'] })[] = [
                { label: '$(circle-outline) None',   value: 'none',   description: draft.priority === 'none'   ? '← current' : undefined },
                { label: '$(circle-filled) Low',     value: 'low',    description: draft.priority === 'low'    ? '← current' : undefined },
                { label: '$(circle-filled) Medium',  value: 'medium', description: draft.priority === 'medium' ? '← current' : undefined },
                { label: '$(circle-filled) High',    value: 'high',   description: draft.priority === 'high'   ? '← current' : undefined },
            ];
            const priPick = await vscode.window.showQuickPick(priorities, {
                title: 'Priority',
                ignoreFocusOut: true,
            });
            if (priPick !== undefined) { draft.priority = priPick.value; }
        }

        else if (pick.action === 'description') {
            const val = await vscode.window.showInputBox({
                title: 'Description',
                prompt: 'Task description (optional)',
                value: draft.description ?? '',
                ignoreFocusOut: true,
            });
            if (val !== undefined) { draft.description = val || undefined; }
        }

        else if (pick.action === 'tags') {
            const allTags = await service.getAllTags();

            type TagItem = vscode.QuickPickItem & { value: string };
            const tagItems: TagItem[] = allTags.map(t => ({
                label: `$(tag) ${t}`,
                value: t,
                picked: draft.tags.includes(t),
            }));

            const picks = await vscode.window.showQuickPick(tagItems, {
                title: 'Labels',
                placeHolder: allTags.length === 0
                    ? 'No labels yet — create one with the $(tag) button in the toolbar'
                    : 'Select labels (Space to toggle)',
                canPickMany: true,
                ignoreFocusOut: true,
            });
            if (picks !== undefined) {
                draft.tags = picks.map(p => p.value);
            }
        }
    }
}


/** Returns a YYYY-MM-DD string for today + offsetDays */
function todayPlus(offsetDays: number): string {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
}

/** Human-readable due date summary shown in the task form field row. */
function dueDateDisplay(draft: { dueString?: string; dueDate?: string; isRecurring?: boolean }): string {
    if (draft.dueString) {
        return draft.isRecurring ? `↻ ${draft.dueString}` : draft.dueString;
    }
    if (draft.dueDate) {
        return draft.dueDate.slice(0, 10);
    }
    return '(none)';
}

// ---------------------------------------------------------------------------
// Due-date picker with live autocomplete + Todoist validation
// ---------------------------------------------------------------------------

const DUE_SUGGESTIONS: Array<{ label: string; value: string; isRecurring?: boolean }> = [
    // ── One-time ──────────────────────────────────────────────────────────
    { label: '$(remove) No date',           value: '' },
    { label: '$(calendar) Today',           value: 'today' },
    { label: '$(calendar) Tomorrow',        value: 'tomorrow' },
    { label: '$(calendar) Next week',       value: 'next week' },
    { label: '$(calendar) Next Monday',     value: 'next Monday' },
    { label: '$(calendar) Next weekend',    value: 'next weekend' },
    // ── Recurring ─────────────────────────────────────────────────────────
    { label: '$(sync) Every day',           value: 'every day',           isRecurring: true },
    { label: '$(sync) Every weekday',       value: 'every weekday',       isRecurring: true },
    { label: '$(sync) Every Monday',        value: 'every Monday',        isRecurring: true },
    { label: '$(sync) Every Tuesday',       value: 'every Tuesday',       isRecurring: true },
    { label: '$(sync) Every Wednesday',     value: 'every Wednesday',     isRecurring: true },
    { label: '$(sync) Every Thursday',      value: 'every Thursday',      isRecurring: true },
    { label: '$(sync) Every Friday',        value: 'every Friday',        isRecurring: true },
    { label: '$(sync) Every week',          value: 'every week',          isRecurring: true },
    { label: '$(sync) Every 2 weeks',       value: 'every 2 weeks',       isRecurring: true },
    { label: '$(sync) Every month',         value: 'every month',         isRecurring: true },
    { label: '$(sync) Every year',          value: 'every year',          isRecurring: true },
    { label: '$(sync) Every first Monday of the month', value: 'every first Monday of the month', isRecurring: true },
    { label: '$(sync) Every last day of the month',     value: 'every last day of the month',     isRecurring: true },
];

/**
 * Show a live QuickPick for due date / recurrence.
 * - Filters suggestions by what the user types.
 * - After a 600 ms pause, validates the typed string against Todoist and shows
 *   the resolved date as detail text.
 * Returns the chosen due string (empty string = clear), or null if cancelled.
 */
async function pickDueString(current: string, service: TodoistService): Promise<string | null> {
    return new Promise(resolve => {
        const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { value: string }>();
        qp.title = 'Due date / recurrence';
        qp.placeholder = current
            ? `Current: ${current}  —  type to change or pick below`
            : 'Type or pick a due date / recurrence…';
        qp.value = current;
        qp.ignoreFocusOut = true;
        qp.matchOnDescription = true;

        let debounceTimer: ReturnType<typeof setTimeout> | undefined;
        let previewItem: (vscode.QuickPickItem & { value: string }) | undefined;

        function buildItems(typed: string): Array<vscode.QuickPickItem & { value: string }> {
            const q = typed.toLowerCase();
            const filtered = DUE_SUGGESTIONS.filter(s =>
                !q || s.value.toLowerCase().includes(q) || s.label.toLowerCase().includes(q)
            );

            const items: Array<vscode.QuickPickItem & { value: string }> = [];

            // If user typed something not exactly matching a suggestion, show it as a custom entry at top
            const exactMatch = DUE_SUGGESTIONS.some(s => s.value.toLowerCase() === q);
            if (typed && !exactMatch) {
                items.push({
                    label: `$(edit) Use: "${typed}"`,
                    description: 'validating…',
                    value: typed,
                    alwaysShow: true,
                });
            }

            items.push(...filtered.map(s => ({
                label: s.label,
                value: s.value,
                description: s.isRecurring ? 'repeating' : undefined,
            })));

            return items;
        }

        qp.items = buildItems(current);

        qp.onDidChangeValue(typed => {
            qp.items = buildItems(typed);

            // Debounce validation
            if (debounceTimer) { clearTimeout(debounceTimer); }
            if (!typed) { return; }

            debounceTimer = setTimeout(async () => {
                // Check if it's a suggestion — no need to validate
                const isSuggestion = DUE_SUGGESTIONS.some(s => s.value.toLowerCase() === typed.toLowerCase());
                if (isSuggestion) { return; }

                // Find the custom "Use: ..." item and update its description
                const parsed = await service.parseDueString(typed);
                const items = buildItems(typed);
                const customIdx = items.findIndex(i => i.value === typed && i.label.startsWith('$(edit)'));
                if (customIdx !== -1) {
                    if (parsed) {
                        const dt = parsed.datetime ?? parsed.date;
                        const friendly = new Date(dt).toLocaleString(undefined, {
                            weekday: 'short', month: 'short', day: 'numeric',
                            ...(parsed.datetime ? { hour: '2-digit', minute: '2-digit' } : {}),
                        });
                        items[customIdx].description = parsed.isRecurring
                            ? `↻ repeating — next: ${friendly}`
                            : `✓ ${friendly}`;
                    } else {
                        items[customIdx].description = '⚠ not recognised by Todoist';
                    }
                }
                qp.items = items;
                previewItem = items[customIdx];
            }, 600);
        });

        qp.onDidAccept(() => {
            const sel = qp.selectedItems[0];
            qp.dispose();
            if (sel === undefined) {
                resolve(null);   // cancelled via Enter with nothing selected
            } else {
                resolve(sel.value);
            }
        });

        qp.onDidHide(() => {
            if (debounceTimer) { clearTimeout(debounceTimer); }
            qp.dispose();
            resolve(null);
        });

        qp.show();
    });
}

