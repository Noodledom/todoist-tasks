/**
 * Unit tests for TodoistService.
 *
 * We stub both `vscode` (via helpers/stubs) and `TodoistApiClient` so that
 * the service can be exercised purely in-process without any network or
 * VS Code extension host.
 */

// Must be first — patches Node's module loader to intercept 'vscode'
import '../helpers/stubs';
import { makeRawTask, makeRawProject, resetIdCounter } from '../helpers/stubs';

import * as assert from 'assert';
import { TodoistService } from '../../todoist/todoistService';
import { TodoistTask, TodoistProject } from '../../todoist/types';

// ---------------------------------------------------------------------------
// Stub TodoistApiClient
// ---------------------------------------------------------------------------

/** A minimal fake client that the service can call without hitting the network. */
class FakeApiClient {
    projects: TodoistProject[] = [];
    tasks: TodoistTask[] = [];

    async getProjects() { return [...this.projects]; }
    async getTasks()    { return [...this.tasks]; }

    async createTask(params: {
        content: string; description?: string; project_id?: string;
        parent_id?: string; priority?: number; due_date?: string; labels?: string[];
    }): Promise<TodoistTask> {
        const raw = makeRawTask({
            content: params.content,
            description: params.description ?? '',
            project_id: params.project_id ?? 'proj-1',
            parent_id: params.parent_id ?? null,
            priority: params.priority ?? 1,
            due: params.due_date ? { date: params.due_date, is_recurring: false } : null,
            labels: params.labels ?? [],
        });
        this.tasks.push(raw);
        return raw;
    }

    async updateTask(id: string, params: {
        content?: string; description?: string; priority?: number;
        due_date?: string; due_string?: string; labels?: string[];
    }): Promise<TodoistTask> {
        const raw = this.tasks.find(t => t.id === id);
        if (!raw) { throw new Error(`Task ${id} not found`); }
        if (params.content !== undefined)     { raw.content = params.content; }
        if (params.description !== undefined) { raw.description = params.description; }
        if (params.priority !== undefined)    { raw.priority = params.priority; }
        if (params.labels !== undefined)      { raw.labels = params.labels; }
        if (params.due_date)  { raw.due = { date: params.due_date, is_recurring: false }; }
        if (params.due_string === 'no date')  { raw.due = null; }
        return raw;
    }

    async closeTask(id: string)  {
        const raw = this.tasks.find(t => t.id === id);
        if (raw) { raw.checked = true; }
    }

    async reopenTask(id: string) {
        const raw = this.tasks.find(t => t.id === id);
        if (raw) { raw.checked = false; }
    }

    async deleteTask(id: string) {
        this.tasks = this.tasks.filter(t => t.id !== id);
    }

    async moveTask(id: string, params: { project_id?: string; parent_id?: string | null }): Promise<TodoistTask> {
        const raw = this.tasks.find(t => t.id === id);
        if (!raw) { throw new Error(`Task ${id} not found`); }
        if (params.project_id !== undefined) { raw.project_id = params.project_id; }
        if (params.parent_id !== undefined)  { raw.parent_id = params.parent_id; }
        return raw;
    }

    /** Last call captured for assertion */
    lastMoveTaskCall: { id: string; params: { project_id?: string; parent_id?: string | null } } | undefined;
    async moveTaskCapturing(id: string, params: { project_id?: string; parent_id?: string | null }): Promise<TodoistTask> {
        this.lastMoveTaskCall = { id, params };
        return this.moveTask(id, params);
    }

    async createLabel(name: string): Promise<{ id: string; name: string; color: string; order: number; is_favorite: boolean }> {
        return { id: 'lbl-new', name, color: 'charcoal', order: 1, is_favorite: false };
    }

    async getLabels(): Promise<string[]> {
        return this._labels;
    }

    _labels: string[] = [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a service pre-loaded with projects and tasks via the fake client. */
function buildService(
    projects: TodoistProject[],
    tasks: TodoistTask[]
): { svc: TodoistService; client: FakeApiClient } {
    const client = new FakeApiClient();
    client.projects = projects;
    client.tasks = tasks;

    const svc = new TodoistService(9999); // very long poll interval — no auto-polling
    // Inject fake client directly (bypasses token check)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).client = client;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).store = { projects, tasks };

    return { svc, client };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TodoistService — isInitialised', () => {
    it('returns false before init()', () => {
        const svc = new TodoistService();
        assert.strictEqual(svc.isInitialised(), false);
    });

    it('returns true after init() with a token', () => {
        const svc = new TodoistService();
        // Calling init() would trigger polling + real fetch; inject client directly
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (svc as any).client = {};
        assert.strictEqual(svc.isInitialised(), true);
    });
});

// ---------------------------------------------------------------------------

describe('TodoistService — getCollections', () => {
    beforeEach(() => resetIdCounter(1));

    it('maps raw projects to Collection objects', () => {
        const rawProj = makeRawProject({ id: 'p1', name: 'Work', color: 'red' });
        const { svc } = buildService([rawProj], []);

        const cols = svc.getCollections();
        assert.strictEqual(cols.length, 1);
        assert.strictEqual(cols[0].id, 'p1');
        assert.strictEqual(cols[0].name, 'Work');
        assert.strictEqual(cols[0].color, 'red');
    });

    it('maps parent_id to parentId', () => {
        const parent = makeRawProject({ id: 'parent' });
        const child  = makeRawProject({ id: 'child', parent_id: 'parent' });
        const { svc } = buildService([parent, child], []);
        const cols = svc.getCollections();
        assert.strictEqual(cols.find((c: { id: string; parentId?: string }) => c.id === 'child')?.parentId, 'parent');
    });
});

// ---------------------------------------------------------------------------

describe('TodoistService — getTasks (mapping)', () => {
    beforeEach(() => resetIdCounter(1));

    it('maps content → title, project_id → collectionId', () => {
        const raw = makeRawTask({ id: 't1', content: 'Buy milk', project_id: 'p1' });
        const { svc } = buildService([], [raw]);
        const [task] = svc.getTasks();
        assert.strictEqual(task.title, 'Buy milk');
        assert.strictEqual(task.collectionId, 'p1');
    });

    it('maps checked → completed', () => {
        const done  = makeRawTask({ id: 't1', checked: true });
        const open  = makeRawTask({ id: 't2', checked: false });
        const { svc } = buildService([], [done, open]);
        const tasks = svc.getTasks({ showCompleted: true });
        assert.strictEqual(tasks.find((t: { uid: string }) => t.uid === 't1')?.completed, true);
        assert.strictEqual(tasks.find((t: { uid: string }) => t.uid === 't2')?.completed, false);
    });

    it('maps priority: 4→high, 3→medium, 2→low, 1→none', () => {
        const raws = [
            makeRawTask({ id: '1', priority: 4 }),
            makeRawTask({ id: '2', priority: 3 }),
            makeRawTask({ id: '3', priority: 2 }),
            makeRawTask({ id: '4', priority: 1 }),
        ];
        const { svc } = buildService([], raws);
        const tasks = svc.getTasks();
        type T = { uid: string; priority: string };
        assert.strictEqual(tasks.find((t: T) => t.uid === '1')?.priority, 'high');
        assert.strictEqual(tasks.find((t: T) => t.uid === '2')?.priority, 'medium');
        assert.strictEqual(tasks.find((t: T) => t.uid === '3')?.priority, 'low');
        assert.strictEqual(tasks.find((t: T) => t.uid === '4')?.priority, 'none');
    });

    it('maps due.date → dueDate (YYYY-MM-DD)', () => {
        const raw = makeRawTask({ due: { date: '2026-03-10', is_recurring: false } });
        const { svc } = buildService([], [raw]);
        const [task] = svc.getTasks();
        assert.strictEqual(task.dueDate, '2026-03-10');
    });

    it('prefers due.datetime over due.date (takes first 10 chars)', () => {
        const raw = makeRawTask({
            due: { date: '2026-03-10', datetime: '2026-03-10T14:30:00Z', is_recurring: false },
        });
        const { svc } = buildService([], [raw]);
        const [task] = svc.getTasks();
        assert.strictEqual(task.dueDate, '2026-03-10');
    });

    it('maps labels → tags', () => {
        const raw = makeRawTask({ labels: ['work', 'urgent'] });
        const { svc } = buildService([], [raw]);
        const [task] = svc.getTasks();
        assert.deepStrictEqual(task.tags, ['work', 'urgent']);
    });

    it('maps parent_id → parentUid', () => {
        const parent = makeRawTask({ id: 'p' });
        const child  = makeRawTask({ id: 'c', parent_id: 'p' });
        const { svc } = buildService([], [parent, child]);
        const tasks = svc.getTasks();
        assert.strictEqual(tasks.find((t: { uid: string; parentUid?: string }) => t.uid === 'c')?.parentUid, 'p');
    });
});

// ---------------------------------------------------------------------------

describe('TodoistService — getTasks (filtering)', () => {
    let svc: TodoistService;

    before(() => {
        resetIdCounter(1);
        const raws = [
            makeRawTask({ id: 'a', project_id: 'p1', priority: 4, checked: false, labels: ['work'] }),
            makeRawTask({ id: 'b', project_id: 'p2', priority: 1, checked: true,  labels: ['home'] }),
            makeRawTask({ id: 'c', project_id: 'p1', priority: 2, checked: false, labels: [] }),
        ];
        ({ svc } = buildService([], raws));
    });

    it('hides completed tasks by default', () => {
        const tasks = svc.getTasks();
        assert.ok(tasks.every((t: { completed: boolean }) => !t.completed));
    });

    it('shows completed tasks when showCompleted=true', () => {
        const tasks = svc.getTasks({ showCompleted: true });
        assert.ok(tasks.some((t: { completed: boolean }) => t.completed));
    });

    it('filters by collectionId', () => {
        const tasks = svc.getTasks({ collectionId: 'p1' });
        assert.ok(tasks.every((t: { collectionId: string }) => t.collectionId === 'p1'));
    });

    it('filters by priority', () => {
        const tasks = svc.getTasks({ priority: 'high' });
        assert.ok(tasks.every((t: { priority: string }) => t.priority === 'high'));
    });

    it('filters by tag', () => {
        const tasks = svc.getTasks({ tags: ['work'] });
        assert.ok(tasks.every((t: { tags: string[] }) => t.tags.includes('work')));
    });

    it('returns empty array when no tasks match', () => {
        const tasks = svc.getTasks({ priority: 'medium' });
        assert.strictEqual(tasks.length, 0);
    });
});

// ---------------------------------------------------------------------------

describe('TodoistService — getTasks (sorting)', () => {
    let svc: TodoistService;

    before(() => {
        resetIdCounter(1);
        const raws = [
            makeRawTask({ id: '1', content: 'Banana', priority: 2, due: { date: '2026-03-15', is_recurring: false }, added_at: '2026-01-03T00:00:00Z' }),
            makeRawTask({ id: '2', content: 'Apple',  priority: 4, due: { date: '2026-03-10', is_recurring: false }, added_at: '2026-01-01T00:00:00Z' }),
            makeRawTask({ id: '3', content: 'Cherry', priority: 1, due: null,                                        added_at: '2026-01-02T00:00:00Z' }),
        ];
        ({ svc } = buildService([], raws));
    });

    it('sorts by dueDate asc (no-date last)', () => {
        const tasks = svc.getTasks(undefined, { by: 'dueDate', order: 'asc' });
        assert.strictEqual(tasks[0].uid, '2'); // 2026-03-10
        assert.strictEqual(tasks[1].uid, '1'); // 2026-03-15
        assert.strictEqual(tasks[2].uid, '3'); // no date
    });

    it('sorts by dueDate desc', () => {
        const tasks = svc.getTasks(undefined, { by: 'dueDate', order: 'desc' });
        assert.strictEqual(tasks[0].uid, '3'); // no date sorts as 9999
        assert.strictEqual(tasks[1].uid, '1');
        assert.strictEqual(tasks[2].uid, '2');
    });

    it('sorts by priority desc (high first)', () => {
        const tasks = svc.getTasks(undefined, { by: 'priority', order: 'desc' });
        assert.strictEqual(tasks[0].priority, 'high');
        assert.strictEqual(tasks[tasks.length - 1].priority, 'none');
    });

    it('sorts by title asc', () => {
        const tasks = svc.getTasks(undefined, { by: 'title', order: 'asc' });
        assert.strictEqual(tasks[0].title, 'Apple');
        assert.strictEqual(tasks[1].title, 'Banana');
        assert.strictEqual(tasks[2].title, 'Cherry');
    });

    it('sorts by created asc', () => {
        const tasks = svc.getTasks(undefined, { by: 'created', order: 'asc' });
        assert.strictEqual(tasks[0].uid, '2'); // 2026-01-01
        assert.strictEqual(tasks[1].uid, '3'); // 2026-01-02
        assert.strictEqual(tasks[2].uid, '1'); // 2026-01-03
    });
});

// ---------------------------------------------------------------------------

describe('TodoistService — getTask', () => {
    it('returns the mapped task for a known uid', () => {
        const raw = makeRawTask({ id: 'known' });
        const { svc } = buildService([], [raw]);
        const task = svc.getTask('known');
        assert.ok(task);
        assert.strictEqual(task.uid, 'known');
    });

    it('returns undefined for an unknown uid', () => {
        const { svc } = buildService([], []);
        assert.strictEqual(svc.getTask('ghost'), undefined);
    });
});

// ---------------------------------------------------------------------------

describe('TodoistService — getSubtasks', () => {
    it('returns direct children only', () => {
        const parent = makeRawTask({ id: 'parent' });
        const child1 = makeRawTask({ id: 'child1', parent_id: 'parent' });
        const child2 = makeRawTask({ id: 'child2', parent_id: 'parent' });
        const grand  = makeRawTask({ id: 'grand',  parent_id: 'child1' });
        const { svc } = buildService([], [parent, child1, child2, grand]);

        const subs = svc.getSubtasks('parent');
        assert.strictEqual(subs.length, 2);
        assert.ok(subs.every((s: { parentUid?: string }) => s.parentUid === 'parent'));
    });

    it('returns empty array when task has no children', () => {
        const raw = makeRawTask({ id: 'solo' });
        const { svc } = buildService([], [raw]);
        assert.deepStrictEqual(svc.getSubtasks('solo'), []);
    });
});

// ---------------------------------------------------------------------------

describe('TodoistService — getAllTags', () => {
    it('calls client.getLabels() and returns the result', async () => {
        const raws = [
            makeRawTask({ labels: ['work', 'urgent'] }),
            makeRawTask({ labels: ['home', 'work'] }),
        ];
        const { svc, client } = buildService([], raws);
        client._labels = ['home', 'urgent', 'work'];

        const tags = await svc.getAllTags();
        assert.deepStrictEqual(tags, ['home', 'urgent', 'work']);
    });

    it('falls back to scraping task store when client.getLabels() throws', async () => {
        const raws = [
            makeRawTask({ labels: ['alpha', 'beta'] }),
            makeRawTask({ labels: ['beta', 'gamma'] }),
        ];
        const { svc, client } = buildService([], raws);
        // Make getLabels throw so the fallback triggers
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).getLabels = async () => { throw new Error('network error'); };

        const tags = await svc.getAllTags();
        assert.deepStrictEqual(tags, ['alpha', 'beta', 'gamma']);
    });

    it('returns empty array when service is not initialised', async () => {
        const svc = new TodoistService();
        const tags = await svc.getAllTags();
        assert.deepStrictEqual(tags, []);
    });
});

// ---------------------------------------------------------------------------

describe('TodoistService — createTask', () => {
    it('creates a task and adds it to the store', async () => {
        const proj = makeRawProject({ id: 'p1' });
        const { svc } = buildService([proj], []);

        const task = await svc.createTask({ collectionId: 'p1', title: 'New task' });

        assert.strictEqual(task.title, 'New task');
        assert.strictEqual(task.collectionId, 'p1');
        assert.strictEqual(svc.getTask(task.uid)?.title, 'New task');
    });

    it('maps optional fields (priority, dueDate, tags, description)', async () => {
        const { svc } = buildService([makeRawProject({ id: 'p1' })], []);
        const task = await svc.createTask({
            collectionId: 'p1',
            title: 'With fields',
            priority: 'high',
            dueDate: '2026-04-01',
            tags: ['work'],
            description: 'details',
        });
        assert.strictEqual(task.priority, 'high');
        assert.strictEqual(task.dueDate, '2026-04-01');
        assert.deepStrictEqual(task.tags, ['work']);
        assert.strictEqual(task.description, 'details');
    });

    it('throws when service is not initialised', async () => {
        const svc = new TodoistService();
        await assert.rejects(
            () => svc.createTask({ collectionId: 'p1', title: 'x' }),
            /not initialised/
        );
    });
});

// ---------------------------------------------------------------------------

describe('TodoistService — updateTask', () => {
    it('updates title, priority, due date and tags', async () => {
        const raw = makeRawTask({ id: 't1', content: 'Old', priority: 1 });
        const { svc } = buildService([], [raw]);

        const existing = svc.getTask('t1')!;
        await svc.updateTask({
            ...existing,
            title: 'Updated',
            priority: 'high',
            dueDate: '2026-06-01',
            tags: ['new-tag'],
        });

        const updated = svc.getTask('t1')!;
        assert.strictEqual(updated.title, 'Updated');
        assert.strictEqual(updated.priority, 'high');
        assert.strictEqual(updated.dueDate, '2026-06-01');
        assert.deepStrictEqual(updated.tags, ['new-tag']);
    });

    it('clears due date when dueDate is undefined', async () => {
        const raw = makeRawTask({ id: 't2', due: { date: '2026-03-01', is_recurring: false } });
        const { svc } = buildService([], [raw]);

        const existing = svc.getTask('t2')!;
        await svc.updateTask({ ...existing, dueDate: undefined });

        assert.strictEqual(svc.getTask('t2')?.dueDate, undefined);
    });
});

// ---------------------------------------------------------------------------

describe('TodoistService — completeTask', () => {
    it('marks a task as completed', async () => {
        const raw = makeRawTask({ id: 't1', checked: false });
        const { svc } = buildService([], [raw]);

        await svc.completeTask('t1');
        assert.strictEqual(svc.getTask('t1')?.completed, true);
    });

    it('also completes subtasks when completeSubtasks=true', async () => {
        const parent = makeRawTask({ id: 'parent' });
        const child  = makeRawTask({ id: 'child', parent_id: 'parent' });
        const { svc } = buildService([], [parent, child]);

        await svc.completeTask('parent', true);
        assert.strictEqual(svc.getTask('parent')?.completed, true);
        assert.strictEqual(svc.getTask('child')?.completed, true);
    });

    it('does not complete subtasks when completeSubtasks=false', async () => {
        const parent = makeRawTask({ id: 'parent2' });
        const child  = makeRawTask({ id: 'child2', parent_id: 'parent2' });
        const { svc } = buildService([], [parent, child]);

        await svc.completeTask('parent2', false);
        assert.strictEqual(svc.getTask('parent2')?.completed, true);
        assert.strictEqual(svc.getTask('child2')?.completed, false);
    });
});

// ---------------------------------------------------------------------------

describe('TodoistService — reopenTask', () => {
    it('marks a completed task as incomplete', async () => {
        const raw = makeRawTask({ id: 't1', checked: true });
        const { svc } = buildService([], [raw]);

        await svc.reopenTask('t1');
        assert.strictEqual(svc.getTask('t1')?.completed, false);
    });
});

// ---------------------------------------------------------------------------

describe('TodoistService — deleteTask', () => {
    it('removes the task from the store', async () => {
        const raw = makeRawTask({ id: 'to-delete' });
        const { svc } = buildService([], [raw]);

        await svc.deleteTask('to-delete');
        assert.strictEqual(svc.getTask('to-delete'), undefined);
        assert.strictEqual(svc.getTasks().length, 0);
    });
});

// ---------------------------------------------------------------------------

describe('TodoistService — moveTask', () => {
    it('moves a task to a different project and clears parent', async () => {
        const proj1 = makeRawProject({ id: 'p1' });
        const proj2 = makeRawProject({ id: 'p2' });
        const raw = makeRawTask({ id: 't1', project_id: 'p1', parent_id: null });
        const { svc } = buildService([proj1, proj2], [raw]);

        await svc.moveTask('t1', { projectId: 'p2', parentUid: null });

        const moved = svc.getTask('t1');
        assert.ok(moved, 'task should still exist in store');
        assert.strictEqual(moved.collectionId, 'p2');
        assert.strictEqual(moved.parentUid, undefined);
    });

    it('makes a task a subtask of another task', async () => {
        const proj = makeRawProject({ id: 'p1' });
        const parent = makeRawTask({ id: 'parent', project_id: 'p1' });
        const child  = makeRawTask({ id: 'child',  project_id: 'p1' });
        const { svc } = buildService([proj], [parent, child]);

        await svc.moveTask('child', { projectId: 'p1', parentUid: 'parent' });

        const moved = svc.getTask('child');
        assert.strictEqual(moved?.parentUid, 'parent');
        assert.strictEqual(moved?.collectionId, 'p1');
    });

    it('promotes a subtask to top-level by passing parentUid: null', async () => {
        const proj = makeRawProject({ id: 'p1' });
        const parent = makeRawTask({ id: 'parent', project_id: 'p1' });
        const child  = makeRawTask({ id: 'child',  project_id: 'p1', parent_id: 'parent' });
        const { svc } = buildService([proj], [parent, child]);

        await svc.moveTask('child', { projectId: 'p1', parentUid: null });

        const moved = svc.getTask('child');
        assert.strictEqual(moved?.parentUid, undefined);
    });

    it('fires onDidChange after moving', async () => {
        const raw = makeRawTask({ id: 'fire-me', project_id: 'p1' });
        const { svc } = buildService([makeRawProject({ id: 'p2' })], [raw]);
        let fired = false;
        svc.onDidChange(() => { fired = true; });

        await svc.moveTask('fire-me', { projectId: 'p2' });
        assert.strictEqual(fired, true);
    });

    it('throws when service is not initialised', async () => {
        const svc = new TodoistService();
        await assert.rejects(
            () => svc.moveTask('t1', { projectId: 'p1' }),
            /not initialised/,
        );
    });
});

// ---------------------------------------------------------------------------

describe('TodoistService — createLabel', () => {
    it('calls client.createLabel and returns the label name', async () => {
        const { svc } = buildService([], []);

        const name = await svc.createLabel('my-tag');
        assert.strictEqual(name, 'my-tag');
    });

    it('throws when service is not initialised', async () => {
        const svc = new TodoistService();
        await assert.rejects(
            () => svc.createLabel('x'),
            /not initialised/,
        );
    });
});
