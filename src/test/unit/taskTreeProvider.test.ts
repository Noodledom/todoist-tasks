/**
 * Unit tests for TaskTreeProvider — drag-and-drop logic, subtask node rendering,
 * and tree structure.
 *
 * The vscode module is stubbed out (via helpers/stubs). The TodoistService is
 * replaced with a minimal fake so tests run fully in-process.
 */

// Must be first — patches Node's module loader to intercept 'vscode'
import '../helpers/stubs';
import { makeRawTask, makeRawProject, resetIdCounter } from '../helpers/stubs';

import * as assert from 'assert';
import * as vscode from 'vscode';
import { TaskTreeProvider } from '../../views/taskTreeProvider';
import { TodoistService } from '../../todoist/todoistService';
import { TodoistTask, TodoistProject } from '../../todoist/types';

// ---------------------------------------------------------------------------
// Minimal fake service (mirrors FakeApiClient pattern from todoistService tests)
// ---------------------------------------------------------------------------

class FakeService {
    private projects: TodoistProject[] = [];
    private tasks: TodoistTask[] = [];

    /** Captures all moveTask calls so tests can assert on them */
    moveTaskCalls: Array<{ uid: string; opts: { projectId?: string; parentUid?: string | null } }> = [];

    private readonly _onDidChange = new (vscode as any).EventEmitter();
    get onDidChange() { return this._onDidChange.event; }

    constructor(projects: TodoistProject[], tasks: TodoistTask[]) {
        this.projects = projects;
        this.tasks = tasks;
    }

    getCollections() {
        return this.projects.map(p => ({
            id: p.id,
            name: p.name,
            color: p.color,
            parentId: p.parent_id ?? undefined,
        }));
    }

    getTasks(filter?: { collectionId?: string; showCompleted?: boolean }, _sort?: unknown) {
        let result = this.tasks.map(t => ({
            uid: t.id,
            collectionId: t.project_id,
            title: t.content,
            completed: t.checked,
            parentUid: t.parent_id ?? undefined,
            tags: t.labels ?? [],
            priority: 'none' as const,
            dueDate: t.due?.date,
            description: t.description || undefined,
            order: t.child_order,
            createdAt: t.added_at,
        }));
        if (filter?.collectionId) {
            result = result.filter(t => t.collectionId === filter.collectionId);
        }
        if (!filter?.showCompleted) {
            result = result.filter(t => !t.completed);
        }
        return result;
    }

    getTask(uid: string) {
        const raw = this.tasks.find(t => t.id === uid);
        if (!raw) { return undefined; }
        return {
            uid: raw.id,
            collectionId: raw.project_id,
            title: raw.content,
            completed: raw.checked,
            parentUid: raw.parent_id ?? undefined,
            tags: raw.labels ?? [],
            priority: 'none' as const,
            dueDate: raw.due?.date,
            description: raw.description || undefined,
            order: raw.child_order,
            createdAt: raw.added_at,
        };
    }

    getSubtasks(parentUid: string) {
        return this.tasks
            .filter(t => t.parent_id === parentUid)
            .map(t => ({
                uid: t.id,
                collectionId: t.project_id,
                title: t.content,
                completed: t.checked,
                parentUid: t.parent_id ?? undefined,
                tags: t.labels ?? [],
                priority: 'none' as const,
                dueDate: t.due?.date,
                description: t.description || undefined,
                order: t.child_order,
                createdAt: t.added_at,
            }));
    }

    async moveTask(uid: string, opts: { projectId?: string; parentUid?: string | null }) {
        this.moveTaskCalls.push({ uid, opts });
        // Apply to in-memory store so assertions on getTask work
        const raw = this.tasks.find(t => t.id === uid);
        if (raw) {
            if (opts.projectId !== undefined) { raw.project_id = opts.projectId; }
            if (opts.parentUid !== undefined)  { raw.parent_id = opts.parentUid; }
        }
    }
}

// ---------------------------------------------------------------------------
// Build helpers
// ---------------------------------------------------------------------------

function buildProvider(
    projects: TodoistProject[],
    tasks: TodoistTask[],
): { provider: TaskTreeProvider; svc: FakeService } {
    const svc = new FakeService(projects, tasks);
    // Cast: FakeService satisfies the surface TaskTreeProvider uses
    const provider = new TaskTreeProvider(svc as unknown as TodoistService);
    return { provider, svc };
}

/** Simulate a DataTransfer containing the given tree items */
function makeDataTransfer(items: unknown[]): vscode.DataTransfer {
    const dt = new (vscode as any).DataTransfer() as vscode.DataTransfer;
    const dtItem = new (vscode as any).DataTransferItem(items);
    dt.set('application/vnd.code.tree.todoistTasksTree', dtItem);
    return dt;
}

// ---------------------------------------------------------------------------
// Tests — getChildren tree structure
// ---------------------------------------------------------------------------

describe('TaskTreeProvider — getChildren (root)', () => {
    beforeEach(() => resetIdCounter(1));

    it('returns a collection node per project', () => {
        const p1 = makeRawProject({ id: 'p1', name: 'Work' });
        const p2 = makeRawProject({ id: 'p2', name: 'Home' });
        const { provider } = buildProvider([p1, p2], []);

        const children = provider.getChildren(undefined);
        assert.strictEqual(children.length, 2);
        assert.strictEqual(children[0].kind, 'collection');
        assert.strictEqual(children[0].label, 'Work');
        assert.strictEqual(children[1].label, 'Home');
    });

    it('returns empty array when no projects', () => {
        const { provider } = buildProvider([], []);
        assert.deepStrictEqual(provider.getChildren(undefined), []);
    });
});

// ---------------------------------------------------------------------------

describe('TaskTreeProvider — getChildren (collection)', () => {
    beforeEach(() => resetIdCounter(1));

    it('returns top-level task nodes for a collection', () => {
        const proj = makeRawProject({ id: 'p1', name: 'Work' });
        const t1 = makeRawTask({ id: 't1', project_id: 'p1', content: 'Alpha' });
        const t2 = makeRawTask({ id: 't2', project_id: 'p1', content: 'Beta' });
        const { provider } = buildProvider([proj], [t1, t2]);

        const collectionNode = provider.getChildren(undefined)[0];
        const taskNodes = provider.getChildren(collectionNode);

        const taskLabels = taskNodes
            .filter(n => n.kind === 'task')
            .map(n => n.label as string);
        assert.ok(taskLabels.includes('Alpha'));
        assert.ok(taskLabels.includes('Beta'));
    });

    it('does not show subtasks as top-level items', () => {
        const proj = makeRawProject({ id: 'p1' });
        const parent = makeRawTask({ id: 'parent', project_id: 'p1' });
        const child  = makeRawTask({ id: 'child',  project_id: 'p1', parent_id: 'parent' });
        const { provider } = buildProvider([proj], [parent, child]);

        const collectionNode = provider.getChildren(undefined)[0];
        const taskNodes = provider.getChildren(collectionNode);
        const topLevel = taskNodes.filter(n => n.kind === 'task');

        assert.strictEqual(topLevel.length, 1);
        assert.strictEqual(topLevel[0].task?.uid, 'parent');
    });

    it('shows a Completed group node when completed tasks exist', () => {
        const proj = makeRawProject({ id: 'p1' });
        const done = makeRawTask({ id: 't1', project_id: 'p1', checked: true });
        const { provider } = buildProvider([proj], [done]);

        const collectionNode = provider.getChildren(undefined)[0];
        const children = provider.getChildren(collectionNode);
        const completedGroup = children.find(n => n.kind === 'completed-group');

        assert.ok(completedGroup, 'should have a completed-group node');
    });

    it('task node gets Collapsed state when it has subtasks', () => {
        const proj = makeRawProject({ id: 'p1' });
        const parent = makeRawTask({ id: 'parent', project_id: 'p1' });
        const child  = makeRawTask({ id: 'child',  project_id: 'p1', parent_id: 'parent' });
        const { provider } = buildProvider([proj], [parent, child]);

        const collectionNode = provider.getChildren(undefined)[0];
        const taskNodes = provider.getChildren(collectionNode);
        const parentNode = taskNodes.find(n => n.task?.uid === 'parent');

        // TreeItemCollapsibleState.Collapsed = 1
        assert.strictEqual(parentNode?.collapsibleState, 1);
    });

    it('task node gets None state when it has no subtasks', () => {
        const proj = makeRawProject({ id: 'p1' });
        const solo = makeRawTask({ id: 'solo', project_id: 'p1' });
        const { provider } = buildProvider([proj], [solo]);

        const collectionNode = provider.getChildren(undefined)[0];
        const taskNodes = provider.getChildren(collectionNode);
        const soloNode = taskNodes.find(n => n.task?.uid === 'solo');

        // TreeItemCollapsibleState.None = 0
        assert.strictEqual(soloNode?.collapsibleState, 0);
    });
});

// ---------------------------------------------------------------------------

describe('TaskTreeProvider — getChildren (subtasks, multi-level)', () => {
    beforeEach(() => resetIdCounter(1));

    it('returns subtask nodes under a task node', () => {
        const proj = makeRawProject({ id: 'p1' });
        const parent = makeRawTask({ id: 'parent', project_id: 'p1' });
        const child  = makeRawTask({ id: 'child',  project_id: 'p1', parent_id: 'parent', content: 'Child task' });
        const { provider } = buildProvider([proj], [parent, child]);

        const collectionNode = provider.getChildren(undefined)[0];
        const taskNodes = provider.getChildren(collectionNode);
        const parentNode = taskNodes.find(n => n.task?.uid === 'parent')!;

        const subtasks = provider.getChildren(parentNode);
        assert.strictEqual(subtasks.length, 1);
        assert.strictEqual(subtasks[0].kind, 'subtask');
        assert.strictEqual(subtasks[0].label, 'Child task');
    });

    it('subtask node with children gets Collapsed state (multi-level)', () => {
        const proj = makeRawProject({ id: 'p1' });
        const grandparent = makeRawTask({ id: 'gp',  project_id: 'p1' });
        const parent      = makeRawTask({ id: 'par', project_id: 'p1', parent_id: 'gp' });
        const child       = makeRawTask({ id: 'ch',  project_id: 'p1', parent_id: 'par' });
        const { provider } = buildProvider([proj], [grandparent, parent, child]);

        const collectionNode = provider.getChildren(undefined)[0];
        const gpNode = provider.getChildren(collectionNode).find(n => n.task?.uid === 'gp')!;
        const parNode = provider.getChildren(gpNode).find(n => n.task?.uid === 'par')!;

        // parent subtask has a child → Collapsed (1)
        assert.strictEqual(parNode.collapsibleState, 1);
    });

    it('subtask node with no children gets None state', () => {
        const proj   = makeRawProject({ id: 'p1' });
        const parent = makeRawTask({ id: 'par', project_id: 'p1' });
        const child  = makeRawTask({ id: 'ch',  project_id: 'p1', parent_id: 'par' });
        const { provider } = buildProvider([proj], [parent, child]);

        const collectionNode = provider.getChildren(undefined)[0];
        const parNode = provider.getChildren(collectionNode).find(n => n.task?.uid === 'par')!;
        const chNode  = provider.getChildren(parNode).find(n => n.task?.uid === 'ch')!;

        // leaf subtask → None (0)
        assert.strictEqual(chNode.collapsibleState, 0);
    });

    it('getChildren recurses for a subtask node', () => {
        const proj   = makeRawProject({ id: 'p1' });
        const t1     = makeRawTask({ id: 't1', project_id: 'p1' });
        const t2     = makeRawTask({ id: 't2', project_id: 'p1', parent_id: 't1' });
        const t3     = makeRawTask({ id: 't3', project_id: 'p1', parent_id: 't2' });
        const { provider } = buildProvider([proj], [t1, t2, t3]);

        const colNode = provider.getChildren(undefined)[0];
        const t1Node  = provider.getChildren(colNode).find(n => n.task?.uid === 't1')!;
        const t2Node  = provider.getChildren(t1Node).find(n => n.task?.uid === 't2')!;
        const t3Nodes = provider.getChildren(t2Node);

        assert.strictEqual(t3Nodes.length, 1);
        assert.strictEqual(t3Nodes[0].task?.uid, 't3');
    });
});

// ---------------------------------------------------------------------------
// Tests — handleDrag
// ---------------------------------------------------------------------------

describe('TaskTreeProvider — handleDrag', () => {
    beforeEach(() => resetIdCounter(1));

    it('serialises task nodes into the data transfer', () => {
        const proj = makeRawProject({ id: 'p1' });
        const task = makeRawTask({ id: 't1', project_id: 'p1' });
        const { provider } = buildProvider([proj], [task]);

        const collectionNode = provider.getChildren(undefined)[0];
        const [taskNode] = provider.getChildren(collectionNode).filter(n => n.kind === 'task');

        const dt = new (vscode as any).DataTransfer();
        provider.handleDrag([taskNode], dt);

        const item = dt.get('application/vnd.code.tree.todoistTasksTree');
        assert.ok(item, 'data transfer should have the MIME entry');
        assert.ok(Array.isArray(item.value));
        assert.strictEqual((item.value as any[])[0].task?.uid, 't1');
    });

    it('ignores collection nodes (does not set data transfer)', () => {
        const proj = makeRawProject({ id: 'p1' });
        const { provider } = buildProvider([proj], []);

        const [collectionNode] = provider.getChildren(undefined);
        const dt = new (vscode as any).DataTransfer();
        provider.handleDrag([collectionNode], dt);

        assert.strictEqual(dt.get('application/vnd.code.tree.todoistTasksTree'), undefined);
    });
});

// ---------------------------------------------------------------------------
// Tests — handleDrop
// ---------------------------------------------------------------------------

describe('TaskTreeProvider — handleDrop onto collection', () => {
    beforeEach(() => resetIdCounter(1));

    it('moves a task to the target project and clears parent', async () => {
        const proj1 = makeRawProject({ id: 'p1', name: 'Work' });
        const proj2 = makeRawProject({ id: 'p2', name: 'Home' });
        const task  = makeRawTask({ id: 't1', project_id: 'p1' });
        const { provider, svc } = buildProvider([proj1, proj2], [task]);

        const [p1Node, p2Node] = provider.getChildren(undefined);
        const [taskNode] = provider.getChildren(p1Node).filter(n => n.kind === 'task');

        const dt = makeDataTransfer([taskNode]);
        await provider.handleDrop(p2Node, dt, undefined as any);

        assert.strictEqual(svc.moveTaskCalls.length, 1);
        assert.strictEqual(svc.moveTaskCalls[0].uid, 't1');
        assert.strictEqual(svc.moveTaskCalls[0].opts.projectId, 'p2');
        assert.strictEqual(svc.moveTaskCalls[0].opts.parentUid, null);
    });

    it('skips the move when task is already in the target project at top level', async () => {
        const proj = makeRawProject({ id: 'p1' });
        const task = makeRawTask({ id: 't1', project_id: 'p1', parent_id: null });
        const { provider, svc } = buildProvider([proj], [task]);

        const [p1Node] = provider.getChildren(undefined);
        const [taskNode] = provider.getChildren(p1Node).filter(n => n.kind === 'task');

        const dt = makeDataTransfer([taskNode]);
        await provider.handleDrop(p1Node, dt, undefined as any);

        assert.strictEqual(svc.moveTaskCalls.length, 0, 'should not move a task to its current project');
    });
});

// ---------------------------------------------------------------------------

describe('TaskTreeProvider — handleDrop onto task (make subtask)', () => {
    beforeEach(() => resetIdCounter(1));

    it('makes the source a subtask of the drop target', async () => {
        const proj   = makeRawProject({ id: 'p1' });
        const target = makeRawTask({ id: 'target', project_id: 'p1', content: 'Parent' });
        const source = makeRawTask({ id: 'source', project_id: 'p1', content: 'Child' });
        const { provider, svc } = buildProvider([proj], [target, source]);

        const [p1Node] = provider.getChildren(undefined);
        const nodes = provider.getChildren(p1Node).filter(n => n.kind === 'task');
        const targetNode = nodes.find(n => n.task?.uid === 'target')!;
        const sourceNode = nodes.find(n => n.task?.uid === 'source')!;

        const dt = makeDataTransfer([sourceNode]);
        await provider.handleDrop(targetNode, dt, undefined as any);

        assert.strictEqual(svc.moveTaskCalls.length, 1);
        assert.strictEqual(svc.moveTaskCalls[0].uid, 'source');
        assert.strictEqual(svc.moveTaskCalls[0].opts.parentUid, 'target');
        assert.strictEqual(svc.moveTaskCalls[0].opts.projectId, 'p1');
    });

    it('prevents dropping a task onto itself', async () => {
        const proj = makeRawProject({ id: 'p1' });
        const task = makeRawTask({ id: 't1', project_id: 'p1' });
        const { provider, svc } = buildProvider([proj], [task]);

        const [p1Node] = provider.getChildren(undefined);
        const [taskNode] = provider.getChildren(p1Node).filter(n => n.kind === 'task');

        const dt = makeDataTransfer([taskNode]);
        await provider.handleDrop(taskNode, dt, undefined as any);

        assert.strictEqual(svc.moveTaskCalls.length, 0, 'should not drop task onto itself');
    });

    it('prevents circular reparenting (parent dropped onto its own descendant)', async () => {
        const proj   = makeRawProject({ id: 'p1' });
        const parent = makeRawTask({ id: 'gp',  project_id: 'p1' });
        const child  = makeRawTask({ id: 'ch',  project_id: 'p1', parent_id: 'gp' });
        const { provider, svc } = buildProvider([proj], [parent, child]);

        const [p1Node] = provider.getChildren(undefined);
        const gpNode  = provider.getChildren(p1Node).find(n => n.task?.uid === 'gp')!;
        const chNode  = provider.getChildren(gpNode).find(n => n.task?.uid === 'ch')!;

        // Try to drop the grandparent onto its own child
        const dt = makeDataTransfer([gpNode]);
        await provider.handleDrop(chNode, dt, undefined as any);

        assert.strictEqual(svc.moveTaskCalls.length, 0, 'circular drag-drop should be blocked');
    });
});

// ---------------------------------------------------------------------------

describe('TaskTreeProvider — handleDrop, no target', () => {
    it('ignores drop when target is undefined', async () => {
        const proj = makeRawProject({ id: 'p1' });
        const task = makeRawTask({ id: 't1', project_id: 'p1' });
        const { provider, svc } = buildProvider([proj], [task]);

        const [p1Node] = provider.getChildren(undefined);
        const [taskNode] = provider.getChildren(p1Node).filter(n => n.kind === 'task');

        const dt = makeDataTransfer([taskNode]);
        await provider.handleDrop(undefined, dt, undefined as any);

        assert.strictEqual(svc.moveTaskCalls.length, 0);
    });

    it('ignores drop when data transfer has no matching MIME entry', async () => {
        const proj = makeRawProject({ id: 'p1' });
        const { provider, svc } = buildProvider([proj], []);

        const [p1Node] = provider.getChildren(undefined);
        const emptyDt = new (vscode as any).DataTransfer();

        await provider.handleDrop(p1Node, emptyDt, undefined as any);
        assert.strictEqual(svc.moveTaskCalls.length, 0);
    });
});
