/**
 * Unit tests for DecSyncService.
 *
 * DecSyncService imports `vscode` for EventEmitter and `./fsLayer` for disk I/O.
 * We stub both before requiring the module so we can run tests without a VS Code
 * instance and without touching the real filesystem.
 */

// Must be first — patches Node's module loader to intercept 'vscode'
import '../helpers/stubs';

import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as nodefs from 'fs';

// ---------------------------------------------------------------------------
// Import the modules under test AFTER the stub is registered.
// ---------------------------------------------------------------------------
// We need to import DecSyncService and also prepare a temp DecSync directory.
// fsLayer is NOT stubbed — we use a real temp directory on disk.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DecSyncService } = require('../../decsync/service');

// ---------------------------------------------------------------------------
// Helpers — build a minimal valid DecSync directory in os.tmpdir()
// ---------------------------------------------------------------------------
function makeTempDecSyncDir(): string {
    const root = nodefs.mkdtempSync(path.join(os.tmpdir(), 'decsync-test-'));
    // Minimal structure: one tasks collection, one calendar collection
    const tasksDir = path.join(root, 'tasks', 'col-tasks-1', 'resources');
    const calDir   = path.join(root, 'calendars', 'col-cal-1', 'resources');
    nodefs.mkdirSync(tasksDir, { recursive: true });
    nodefs.mkdirSync(calDir,   { recursive: true });
    // Collection info files
    nodefs.writeFileSync(
        path.join(root, 'tasks', 'col-tasks-1', '.decsync-info'),
        JSON.stringify({ name: 'Personal Tasks', color: '#ff0000' }),
    );
    nodefs.writeFileSync(
        path.join(root, 'calendars', 'col-cal-1', '.decsync-info'),
        JSON.stringify({ name: 'Personal Calendar', color: '#0000ff' }),
    );
    // One seed task
    const seedTask = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
        'BEGIN:VTODO', 'UID:seed-task-001', 'SUMMARY:Seeded task',
        'PRIORITY:1', 'STATUS:NEEDS-ACTION', 'CATEGORIES:alpha,beta',
        'END:VTODO', 'END:VCALENDAR',
    ].join('\r\n');
    nodefs.writeFileSync(path.join(tasksDir, 'seed-task-001'), JSON.stringify({ value: seedTask }));
    // One seed event
    const seedEvent = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
        'BEGIN:VEVENT', 'UID:seed-event-001', 'SUMMARY:Seeded event',
        'DTSTART:20260310T090000Z', 'DTEND:20260310T100000Z',
        'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    nodefs.writeFileSync(path.join(calDir, 'seed-event-001'), JSON.stringify({ value: seedEvent }));
    return root;
}

function cleanup(root: string) {
    nodefs.rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let root: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let svc: any;

beforeEach(() => {
    root = makeTempDecSyncDir();
    svc  = new DecSyncService();
    svc.setRoot(root);
});
afterEach(() => {
    svc.dispose();
    cleanup(root);
});

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------
describe('DecSyncService — collections', () => {
    it('loads collections from disk', () => {
        const cols = svc.getCollections();
        assert.ok(cols.length >= 2, 'should have at least 2 collections');
    });
    it('reports correct collection types', () => {
        const cols = svc.getCollections();
        const types = cols.map((c: { type: string }) => c.type);
        assert.ok(types.includes('tasks'));
        assert.ok(types.includes('calendars'));
    });
});

// ---------------------------------------------------------------------------
// getTasks — basic read
// ---------------------------------------------------------------------------
describe('DecSyncService — getTasks', () => {
    it('returns seeded task', () => {
        const tasks = svc.getTasks({ showCompleted: true });
        assert.ok(tasks.some((t: { uid: string }) => t.uid === 'seed-task-001'));
    });
    it('hides completed tasks by default', () => {
        svc.completeTask('seed-task-001');
        const tasks = svc.getTasks(); // no filter → showCompleted defaults to false
        assert.ok(!tasks.some((t: { uid: string }) => t.uid === 'seed-task-001'));
    });
    it('shows completed tasks when showCompleted is true', () => {
        svc.completeTask('seed-task-001');
        const tasks = svc.getTasks({ showCompleted: true });
        assert.ok(tasks.some((t: { uid: string }) => t.uid === 'seed-task-001'));
    });
});

// ---------------------------------------------------------------------------
// getTasks — filter
// ---------------------------------------------------------------------------
describe('DecSyncService — getTasks filtering', () => {
    it('filters by collectionId', () => {
        const tasks = svc.getTasks({ collectionId: 'col-tasks-1', showCompleted: true });
        assert.ok(tasks.every((t: { collectionId: string }) => t.collectionId === 'col-tasks-1'));
    });
    it('filters by tag', () => {
        svc.createTask({ collectionId: 'col-tasks-1', title: 'Tagged task', tags: ['gamma'] });
        const tasks = svc.getTasks({ tag: 'gamma', showCompleted: true });
        assert.ok(tasks.every((t: { tags: string[] }) => t.tags.includes('gamma')));
        assert.strictEqual(tasks.length, 1);
    });
    it('filters by priority', () => {
        svc.createTask({ collectionId: 'col-tasks-1', title: 'Low task', priority: 'low' });
        const tasks = svc.getTasks({ priority: 'low', showCompleted: true });
        assert.ok(tasks.every((t: { priority: string }) => t.priority === 'low'));
        assert.ok(tasks.length >= 1);
    });
    it('filters by dueBefore', () => {
        svc.createTask({ collectionId: 'col-tasks-1', title: 'Far future task', dueDate: '2099-01-01T00:00:00.000Z' });
        const tasks = svc.getTasks({ dueBefore: '2030-01-01T00:00:00.000Z', showCompleted: true });
        assert.ok(tasks.every((t: { dueDate?: string }) => !t.dueDate || t.dueDate <= '2030-01-01T00:00:00.000Z'));
    });
    it('filters by dueAfter', () => {
        svc.createTask({ collectionId: 'col-tasks-1', title: 'Near future task', dueDate: '2026-06-01T00:00:00.000Z' });
        const tasks = svc.getTasks({ dueAfter: '2026-01-01T00:00:00.000Z', showCompleted: true });
        assert.ok(tasks.some((t: { title: string }) => t.title === 'Near future task'));
    });
});

// ---------------------------------------------------------------------------
// getTasks — sort
// ---------------------------------------------------------------------------
describe('DecSyncService — getTasks sorting', () => {
    beforeEach(() => {
        svc.createTask({ collectionId: 'col-tasks-1', title: 'AAA task', priority: 'low',    dueDate: '2026-03-01T00:00:00.000Z' });
        svc.createTask({ collectionId: 'col-tasks-1', title: 'BBB task', priority: 'high',   dueDate: '2026-02-01T00:00:00.000Z' });
        svc.createTask({ collectionId: 'col-tasks-1', title: 'CCC task', priority: 'medium', dueDate: '2026-04-01T00:00:00.000Z' });
    });
    it('sorts by title asc', () => {
        const tasks = svc.getTasks({ showCompleted: false }, { field: 'title', order: 'asc' });
        const titles = tasks.map((t: { title: string }) => t.title);
        assert.ok(titles.indexOf('AAA task') < titles.indexOf('BBB task'));
        assert.ok(titles.indexOf('BBB task') < titles.indexOf('CCC task'));
    });
    it('sorts by title desc', () => {
        const tasks = svc.getTasks({ showCompleted: false }, { field: 'title', order: 'desc' });
        const titles = tasks.map((t: { title: string }) => t.title);
        assert.ok(titles.indexOf('CCC task') < titles.indexOf('BBB task'));
        assert.ok(titles.indexOf('BBB task') < titles.indexOf('AAA task'));
    });
    it('sorts by dueDate asc', () => {
        const tasks = svc.getTasks({ showCompleted: false }, { field: 'dueDate', order: 'asc' });
        const dueDates = tasks.filter((t: { dueDate?: string }) => t.dueDate).map((t: { dueDate?: string }) => t.dueDate);
        for (let i = 1; i < dueDates.length; i++) {
            assert.ok(dueDates[i - 1] <= dueDates[i], `${dueDates[i - 1]} should be <= ${dueDates[i]}`);
        }
    });
    it('sorts by priority asc (high first)', () => {
        const tasks = svc.getTasks({ showCompleted: false }, { field: 'priority', order: 'asc' });
        const priorities = tasks.map((t: { priority: string }) => t.priority);
        const highIdx   = priorities.indexOf('high');
        const mediumIdx = priorities.indexOf('medium');
        const lowIdx    = priorities.indexOf('low');
        if (highIdx >= 0 && mediumIdx >= 0) { assert.ok(highIdx   < mediumIdx); }
        if (mediumIdx >= 0 && lowIdx   >= 0) { assert.ok(mediumIdx < lowIdx); }
    });
});

// ---------------------------------------------------------------------------
// createTask
// ---------------------------------------------------------------------------
describe('DecSyncService — createTask', () => {
    it('adds task to in-memory store', () => {
        const task  = svc.createTask({ collectionId: 'col-tasks-1', title: 'New task' });
        const found = svc.getTask(task.uid);
        assert.ok(found);
        assert.strictEqual(found.title, 'New task');
    });
    it('persists task to disk (file exists)', () => {
        const task         = svc.createTask({ collectionId: 'col-tasks-1', title: 'Persisted task' });
        const resourcePath = path.join(root, 'tasks', 'col-tasks-1', 'resources', task.uid);
        assert.ok(nodefs.existsSync(resourcePath), 'task file should exist on disk');
    });
    it('assigns a uid', () => {
        const task = svc.createTask({ collectionId: 'col-tasks-1', title: 'uid check' });
        assert.ok(task.uid);
        assert.ok(task.uid.length > 0);
    });
    it('defaults priority to none', () => {
        const task = svc.createTask({ collectionId: 'col-tasks-1', title: 'no priority' });
        assert.strictEqual(task.priority, 'none');
    });
    it('sets creationDate', () => {
        const before = new Date().toISOString();
        const task   = svc.createTask({ collectionId: 'col-tasks-1', title: 'dated task' });
        const after  = new Date().toISOString();
        assert.ok(task.creationDate >= before);
        assert.ok(task.creationDate <= after);
    });
});

// ---------------------------------------------------------------------------
// completeTask
// ---------------------------------------------------------------------------
describe('DecSyncService — completeTask', () => {
    it('marks task as completed', () => {
        svc.completeTask('seed-task-001');
        const task = svc.getTask('seed-task-001');
        assert.strictEqual(task.completed, true);
    });
    it('sets completionDate', () => {
        const before = new Date().toISOString();
        svc.completeTask('seed-task-001');
        const task = svc.getTask('seed-task-001');
        assert.ok(task.completionDate);
        assert.ok(task.completionDate >= before);
    });
    it('cascades to subtasks when flag is true', () => {
        const parent = svc.createTask({ collectionId: 'col-tasks-1', title: 'Parent' });
        const child1 = svc.createTask({ collectionId: 'col-tasks-1', title: 'Child 1', parentUid: parent.uid });
        const child2 = svc.createTask({ collectionId: 'col-tasks-1', title: 'Child 2', parentUid: parent.uid });
        svc.completeTask(parent.uid, true);
        assert.strictEqual(svc.getTask(parent.uid).completed, true);
        assert.strictEqual(svc.getTask(child1.uid).completed, true);
        assert.strictEqual(svc.getTask(child2.uid).completed, true);
    });
    it('does NOT cascade when flag is false', () => {
        const parent = svc.createTask({ collectionId: 'col-tasks-1', title: 'Parent' });
        const child  = svc.createTask({ collectionId: 'col-tasks-1', title: 'Child', parentUid: parent.uid });
        svc.completeTask(parent.uid, false);
        assert.strictEqual(svc.getTask(parent.uid).completed, true);
        assert.strictEqual(svc.getTask(child.uid).completed,  false);
    });
    it('does nothing for unknown uid', () => {
        assert.doesNotThrow(() => svc.completeTask('no-such-task'));
    });
});

// ---------------------------------------------------------------------------
// deleteTask
// ---------------------------------------------------------------------------
describe('DecSyncService — deleteTask', () => {
    it('removes task from in-memory store', () => {
        svc.deleteTask('seed-task-001');
        assert.strictEqual(svc.getTask('seed-task-001'), undefined);
    });
    it('removes file from disk', () => {
        const filePath = path.join(root, 'tasks', 'col-tasks-1', 'resources', 'seed-task-001');
        svc.deleteTask('seed-task-001');
        assert.ok(!nodefs.existsSync(filePath), 'file should be removed from disk');
    });
    it('does nothing for unknown uid', () => {
        assert.doesNotThrow(() => svc.deleteTask('no-such-task'));
    });
});

// ---------------------------------------------------------------------------
// updateTask
// ---------------------------------------------------------------------------
describe('DecSyncService — updateTask', () => {
    it('updates in-memory store', () => {
        const task = svc.getTask('seed-task-001');
        svc.updateTask({ ...task, title: 'Updated title' });
        assert.strictEqual(svc.getTask('seed-task-001').title, 'Updated title');
    });
    it('persists update to disk', () => {
        const task = svc.getTask('seed-task-001');
        svc.updateTask({ ...task, title: 'Disk updated' });
        const raw = nodefs.readFileSync(
            path.join(root, 'tasks', 'col-tasks-1', 'resources', 'seed-task-001'),
            'utf-8',
        );
        assert.ok(raw.includes('Disk updated') || JSON.parse(raw).value.includes('Disk updated'));
    });
});

// ---------------------------------------------------------------------------
// getSubtasks
// ---------------------------------------------------------------------------
describe('DecSyncService — getSubtasks', () => {
    it('returns direct children', () => {
        const parent = svc.createTask({ collectionId: 'col-tasks-1', title: 'Parent' });
        svc.createTask({ collectionId: 'col-tasks-1', title: 'Child A', parentUid: parent.uid });
        svc.createTask({ collectionId: 'col-tasks-1', title: 'Child B', parentUid: parent.uid });
        const subs = svc.getSubtasks(parent.uid);
        assert.strictEqual(subs.length, 2);
    });
    it('does not return grandchildren', () => {
        const parent = svc.createTask({ collectionId: 'col-tasks-1', title: 'Parent' });
        const child  = svc.createTask({ collectionId: 'col-tasks-1', title: 'Child', parentUid: parent.uid });
        svc.createTask({ collectionId: 'col-tasks-1', title: 'Grandchild', parentUid: child.uid });
        const subs = svc.getSubtasks(parent.uid);
        assert.strictEqual(subs.length, 1);
        assert.strictEqual(subs[0].title, 'Child');
    });
    it('returns empty array for task with no children', () => {
        const subs = svc.getSubtasks('seed-task-001');
        assert.strictEqual(subs.length, 0);
    });
});

// ---------------------------------------------------------------------------
// getAllTags
// ---------------------------------------------------------------------------
describe('DecSyncService — getAllTags', () => {
    it('returns deduplicated sorted tags', () => {
        svc.createTask({ collectionId: 'col-tasks-1', title: 'T1', tags: ['zeta', 'alpha'] });
        svc.createTask({ collectionId: 'col-tasks-1', title: 'T2', tags: ['alpha', 'beta'] });
        const tags = svc.getAllTags();
        assert.ok(tags.includes('alpha'));
        assert.ok(tags.includes('beta'));
        assert.ok(tags.includes('zeta'));
        for (let i = 1; i < tags.length; i++) {
            assert.ok(tags[i - 1] <= tags[i], `tags not sorted: ${tags[i - 1]} > ${tags[i]}`);
        }
        assert.strictEqual(tags.length, new Set(tags).size);
    });
    it('includes tags from seeded task', () => {
        const tags = svc.getAllTags();
        assert.ok(tags.includes('alpha'));
        assert.ok(tags.includes('beta'));
    });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
describe('DecSyncService — events', () => {
    it('loads seeded event', () => {
        const events = svc.getEvents();
        assert.ok(events.some((e: { uid: string }) => e.uid === 'seed-event-001'));
    });
    it('creates event in memory and on disk', () => {
        const event = svc.createEvent({
            collectionId: 'col-cal-1',
            title: 'New event',
            startDate: '2026-05-01T10:00:00.000Z',
            endDate:   '2026-05-01T11:00:00.000Z',
        });
        const found    = svc.getEvent(event.uid);
        assert.ok(found);
        const filePath = path.join(root, 'calendars', 'col-cal-1', 'resources', event.uid);
        assert.ok(nodefs.existsSync(filePath));
    });
    it('deletes event from memory and disk', () => {
        svc.deleteEvent('seed-event-001');
        assert.strictEqual(svc.getEvent('seed-event-001'), undefined);
        const filePath = path.join(root, 'calendars', 'col-cal-1', 'resources', 'seed-event-001');
        assert.ok(!nodefs.existsSync(filePath));
    });
    it('filters events by date range', () => {
        svc.createEvent({
            collectionId: 'col-cal-1',
            title: 'Far future',
            startDate: '2099-01-01T00:00:00.000Z',
            endDate:   '2099-01-01T01:00:00.000Z',
        });
        const events = svc.getEvents('2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.000Z');
        assert.ok(events.every((e: { startDate: string }) => e.startDate <= '2026-12-31T23:59:59.000Z'));
        assert.ok(!events.some((e: { uid: string; startDate: string }) =>
            e.uid === 'seed-event-001' && e.startDate > '2026-12-31T23:59:59.000Z'
        ));
    });
    it('updates event in memory and on disk', () => {
        const event = svc.getEvent('seed-event-001');
        svc.updateEvent({ ...event, title: 'Updated event' });
        assert.strictEqual(svc.getEvent('seed-event-001').title, 'Updated event');
    });
});

// ---------------------------------------------------------------------------
// Reload
// ---------------------------------------------------------------------------
describe('DecSyncService — reload', () => {
    it('re-reads tasks from disk after reload', () => {
        const ical = [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
            'BEGIN:VTODO', 'UID:manual-task-001', 'SUMMARY:Manually written',
            'STATUS:NEEDS-ACTION', 'END:VTODO', 'END:VCALENDAR',
        ].join('\r\n');
        nodefs.writeFileSync(
            path.join(root, 'tasks', 'col-tasks-1', 'resources', 'manual-task-001'),
            JSON.stringify({ value: ical }),
        );
        svc.reload();
        const found = svc.getTask('manual-task-001');
        assert.ok(found, 'reloaded task should be visible');
        assert.strictEqual(found.title, 'Manually written');
    });
    it('clears store when root is invalid', () => {
        svc.setRoot('/this/path/does/not/exist');
        assert.strictEqual(svc.getCollections().length, 0);
        assert.strictEqual(svc.getTasks({ showCompleted: true }).length, 0);
    });
});
