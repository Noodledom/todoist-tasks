/**
 * Shared test stubs.
 *
 * Must be required BEFORE any module that imports 'vscode' so that Node's
 * module cache returns our stub instead of the real extension host module.
 *
 * Usage at the top of each test file:
 *
 *   import './helpers/stubs';   // side-effect: registers vscode stub
 */

// ---------------------------------------------------------------------------
// vscode stub
// ---------------------------------------------------------------------------

class FakeEventEmitter {
    private listeners: Array<(e: unknown) => void> = [];
    event = (listener: (e: unknown) => void) => {
        this.listeners.push(listener);
        return { dispose: () => {} };
    };
    fire(e: unknown) { this.listeners.forEach(l => l(e)); }
    dispose() { this.listeners = []; }
}

/** Minimal MarkdownString that captures the value string */
class FakeMarkdownString {
    value: string;
    constructor(value = '') { this.value = value; }
    appendMarkdown(s: string) { this.value += s; return this; }
    appendText(s: string) { this.value += s; return this; }
    appendCodeblock(s: string) { this.value += s; return this; }
}

/** Minimal LanguageModelTextPart */
class FakeLanguageModelTextPart {
    value: string;
    constructor(value: string) { this.value = value; }
}

/** Minimal LanguageModelToolResult */
class FakeLanguageModelToolResult {
    content: FakeLanguageModelTextPart[];
    constructor(parts: FakeLanguageModelTextPart[]) { this.content = parts; }
    /** Convenience: return concatenated text of all parts */
    text(): string { return this.content.map(p => p.value).join(''); }
}

const _vscodStub = {
    EventEmitter: FakeEventEmitter,
    Disposable: class { dispose() {} },
    MarkdownString: FakeMarkdownString,
    LanguageModelTextPart: FakeLanguageModelTextPart,
    LanguageModelToolResult: FakeLanguageModelToolResult,
    QuickPickItemKind: { Separator: -1 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TreeItem: class {
        label: string;
        collapsibleState: number;
        iconPath: unknown;
        description: unknown;
        tooltip: unknown;
        contextValue: string | undefined;
        command: unknown;
        constructor(label: string, collapsibleState = 0) {
            this.label = label;
            this.collapsibleState = collapsibleState;
        }
    },
    ThemeIcon: class {
        id: string;
        color: unknown;
        constructor(id: string, color?: unknown) { this.id = id; this.color = color; }
    },
    ThemeColor: class {
        id: string;
        constructor(id: string) { this.id = id; }
    },
    DataTransferItem: class {
        value: unknown;
        constructor(value: unknown) { this.value = value; }
        asFile() { return undefined; }
    },
    DataTransfer: class {
        private _map = new Map<string, { value: unknown; asFile: () => undefined }>();
        get(mime: string) { return this._map.get(mime); }
        set(mime: string, item: { value: unknown; asFile: () => undefined }) { this._map.set(mime, item); }
    },
    CancellationToken: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) },
    lm: {
        registerTool: () => ({ dispose: () => {} }),
    },
    window: {
        showErrorMessage: () => Promise.resolve(undefined),
        showWarningMessage: () => Promise.resolve(undefined),
        showInformationMessage: () => Promise.resolve(undefined),
    },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');
// Guard: only install the patch once (Node caches this module, but be explicit).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!(Module._load as any).__vscodStubInstalled) {
    const _originalLoad = Module._load.bind(Module);
    Module._load = function (request: string, parent: unknown, isMain: boolean) {
        if (request === 'vscode') { return _vscodStub; }
        return _originalLoad(request, parent, isMain);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Module._load as any).__vscodStubInstalled = true;
}

// ---------------------------------------------------------------------------
// Factories for raw Todoist API shapes
// ---------------------------------------------------------------------------

import { TodoistTask, TodoistProject } from '../../todoist/types';

let _idCounter = 1;

export function makeRawTask(overrides: Partial<TodoistTask> = {}): TodoistTask {
    const id = String(_idCounter++);
    return {
        id,
        project_id: 'proj-1',
        section_id: null,
        content: `Task ${id}`,
        description: '',
        checked: false,
        labels: [],
        parent_id: null,
        child_order: 0,
        priority: 1,
        due: null,
        added_at: '2026-01-01T00:00:00Z',
        ...overrides,
    };
}

export function makeRawProject(overrides: Partial<TodoistProject> = {}): TodoistProject {
    const id = `proj-${_idCounter++}`;
    return {
        id,
        name: `Project ${id}`,
        color: 'charcoal',
        parent_id: null,
        child_order: 0,
        is_favorite: false,
        view_style: 'list',
        ...overrides,
    };
}

/** Reset the counter between test suites if needed */
export function resetIdCounter(n = 1) { _idCounter = n; }
