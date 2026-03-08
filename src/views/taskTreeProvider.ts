import * as vscode from 'vscode';
import { TodoistService } from '../todoist/todoistService';
import { Task, Collection, TaskFilter, TaskSort } from '../todoist/types';

// ---------------------------------------------------------------------------
// Tree item types
// ---------------------------------------------------------------------------

type NodeKind = 'collection' | 'task' | 'subtask' | 'completed-group';

class TaskTreeItem extends vscode.TreeItem {
    constructor(
        public readonly kind: NodeKind,
        label: string,
        collapsible: vscode.TreeItemCollapsibleState,
        public readonly task?: Task,
        public readonly collection?: Collection,
    ) {
        super(label, collapsible);
        this._applyStyle();
    }

    private _applyStyle(): void {
        switch (this.kind) {
            case 'collection':
                this.iconPath = new vscode.ThemeIcon('list-unordered');
                this.contextValue = 'collection';
                break;

            case 'completed-group':
                this.iconPath = new vscode.ThemeIcon('pass-filled');
                this.contextValue = 'completedGroup';
                break;

            case 'task':
            case 'subtask': {
                const t = this.task!;
                this.iconPath = t.completed
                    ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'))
                    : priorityIcon(t.priority);
                this.description = t.dueDate
                    ? formatDate(t.dueDate)
                    : undefined;
                this.tooltip = buildTooltip(t);
                // contextValue drives which inline buttons / menu items appear
                this.contextValue = t.completed ? 'completedTask' : 'task';
                this.command = {
                    command: 'todoistTasks.editTask',
                    title: 'Edit Task',
                    arguments: [t.uid],
                };
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class TaskTreeProvider
    implements vscode.TreeDataProvider<TaskTreeItem>, vscode.TreeDragAndDropController<TaskTreeItem>, vscode.Disposable {

    // ── Drag-and-drop MIME types ──────────────────────────────────────────────
    readonly dragMimeTypes = ['application/vnd.code.tree.todoistTasksTree'];
    readonly dropMimeTypes = ['application/vnd.code.tree.todoistTasksTree'];

    private _onDidChangeTreeData = new vscode.EventEmitter<TaskTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private filter: TaskFilter = { showCompleted: false };
    private sort: TaskSort = { by: 'dueDate', order: 'asc' };
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly service: TodoistService) {
        this.disposables.push(
            service.onDidChange(() => this.refresh())
        );
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setFilter(filter: Partial<TaskFilter>): void {
        this.filter = { ...this.filter, ...filter };
        this.refresh();
    }

    clearFilters(): void {
        this.filter = { showCompleted: false };
        this.refresh();
    }

    setSort(sort: TaskSort): void {
        this.sort = sort;
        this.refresh();
    }

    // -------------------------------------------------------------------------
    // TreeDataProvider
    // -------------------------------------------------------------------------

    getTreeItem(element: TaskTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TaskTreeItem): TaskTreeItem[] {
        if (!element) {
            return this._collectionNodes();
        }

        if (element.kind === 'collection') {
            return this._taskNodesForCollection(element.collection!.id);
        }

        if (element.kind === 'task' && element.task) {
            return this._subtaskNodes(element.task.uid);
        }

        if (element.kind === 'subtask' && element.task) {
            return this._subtaskNodes(element.task.uid);
        }

        if (element.kind === 'completed-group' && element.collection) {
            return this._completedTaskNodes(element.collection.id);
        }

        return [];
    }

    // -------------------------------------------------------------------------
    // Drag-and-drop
    // -------------------------------------------------------------------------

    handleDrag(
        source: readonly TaskTreeItem[],
        dataTransfer: vscode.DataTransfer,
    ): void {
        // Only allow dragging task/subtask nodes
        const tasks = source.filter(n => n.task !== undefined);
        if (tasks.length === 0) { return; }
        dataTransfer.set(
            'application/vnd.code.tree.todoistTasksTree',
            new vscode.DataTransferItem(tasks),
        );
    }

    async handleDrop(
        target: TaskTreeItem | undefined,
        dataTransfer: vscode.DataTransfer,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        const item = dataTransfer.get('application/vnd.code.tree.todoistTasksTree');
        if (!item) { return; }

        const sources: TaskTreeItem[] = await item.asFile()?.data() ?? item.value;
        if (!Array.isArray(sources) || sources.length === 0) { return; }

        for (const src of sources) {
            if (!src.task) { continue; }  // can't move non-task nodes

            if (!target) {
                // Dropped on empty space — ignore
                continue;
            }

            if (target.kind === 'collection') {
                // ── Drop onto a project: move to that project, clear parent ──
                const destProjectId = target.collection!.id;
                if (src.task.collectionId === destProjectId && !src.task.parentUid) {
                    continue; // already there
                }
                await this.service.moveTask(src.task.uid, {
                    projectId: destProjectId,
                    parentUid: null,
                });

            } else if (target.task && target.task.uid !== src.task.uid) {
                // ── Drop onto a task: make src a subtask of target ──
                // Prevent dropping a parent onto its own descendant
                if (this._isDescendant(target.task.uid, src.task.uid)) { continue; }

                await this.service.moveTask(src.task.uid, {
                    projectId: target.task.collectionId,
                    parentUid: target.task.uid,
                });
            }
        }
    }

    /** Returns true if `candidateUid` is an ancestor of `nodeUid`. */
    private _isDescendant(nodeUid: string, candidateAncestorUid: string): boolean {
        let current = this.service.getTask(nodeUid);
        while (current?.parentUid) {
            if (current.parentUid === candidateAncestorUid) { return true; }
            current = this.service.getTask(current.parentUid);
        }
        return false;
    }

    // -------------------------------------------------------------------------
    // Node builders
    // -------------------------------------------------------------------------

    private _collectionNodes(): TaskTreeItem[] {
        return this.service.getCollections()
            .map(c => new TaskTreeItem(
                'collection',
                c.name,
                vscode.TreeItemCollapsibleState.Expanded,
                undefined,
                c,
            ));
    }

    private _taskNodesForCollection(collectionId: string): TaskTreeItem[] {
        const tasks = this.service.getTasks(
            { ...this.filter, collectionId, showCompleted: false },
            this.sort
        ).filter(t => !t.parentUid); // top-level only

        const nodes: TaskTreeItem[] = tasks.map(t => {
            const hasSubtasks = this.service.getSubtasks(t.uid).length > 0;
            return new TaskTreeItem(
                'task',
                t.title,
                hasSubtasks
                    ? vscode.TreeItemCollapsibleState.Collapsed
                    : vscode.TreeItemCollapsibleState.None,
                t,
            );
        });

        // Completed group at the bottom
        const collection = this.service.getCollections().find(c => c.id === collectionId);
        if (collection) {
            const completedCount = this.service
                .getTasks({ collectionId, showCompleted: true }, this.sort)
                .filter(t => t.completed && !t.parentUid).length;
            if (completedCount > 0) {
                const completedNode = new TaskTreeItem(
                    'completed-group',
                    `Completed (${completedCount})`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    undefined,
                    collection,
                );
                nodes.push(completedNode);
            }
        }

        return nodes;
    }

    private _subtaskNodes(parentUid: string): TaskTreeItem[] {
        return this.service.getSubtasks(parentUid).map(t => {
            const hasChildren = this.service.getSubtasks(t.uid).length > 0;
            return new TaskTreeItem(
                'subtask',
                t.title,
                hasChildren
                    ? vscode.TreeItemCollapsibleState.Collapsed
                    : vscode.TreeItemCollapsibleState.None,
                t,
            );
        });
    }

    private _completedTaskNodes(collectionId: string): TaskTreeItem[] {
        return this.service
            .getTasks({ collectionId, showCompleted: true }, this.sort)
            .filter(t => t.completed && !t.parentUid)
            .map(t => new TaskTreeItem(
                'task',
                t.title,
                vscode.TreeItemCollapsibleState.None,
                t,
            ));
    }

    // -------------------------------------------------------------------------
    // Disposal
    // -------------------------------------------------------------------------

    dispose(): void {
        this._onDidChangeTreeData.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function priorityIcon(priority: string): vscode.ThemeIcon {
    switch (priority) {
        case 'high':   return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red'));
        case 'medium': return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow'));
        case 'low':    return new vscode.ThemeIcon('circle-outline');
        default:       return new vscode.ThemeIcon('circle-outline');
    }
}

function formatDate(iso: string): string {
    const d = new Date(iso);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    d.setHours(0, 0, 0, 0);
    const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
    if (diff === 0)  { return 'Today'; }
    if (diff === 1)  { return 'Tomorrow'; }
    if (diff === -1) { return 'Yesterday'; }
    if (diff < 0)    { return `${Math.abs(diff)}d overdue`; }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function buildTooltip(t: Task): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${t.title}**\n\n`);
    if (t.dueDate)     { md.appendMarkdown(`📅 Due: ${formatDate(t.dueDate)}\n\n`); }
    if (t.priority !== 'none') { md.appendMarkdown(`⚡ Priority: ${t.priority}\n\n`); }
    if (t.tags.length) { md.appendMarkdown(`🏷️ ${t.tags.join(', ')}\n\n`); }
    if (t.description) { md.appendMarkdown(`${t.description}`); }
    return md;
}
