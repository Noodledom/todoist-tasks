/**
 * Unit tests for the Copilot Language Model Tools (todoistTools.ts).
 *
 * We stub `vscode` (via helpers/stubs) and inject a fake TodoistService so
 * all tool logic can be exercised without a real extension host or network.
 */

// Must be first — patches Node's module loader to intercept 'vscode'
import '../helpers/stubs';
import { makeRawTask, makeRawProject, resetIdCounter } from '../helpers/stubs';

import * as assert from 'assert';
import * as vscode from 'vscode';
import { TodoistService } from '../../todoist/todoistService';
import {
    ListTasksTool,
    CreateTaskTool,
    UpdateTaskTool,
    CompleteTaskTool,
    DeleteTaskTool,
} from '../../tools/todoistTools';
import { TodoistTask, TodoistProject } from '../../todoist/types';

// ---------------------------------------------------------------------------
// Fake CancellationToken (never cancelled)
// ---------------------------------------------------------------------------
const neverCancelled = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as vscode.CancellationToken;

// ---------------------------------------------------------------------------
// Typed invoke helpers — avoid repeating ugly casts at every call site
// ---------------------------------------------------------------------------

function callInvoke<T>(
    tool: vscode.LanguageModelTool<T>,
    input: T
): Promise<vscode.LanguageModelToolResult> {
    const options = { input, toolInvocationToken: undefined } as unknown as vscode.LanguageModelToolInvocationOptions<T>;
    return tool.invoke(options, neverCancelled) as Promise<vscode.LanguageModelToolResult>;
}

function callPrepare<T>(
    tool: vscode.LanguageModelTool<T>,
    input: T
) {
    const options = { input } as unknown as vscode.LanguageModelToolInvocationPrepareOptions<T>;
    return tool.prepareInvocation!(options, neverCancelled);
}

// ---------------------------------------------------------------------------
// Helper: build an initialised TodoistService backed by in-memory data
// ---------------------------------------------------------------------------

class FakeApiClient {
    projects: TodoistProject[] = [];
    tasks: TodoistTask[]       = [];

    async getProjects() { return [...this.projects]; }
    async getTasks()    { return [...this.tasks]; }

    async createTask(params: {
        content: string; description?: string; project_id?: string;
        priority?: number; due_date?: string; labels?: string[];
    }): Promise<TodoistTask> {
        const raw = makeRawTask({
            content:    params.content,
            project_id: params.project_id ?? this.projects[0]?.id ?? 'p1',
            priority:   params.priority ?? 1,
            due:        params.due_date ? { date: params.due_date, is_recurring: false } : null,
            labels:     params.labels ?? [],
            description: params.description ?? '',
        });
        // Do NOT push to this.tasks here — TodoistService.createTask will push
        // the returned raw into store.tasks itself.
        return raw;
    }

    async updateTask(id: string, params: {
        content?: string; priority?: number; due_date?: string;
        due_string?: string; labels?: string[]; description?: string;
    }): Promise<TodoistTask> {
        const raw = this.tasks.find(t => t.id === id)!;
        if (params.content !== undefined)     { raw.content     = params.content; }
        if (params.priority !== undefined)    { raw.priority    = params.priority; }
        if (params.labels !== undefined)      { raw.labels      = params.labels; }
        if (params.description !== undefined) { raw.description = params.description; }
        if (params.due_date)                  { raw.due = { date: params.due_date, is_recurring: false }; }
        if (params.due_string === 'no date')  { raw.due = null; }
        return raw;
    }

    async closeTask(id: string)  { const t = this.tasks.find(r => r.id === id); if (t) { t.checked = true; } }
    async reopenTask(id: string) { const t = this.tasks.find(r => r.id === id); if (t) { t.checked = false; } }
    async deleteTask(id: string) { this.tasks = this.tasks.filter(r => r.id !== id); }
}

function buildService(
    projects: TodoistProject[],
    tasks: TodoistTask[]
): TodoistService {
    const client = new FakeApiClient();
    client.projects = projects;
    client.tasks    = tasks;

    const svc = new TodoistService(9999);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).client = client;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).store  = { projects, tasks };
    return svc;
}

/** Convenience: extract the text content from a LanguageModelToolResult */
function resultText(result: vscode.LanguageModelToolResult): string {
    // Our fake LanguageModelToolResult exposes .text() 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (result as any).text() as string;
}

// ---------------------------------------------------------------------------
// Not-initialised guard (shared across all write tools)
// ---------------------------------------------------------------------------

describe('All tools — not-initialised guard', () => {
    let uninitSvc: TodoistService;

    before(() => { uninitSvc = new TodoistService(); });

    const tools = [
        () => new ListTasksTool(uninitSvc),
        () => new CreateTaskTool(uninitSvc),
        () => new UpdateTaskTool(uninitSvc),
        () => new CompleteTaskTool(uninitSvc),
        () => new DeleteTaskTool(uninitSvc),
    ];

    const inputs = [
        {},
        { title: 'x' },
        { task_id: 'x' },
        { task_id: 'x' },
        { task_id: 'x' },
    ];

    tools.forEach((makeTool, i) => {
        it(`${makeTool().constructor.name} returns not-initialised message`, async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = await callInvoke(makeTool() as any, inputs[i]);
            assert.ok(resultText(result).includes('not initialised'));
        });
    });
});

// ---------------------------------------------------------------------------
// ListTasksTool
// ---------------------------------------------------------------------------

describe('ListTasksTool — invoke', () => {
    beforeEach(() => resetIdCounter(1));

    it('returns all incomplete tasks when no filters', async () => {
        const proj = makeRawProject({ id: 'p1', name: 'Work' });
        const t1   = makeRawTask({ id: 't1', project_id: 'p1', content: 'Alpha', checked: false });
        const t2   = makeRawTask({ id: 't2', project_id: 'p1', content: 'Beta',  checked: false });
        const svc  = buildService([proj], [t1, t2]);

        const tool = new ListTasksTool(svc);
        const result = await callInvoke(tool, {});
        const text = resultText(result);
        assert.ok(text.includes('Alpha'));
        assert.ok(text.includes('Beta'));
    });

    it('returns "no tasks" message when nothing matches', async () => {
        const proj = makeRawProject({ id: 'p1', name: 'Work' });
        const svc  = buildService([proj], []);

        const result = await callInvoke(new ListTasksTool(svc), {});
        assert.ok(resultText(result).includes('No tasks found'));
    });

    it('filters by project name (partial match)', async () => {
        const work  = makeRawProject({ id: 'p1', name: 'Work' });
        const home  = makeRawProject({ id: 'p2', name: 'Home' });
        const tWork = makeRawTask({ id: 't1', project_id: 'p1', content: 'Work task' });
        const tHome = makeRawTask({ id: 't2', project_id: 'p2', content: 'Home task' });
        const svc   = buildService([work, home], [tWork, tHome]);

        const result = await callInvoke(new ListTasksTool(svc), { project: 'ork' });
        const text = resultText(result);
        assert.ok(text.includes('Work task'));
        assert.ok(!text.includes('Home task'));
    });

    it('filters by priority', async () => {
        const proj  = makeRawProject({ id: 'p1', name: 'P' });
        const high  = makeRawTask({ id: 't1', project_id: 'p1', content: 'High task', priority: 4 });
        const low   = makeRawTask({ id: 't2', project_id: 'p1', content: 'Low task',  priority: 2 });
        const svc   = buildService([proj], [high, low]);

        const result = await callInvoke(new ListTasksTool(svc), { priority: 'high' });
        const text = resultText(result);
        assert.ok(text.includes('High task'));
        assert.ok(!text.includes('Low task'));
    });

    it('filters by due_before date', async () => {
        const proj  = makeRawProject({ id: 'p1', name: 'P' });
        const early = makeRawTask({ id: 't1', project_id: 'p1', content: 'Early', due: { date: '2026-03-01', is_recurring: false } });
        const late  = makeRawTask({ id: 't2', project_id: 'p1', content: 'Late',  due: { date: '2026-05-01', is_recurring: false } });
        const svc   = buildService([proj], [early, late]);

        const result = await callInvoke(new ListTasksTool(svc), { due_before: '2026-04-01' });
        const text = resultText(result);
        assert.ok(text.includes('Early'));
        assert.ok(!text.includes('Late'));
    });

    it('respects the limit parameter', async () => {
        const proj  = makeRawProject({ id: 'p1', name: 'P' });
        const tasks = Array.from({ length: 10 }, (_, i) =>
            makeRawTask({ id: `t${i}`, project_id: 'p1', content: `Task ${i}` })
        );
        const svc = buildService([proj], tasks);

        const result = await callInvoke(new ListTasksTool(svc), { limit: 3 });
        const text = resultText(result);
        assert.ok(text.includes('Found 3 task(s)'));
    });

    it('includes completed tasks when include_completed=true', async () => {
        const proj = makeRawProject({ id: 'p1', name: 'P' });
        const done = makeRawTask({ id: 't1', project_id: 'p1', content: 'Done', checked: true });
        const svc  = buildService([proj], [done]);

        const result = await callInvoke(new ListTasksTool(svc), { include_completed: true });
        assert.ok(resultText(result).includes('Done'));
    });

    it('outputs task ID, project name, due date, priority, labels', async () => {
        const proj = makeRawProject({ id: 'p1', name: 'My Project' });
        const raw  = makeRawTask({
            id: 'task-abc',
            project_id: 'p1',
            content: 'Rich task',
            priority: 3,
            due: { date: '2026-04-15', is_recurring: false },
            labels: ['alpha', 'beta'],
        });
        const svc = buildService([proj], [raw]);

        const result = await callInvoke(new ListTasksTool(svc), {});
        const text = resultText(result);
        assert.ok(text.includes('[task-abc]'));
        assert.ok(text.includes('My Project'));
        assert.ok(text.includes('2026-04-15'));
        assert.ok(text.includes('medium'));
        assert.ok(text.includes('alpha, beta'));
    });
});

// ---------------------------------------------------------------------------
// CreateTaskTool
// ---------------------------------------------------------------------------

describe('CreateTaskTool — invoke', () => {
    beforeEach(() => resetIdCounter(1));

    it('creates a task with title in the first project when no project specified', async () => {
        const proj = makeRawProject({ id: 'p1', name: 'Inbox' });
        const svc  = buildService([proj], []);

        const result = await callInvoke(new CreateTaskTool(svc), { title: 'Buy coffee' });
        assert.ok(resultText(result).includes('Task created'));
        assert.ok(resultText(result).includes('Buy coffee'));
        assert.strictEqual(svc.getTasks().length, 1);
        assert.strictEqual(svc.getTasks()[0].title, 'Buy coffee');
    });

    it('resolves project by partial name match', async () => {
        const work = makeRawProject({ id: 'p1', name: 'Work Projects' });
        const home = makeRawProject({ id: 'p2', name: 'Home' });
        const svc  = buildService([work, home], []);

        await callInvoke(new CreateTaskTool(svc), { title: 'Sprint task', project: 'Work' });
        assert.strictEqual(svc.getTasks()[0].collectionId, 'p1');
    });

    it('returns error when project name not found', async () => {
        const proj = makeRawProject({ id: 'p1', name: 'Work' });
        const svc  = buildService([proj], []);

        const result = await callInvoke(new CreateTaskTool(svc), { title: 'Oops', project: 'NonExistent' });
        assert.ok(resultText(result).includes('not found'));
        assert.ok(resultText(result).includes('Work')); // lists available projects
    });

    it('returns error when no projects exist', async () => {
        const svc = buildService([], []);
        const result = await callInvoke(new CreateTaskTool(svc), { title: 'Oops' });
        assert.ok(resultText(result).includes('No projects found'));
    });

    it('passes due_date, priority, labels and description', async () => {
        const proj = makeRawProject({ id: 'p1', name: 'Work' });
        const svc  = buildService([proj], []);

        await callInvoke(new CreateTaskTool(svc), {
            title: 'Full task',
            due_date: '2026-05-01',
            priority: 'high',
            labels: 'alpha, beta',
            description: 'details here',
        });
        const task = svc.getTasks()[0];
        assert.strictEqual(task.dueDate, '2026-05-01');
        assert.strictEqual(task.priority, 'high');
        assert.deepStrictEqual(task.tags, ['alpha', 'beta']);
        assert.strictEqual(task.description, 'details here');
    });

    it('prepareInvocation returns invocationMessage and confirmationMessages', async () => {
        const proj = makeRawProject({ id: 'p1', name: 'Work' });
        const svc  = buildService([proj], []);

        const prep = await callPrepare(new CreateTaskTool(svc), { title: 'New task', project: 'Work', due_date: '2026-05-01', priority: 'high', labels: 'work' });
        assert.ok((prep?.invocationMessage as string | undefined)?.includes('New task'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        assert.ok((prep?.confirmationMessages?.message as any).value.includes('New task'));
    });
});

// ---------------------------------------------------------------------------
// UpdateTaskTool
// ---------------------------------------------------------------------------

describe('UpdateTaskTool — invoke', () => {
    beforeEach(() => resetIdCounter(1));

    it('updates title of an existing task', async () => {
        const proj = makeRawProject({ id: 'p1', name: 'P' });
        const raw  = makeRawTask({ id: 'task1', project_id: 'p1', content: 'Old title' });
        const svc  = buildService([proj], [raw]);

        const result = await callInvoke(new UpdateTaskTool(svc), { task_id: 'task1', title: 'New title' });
        assert.ok(resultText(result).includes('updated successfully'));
        assert.strictEqual(svc.getTask('task1')?.title, 'New title');
    });

    it('clears due date when due_date is empty string', async () => {
        const proj = makeRawProject({ id: 'p1', name: 'P' });
        const raw  = makeRawTask({ id: 'task1', project_id: 'p1', due: { date: '2026-03-01', is_recurring: false } });
        const svc  = buildService([proj], [raw]);

        await callInvoke(new UpdateTaskTool(svc), { task_id: 'task1', due_date: '' });
        assert.strictEqual(svc.getTask('task1')?.dueDate, undefined);
    });

    it('clears labels when labels is empty string', async () => {
        const proj = makeRawProject({ id: 'p1', name: 'P' });
        const raw  = makeRawTask({ id: 'task1', project_id: 'p1', labels: ['work', 'urgent'] });
        const svc  = buildService([proj], [raw]);

        await callInvoke(new UpdateTaskTool(svc), { task_id: 'task1', labels: '' });
        assert.deepStrictEqual(svc.getTask('task1')?.tags, []);
    });

    it('preserves unchanged fields when only one field is updated', async () => {
        const proj = makeRawProject({ id: 'p1', name: 'P' });
        const raw  = makeRawTask({ id: 'task1', project_id: 'p1', content: 'Keep me', priority: 4, labels: ['keep'] });
        const svc  = buildService([proj], [raw]);

        await callInvoke(new UpdateTaskTool(svc), { task_id: 'task1', due_date: '2026-06-01' });
        const t = svc.getTask('task1')!;
        assert.strictEqual(t.title, 'Keep me');
        assert.strictEqual(t.priority, 'high');
        assert.deepStrictEqual(t.tags, ['keep']);
    });

    it('returns error for unknown task_id', async () => {
        const svc = buildService([], []);
        const result = await callInvoke(new UpdateTaskTool(svc), { task_id: 'ghost' });
        assert.ok(resultText(result).includes('not found'));
    });
});

// ---------------------------------------------------------------------------
// CompleteTaskTool
// ---------------------------------------------------------------------------

describe('CompleteTaskTool — invoke', () => {
    beforeEach(() => resetIdCounter(1));

    it('marks a task as complete', async () => {
        const proj = makeRawProject({ id: 'p1', name: 'P' });
        const raw  = makeRawTask({ id: 'task1', project_id: 'p1', content: 'Finish me' });
        const svc  = buildService([proj], [raw]);

        const result = await callInvoke(new CompleteTaskTool(svc), { task_id: 'task1' });
        assert.ok(resultText(result).includes('marked as complete'));
        assert.strictEqual(svc.getTask('task1')?.completed, true);
    });

    it('also completes subtasks when include_subtasks=true', async () => {
        const proj   = makeRawProject({ id: 'p1', name: 'P' });
        const parent = makeRawTask({ id: 'parent', project_id: 'p1' });
        const child  = makeRawTask({ id: 'child',  project_id: 'p1', parent_id: 'parent' });
        const svc    = buildService([proj], [parent, child]);

        await callInvoke(new CompleteTaskTool(svc), { task_id: 'parent', include_subtasks: true });
        assert.strictEqual(svc.getTask('parent')?.completed, true);
        assert.strictEqual(svc.getTask('child')?.completed, true);
    });

    it('does not complete subtasks by default', async () => {
        const proj   = makeRawProject({ id: 'p1', name: 'P' });
        const parent = makeRawTask({ id: 'parent', project_id: 'p1' });
        const child  = makeRawTask({ id: 'child',  project_id: 'p1', parent_id: 'parent' });
        const svc    = buildService([proj], [parent, child]);

        await callInvoke(new CompleteTaskTool(svc), { task_id: 'parent' });
        assert.strictEqual(svc.getTask('child')?.completed, false);
    });

    it('returns error for unknown task_id', async () => {
        const svc    = buildService([], []);
        const result = await callInvoke(new CompleteTaskTool(svc), { task_id: 'ghost' });
        assert.ok(resultText(result).includes('not found'));
    });

    it('prepareInvocation mentions task title and subtask note', async () => {
        const proj = makeRawProject({ id: 'p1', name: 'P' });
        const raw  = makeRawTask({ id: 'task1', project_id: 'p1', content: 'My task' });
        const svc  = buildService([proj], [raw]);

        const prep = await callPrepare(new CompleteTaskTool(svc), { task_id: 'task1', include_subtasks: true });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = (prep?.confirmationMessages?.message as any).value as string;
        assert.ok(msg.includes('My task'));
        assert.ok(msg.includes('subtask'));
    });
});

// ---------------------------------------------------------------------------
// DeleteTaskTool
// ---------------------------------------------------------------------------

describe('DeleteTaskTool — invoke', () => {
    beforeEach(() => resetIdCounter(1));

    it('deletes a task and returns success message', async () => {
        const proj = makeRawProject({ id: 'p1', name: 'P' });
        const raw  = makeRawTask({ id: 'del1', project_id: 'p1', content: 'Delete me' });
        const svc  = buildService([proj], [raw]);

        const result = await callInvoke(new DeleteTaskTool(svc), { task_id: 'del1' });
        assert.ok(resultText(result).includes('deleted'));
        assert.ok(resultText(result).includes('Delete me'));
        assert.strictEqual(svc.getTask('del1'), undefined);
    });

    it('returns error for unknown task_id', async () => {
        const svc    = buildService([], []);
        const result = await callInvoke(new DeleteTaskTool(svc), { task_id: 'ghost' });
        assert.ok(resultText(result).includes('not found'));
    });

    it('prepareInvocation mentions task title and undone warning', async () => {
        const proj = makeRawProject({ id: 'p1', name: 'P' });
        const raw  = makeRawTask({ id: 'del1', project_id: 'p1', content: 'Important task' });
        const svc  = buildService([proj], [raw]);

        const prep = await callPrepare(new DeleteTaskTool(svc), { task_id: 'del1' });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = (prep?.confirmationMessages?.message as any).value as string;
        assert.ok(msg.includes('Important task'));
        assert.ok(msg.includes('cannot be undone'));
    });
});
