# Requirements

## Functional Requirements

| ID  | Requirement |
|-----|-------------|
| FR1 | Full read/write for tasks (create, edit, complete, delete) |
| FR2 | Full read/write for calendar events |
| FR3 | Subtasks support |
| FR4 | Support all VTODO fields: title, due date, priority, description, tags, recurrence, completion status, alarms |
| FR5 | Task tree view in the VS Code sidebar |
| FR6 | Filter tasks by due date, project/list, tag, priority |
| FR7 | Sort tasks by any attribute |
| FR8 | Calendar view with switchable day / week / month scope (webview panel) |
| FR9 | Auto-refresh when DecSync directory changes on disk |
| FR10 | Configurable DecSync directory path |
| FR11 | Offline-first — always reads local directory, no internet required |

## Non-Functional Requirements

| ID   | Requirement |
|------|-------------|
| NFR1 | Synced via Google Drive (v1); architecture must not assume any specific sync tool |
| NFR2 | Data format: DecSync directory (iCalendar VTODO / VEVENT JSON-wrapped files) |

## Deferred (v2)

- Code file / line linking
- In-VS Code notifications and reminders
- Syncthing support
- Proton Drive support
