// ─── Domain types ────────────────────────────────────────────────────────────

export type Priority = 'none' | 'low' | 'medium' | 'high';
export type CalendarView = 'day' | 'week' | 'month';
export type TaskSortBy = 'dueDate' | 'priority' | 'title' | 'created';
export type TaskSortOrder = 'asc' | 'desc';

export interface Task {
    /** Todoist task id */
    uid: string;
    /** Todoist project id */
    collectionId: string;
    title: string;
    description?: string;
    dueDate?: string;        // ISO date string (YYYY-MM-DD or full ISO)
    priority: Priority;
    tags: string[];          // Todoist labels
    completed: boolean;
    /** Todoist parent_id — null for top-level tasks */
    parentUid?: string;
    createdAt?: string;
    order?: number;
}

export interface Collection {
    /** Todoist project id */
    id: string;
    name: string;
    color?: string;
    /** Todoist parent_id for sub-projects */
    parentId?: string;
}

export interface TaskFilter {
    collectionId?: string;
    tags?: string[];
    priority?: Priority;
    showCompleted?: boolean;
}

export interface TaskSort {
    by: TaskSortBy;
    order: TaskSortOrder;
}

// ─── Raw Todoist API v1 shapes ────────────────────────────────────────────────

export interface TodoistDue {
    date: string;
    is_recurring: boolean;
    datetime?: string;
    string?: string;
    timezone?: string;
}

/** Task shape returned by GET /api/v1/tasks (unified Sync + REST format) */
export interface TodoistTask {
    id: string;
    project_id: string;
    section_id: string | null;
    content: string;
    description: string;
    /** v1 uses `checked` (was `is_completed` in REST v2) */
    checked: boolean;
    labels: string[];
    parent_id: string | null;
    /** v1 uses `child_order` (was `order` in REST v2) */
    child_order: number;
    priority: number;        // 1 (normal) – 4 (urgent)
    due: TodoistDue | null;
    /** v1 uses `added_at` (was `created_at` in REST v2) */
    added_at: string;
}

/** Label shape returned by GET /api/v1/labels */
export interface TodoistLabel {
    id: string;
    name: string;
    color: string;
    order: number;
    is_favorite: boolean;
}

/** Comment shape returned by GET /api/v1/comments */
export interface TodoistComment {
    id: string;
    task_id: string;
    content: string;
    posted_at: string;
}

/** Project shape returned by GET /api/v1/projects */
export interface TodoistProject {
    id: string;
    name: string;
    color: string;
    parent_id: string | null;
    /** v1 uses `child_order` (was `order` in REST v2) */
    child_order: number;
    is_shared?: boolean;
    is_favorite: boolean;
    inbox_project?: boolean;
    view_style: string;
}
