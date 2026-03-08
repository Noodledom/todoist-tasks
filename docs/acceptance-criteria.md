# Acceptance Criteria

## AC-1 — Task Read/Write

| ID | Criterion |
|---|---|
| AC-1.1 | Given a valid DecSync directory, all task collections and their tasks appear in the sidebar tree on extension load |
| AC-1.2 | A new task created in the extension appears as a file in the DecSync directory within 1 second |
| AC-1.3 | Editing any task field (title, due date, priority, description, tags, recurrence) persists to disk and is reflected in the tree without manual refresh |
| AC-1.4 | Marking a task complete sets its completion date and moves it to a "Completed" group in the tree |
| AC-1.5 | Deleting a task removes its file from the DecSync directory and removes it from the tree |

## AC-2 — Calendar Event Read/Write

| ID | Criterion |
|---|---|
| AC-2.1 | All calendar collections and their events are visible in the calendar webview on open |
| AC-2.2 | A new event created in the extension appears as a file in the DecSync directory within 1 second |
| AC-2.3 | Editing an event (title, start/end time, description, recurrence) persists to disk and updates the calendar view |
| AC-2.4 | Deleting an event removes its file from disk and removes it from the calendar view |

## AC-3 — Subtasks

| ID | Criterion |
|---|---|
| AC-3.1 | A task with subtasks renders as an expandable node in the sidebar tree |
| AC-3.2 | Completing a parent task prompts the user whether to also complete all subtasks |
| AC-3.3 | A subtask can be created, edited, and deleted independently of its parent |

## AC-4 — Task Fields

| ID | Criterion |
|---|---|
| AC-4.1 | The task edit form exposes: title, due date, priority (none/low/medium/high), description, tags, recurrence rule, completion status, alarms |
| AC-4.2 | All fields round-trip correctly: values written by the extension are readable by Tasks.org on the phone, and vice versa |
| AC-4.3 | Recurrence rules (daily, weekly, monthly, custom RRULE) are displayed and editable |

## AC-5 — Sidebar Tree View

| ID | Criterion |
|---|---|
| AC-5.1 | The tree is visible in the VS Code Activity Bar as a dedicated icon |
| AC-5.2 | Tasks are grouped by collection (list/project) by default |
| AC-5.3 | Expanding a collection shows its tasks; expanding a task shows its subtasks |
| AC-5.4 | Each task item shows at minimum: title, due date indicator, priority indicator, completion checkbox |

## AC-6 — Filtering & Sorting

| ID | Criterion |
|---|---|
| AC-6.1 | The tree toolbar provides filter controls for: due date range, collection, tag, priority |
| AC-6.2 | Active filters are visually indicated and can be cleared individually or all at once |
| AC-6.3 | The tree toolbar provides a sort control with options: due date, priority, title, creation date (asc/desc) |
| AC-6.4 | Filter and sort state persists across VS Code sessions |

## AC-7 — Calendar View

| ID | Criterion |
|---|---|
| AC-7.1 | Opening the calendar command opens a webview panel showing the current week by default |
| AC-7.2 | The user can switch between day, week, and month views via buttons in the panel |
| AC-7.3 | Tasks with due dates appear on their due date; calendar events appear on their start date/time |
| AC-7.4 | Clicking an item in the calendar opens its edit form |
| AC-7.5 | Navigating forward/backward in time works in all three view modes |

## AC-8 — Auto-Refresh

| ID | Criterion |
|---|---|
| AC-8.1 | When a file in the DecSync directory is modified externally (e.g. by Syncthing), the sidebar tree and calendar view update within 2 seconds without any user action |
| AC-8.2 | Auto-refresh does not discard unsaved edits the user has open in a form |

## AC-9 — Configuration

| ID | Criterion |
|---|---|
| AC-9.1 | A VS Code setting `decsync.directoryPath` accepts an absolute path to the DecSync directory |
| AC-9.2 | If the path is not set or invalid, the extension shows a clear error message with a button to open settings |
| AC-9.3 | Changing the path reloads all data from the new location without restarting VS Code |

## AC-10 — Offline-First

| ID | Criterion |
|---|---|
| AC-10.1 | All read and write operations work with no internet connection |
| AC-10.2 | The extension never makes any network requests |
