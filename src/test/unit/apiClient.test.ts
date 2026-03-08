/**
 * Unit tests for TodoistApiClient.
 *
 * All network calls are intercepted by replacing the global `fetch` with a
 * controllable spy before each test.
 */

// Must be first — patches Node's module loader to intercept 'vscode'
import '../helpers/stubs';

import * as assert from 'assert';
import { TodoistApiClient } from '../../todoist/apiClient';

// ---------------------------------------------------------------------------
// fetch spy helpers
// ---------------------------------------------------------------------------

type FetchResponse = {
    ok: boolean;
    status: number;
    headers: { get: (k: string) => string | null };
    json: () => Promise<unknown>;
    text: () => Promise<string>;
};

function mockFetch(handler: (url: string, init?: RequestInit) => FetchResponse) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string, init?: RequestInit) => handler(url, init);
}

function jsonResponse(body: unknown, status = 200): FetchResponse {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

function emptyResponse(status = 204): FetchResponse {
    return {
        ok: true,
        status,
        headers: { get: (k: string) => (k === 'content-length' ? '0' : null) },
        json: async () => null,
        text: async () => '',
    };
}

function errorResponse(status: number): FetchResponse {
    return {
        ok: false,
        status,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => '',
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TOKEN = 'test-token';

describe('TodoistApiClient — authentication', () => {
    it('sends Authorization: Bearer header on every request', async () => {
        let capturedHeader: string | undefined;
        mockFetch((_url, init) => {
            capturedHeader = (init?.headers as Record<string, string>)?.['Authorization'];
            return jsonResponse({ results: [], next_cursor: null });
        });

        const client = new TodoistApiClient(TOKEN);
        await client.getProjects();
        assert.strictEqual(capturedHeader, `Bearer ${TOKEN}`);
    });
});

// ---------------------------------------------------------------------------

describe('TodoistApiClient — getProjects / pagination', () => {
    it('returns all results from a single page', async () => {
        const proj = { id: 'p1', name: 'Work' };
        mockFetch(() => jsonResponse({ results: [proj], next_cursor: null }));

        const client = new TodoistApiClient(TOKEN);
        const projects = await client.getProjects();
        assert.strictEqual(projects.length, 1);
        assert.strictEqual(projects[0].id, 'p1');
    });

    it('follows next_cursor across multiple pages', async () => {
        let callCount = 0;
        mockFetch((url) => {
            callCount++;
            if (callCount === 1) {
                // First page — return cursor
                assert.ok(!url.includes('cursor='), 'First call must not include cursor');
                return jsonResponse({ results: [{ id: 'p1' }], next_cursor: 'cursor-abc' });
            }
            // Second page — must include cursor
            assert.ok(url.includes('cursor=cursor-abc'));
            return jsonResponse({ results: [{ id: 'p2' }], next_cursor: null });
        });

        const client = new TodoistApiClient(TOKEN);
        const projects = await client.getProjects();
        assert.strictEqual(projects.length, 2);
        assert.strictEqual(callCount, 2);
    });

    it('throws on non-OK response', async () => {
        mockFetch(() => errorResponse(401));
        const client = new TodoistApiClient(TOKEN);
        await assert.rejects(() => client.getProjects(), /401/);
    });
});

// ---------------------------------------------------------------------------

describe('TodoistApiClient — getTasks', () => {
    it('passes project_id query param when provided', async () => {
        let capturedUrl = '';
        mockFetch((url) => {
            capturedUrl = url;
            return jsonResponse({ results: [], next_cursor: null });
        });

        const client = new TodoistApiClient(TOKEN);
        await client.getTasks('my-project-id');
        assert.ok(capturedUrl.includes('project_id=my-project-id'));
    });

    it('omits project_id when not provided', async () => {
        let capturedUrl = '';
        mockFetch((url) => {
            capturedUrl = url;
            return jsonResponse({ results: [], next_cursor: null });
        });

        const client = new TodoistApiClient(TOKEN);
        await client.getTasks();
        assert.ok(!capturedUrl.includes('project_id'));
    });
});

// ---------------------------------------------------------------------------

describe('TodoistApiClient — createTask', () => {
    it('POSTs to /tasks with correct body', async () => {
        let capturedBody: unknown;
        const created = { id: 'new-t', content: 'My task', project_id: 'p1' };
        mockFetch((_url, init) => {
            capturedBody = JSON.parse(init?.body as string);
            return jsonResponse(created);
        });

        const client = new TodoistApiClient(TOKEN);
        const task = await client.createTask({ content: 'My task', project_id: 'p1', priority: 4 });

        assert.deepStrictEqual((capturedBody as Record<string, unknown>)['content'], 'My task');
        assert.deepStrictEqual((capturedBody as Record<string, unknown>)['priority'], 4);
        assert.strictEqual(task.id, 'new-t');
    });
});

// ---------------------------------------------------------------------------

describe('TodoistApiClient — updateTask', () => {
    it('POSTs to /tasks/:id with updated fields', async () => {
        let capturedUrl = '';
        let capturedBody: unknown;
        const updated = { id: 't1', content: 'Updated' };
        mockFetch((url, init) => {
            capturedUrl = url;
            capturedBody = JSON.parse(init?.body as string);
            return jsonResponse(updated);
        });

        const client = new TodoistApiClient(TOKEN);
        await client.updateTask('t1', { content: 'Updated', priority: 3 });

        assert.ok(capturedUrl.endsWith('/tasks/t1'));
        assert.strictEqual((capturedBody as Record<string, unknown>)['content'], 'Updated');
    });
});

// ---------------------------------------------------------------------------

describe('TodoistApiClient — closeTask / reopenTask', () => {
    it('closeTask POSTs to /tasks/:id/close and handles 204', async () => {
        let capturedUrl = '';
        mockFetch((url) => { capturedUrl = url; return emptyResponse(204); });

        const client = new TodoistApiClient(TOKEN);
        await assert.doesNotReject(() => client.closeTask('t99'));
        assert.ok(capturedUrl.endsWith('/tasks/t99/close'));
    });

    it('reopenTask POSTs to /tasks/:id/reopen and handles 204', async () => {
        let capturedUrl = '';
        mockFetch((url) => { capturedUrl = url; return emptyResponse(204); });

        const client = new TodoistApiClient(TOKEN);
        await assert.doesNotReject(() => client.reopenTask('t99'));
        assert.ok(capturedUrl.endsWith('/tasks/t99/reopen'));
    });
});

// ---------------------------------------------------------------------------

describe('TodoistApiClient — deleteTask', () => {
    it('sends DELETE to /tasks/:id', async () => {
        let capturedMethod = '';
        let capturedUrl = '';
        mockFetch((url, init) => {
            capturedUrl = url;
            capturedMethod = init?.method ?? '';
            return emptyResponse(200);
        });

        const client = new TodoistApiClient(TOKEN);
        await client.deleteTask('del-me');
        assert.ok(capturedUrl.endsWith('/tasks/del-me'));
        assert.strictEqual(capturedMethod, 'DELETE');
    });

    it('throws on non-OK response', async () => {
        mockFetch(() => errorResponse(404));
        const client = new TodoistApiClient(TOKEN);
        await assert.rejects(() => client.deleteTask('x'), /404/);
    });
});

// ---------------------------------------------------------------------------

describe('TodoistApiClient — moveTask', () => {
    it('POSTs to /tasks/:id/move with project_id', async () => {
        let capturedUrl = '';
        let capturedBody: Record<string, unknown>;
        const moved = { id: 't1', project_id: 'p2', parent_id: null, content: 'Task' };
        mockFetch((url, init) => {
            capturedUrl = url;
            capturedBody = JSON.parse(init?.body as string);
            return jsonResponse(moved);
        });

        const client = new TodoistApiClient(TOKEN);
        const result = await client.moveTask('t1', { project_id: 'p2' });

        assert.ok(capturedUrl.endsWith('/tasks/t1/move'));
        assert.strictEqual(capturedBody!['project_id'], 'p2');
        assert.strictEqual(result.id, 't1');
        assert.strictEqual(result.project_id, 'p2');
    });

    it('POSTs with parent_id to make a subtask', async () => {
        let capturedBody: Record<string, unknown>;
        mockFetch((_url, init) => {
            capturedBody = JSON.parse(init?.body as string);
            return jsonResponse({ id: 't2', project_id: 'p1', parent_id: 'parent-task' });
        });

        const client = new TodoistApiClient(TOKEN);
        await client.moveTask('t2', { parent_id: 'parent-task' });

        assert.strictEqual(capturedBody!['parent_id'], 'parent-task');
    });

    it('sends parent_id: null to promote to top-level', async () => {
        let capturedBody: Record<string, unknown>;
        mockFetch((_url, init) => {
            capturedBody = JSON.parse(init?.body as string);
            return jsonResponse({ id: 't3', project_id: 'p1', parent_id: null });
        });

        const client = new TodoistApiClient(TOKEN);
        await client.moveTask('t3', { parent_id: null });

        assert.strictEqual(capturedBody!['parent_id'], null);
    });

    it('throws on non-OK response', async () => {
        mockFetch(() => errorResponse(404));
        const client = new TodoistApiClient(TOKEN);
        await assert.rejects(() => client.moveTask('bad', {}), /404/);
    });
});

// ---------------------------------------------------------------------------

describe('TodoistApiClient — getLabels', () => {
    it('merges personal and shared labels, deduplicates, and sorts', async () => {
        let callCount = 0;
        mockFetch((url) => {
            callCount++;
            if (url.includes('/labels/shared')) {
                return jsonResponse({ results: ['work', 'home'], next_cursor: null });
            }
            // Personal labels endpoint
            return jsonResponse({
                results: [
                    { id: '1', name: 'urgent', color: 'red', order: 1, is_favorite: false },
                    { id: '2', name: 'work',   color: 'blue', order: 2, is_favorite: false },
                ],
                next_cursor: null,
            });
        });

        const client = new TodoistApiClient(TOKEN);
        const labels = await client.getLabels();

        assert.strictEqual(callCount, 2);
        // 'work' appears in both — should be deduplicated
        assert.deepStrictEqual(labels, ['home', 'urgent', 'work']);
    });

    it('returns sorted list when only personal labels exist', async () => {
        mockFetch((url) => {
            if (url.includes('/labels/shared')) {
                return jsonResponse({ results: [], next_cursor: null });
            }
            return jsonResponse({
                results: [
                    { id: '2', name: 'zebra',  color: 'red', order: 2, is_favorite: false },
                    { id: '1', name: 'alpha',  color: 'red', order: 1, is_favorite: false },
                ],
                next_cursor: null,
            });
        });

        const client = new TodoistApiClient(TOKEN);
        const labels = await client.getLabels();
        assert.deepStrictEqual(labels, ['alpha', 'zebra']);
    });

    it('returns empty array when no labels exist', async () => {
        mockFetch(() => jsonResponse({ results: [], next_cursor: null }));
        const client = new TodoistApiClient(TOKEN);
        const labels = await client.getLabels();
        assert.deepStrictEqual(labels, []);
    });
});

// ---------------------------------------------------------------------------

describe('TodoistApiClient — createLabel', () => {
    it('POSTs to /labels with the given name', async () => {
        let capturedUrl = '';
        let capturedBody: Record<string, unknown>;
        const created = { id: 'lbl-1', name: 'my-label', color: 'red', order: 1, is_favorite: false };
        mockFetch((url, init) => {
            capturedUrl = url;
            capturedBody = JSON.parse(init?.body as string);
            return jsonResponse(created);
        });

        const client = new TodoistApiClient(TOKEN);
        const label = await client.createLabel('my-label');

        assert.ok(capturedUrl.endsWith('/labels'));
        assert.strictEqual(capturedBody!['name'], 'my-label');
        assert.strictEqual(label.id, 'lbl-1');
        assert.strictEqual(label.name, 'my-label');
    });

    it('throws on non-OK response', async () => {
        mockFetch(() => errorResponse(400));
        const client = new TodoistApiClient(TOKEN);
        await assert.rejects(() => client.createLabel('bad'), /400/);
    });
});
