# Architecture

## System Layers

```mermaid
flowchart TD
    subgraph UI["VS Code UI"]
        direction TB
        TV["Sidebar Tree View"]
        CP["Calendar Webview Panel\n(day / week / month)"]
    end

    subgraph Core["Extension Core"]
        direction TB
        EX["extension.ts\n(activate, commands, wiring)"]
        CFG["settings.ts\n(configurable DecSync path)"]
    end

    subgraph Service["DecSync Service"]
        direction TB
        SVC["service.ts\n(filter, sort, mutate)"]
        PAR["parser.ts\n(iCal VTODO/VEVENT ↔ model)"]
        TYP["types.ts\n(Task, Event, Collection)"]
    end

    subgraph FSLayer["DecSync FS Layer"]
        direction TB
        FS["fsLayer.ts\n(read / write JSON files)"]
        WAT["watcher.ts\n(fs.watch → change events)"]
    end

    subgraph Disk["Local Filesystem"]
        DIR[("~/.decsync/\ntasks/ calendars/")]
    end

    subgraph Phone["Phone"]
        APP["Tasks.org\n+ DecSync CC"]
    end

    TV -->|"user action"| EX
    CP -->|"user action"| EX
    EX --> SVC
    EX --> CFG
    SVC --> PAR
    PAR --> TYP
    SVC --> FS
    FS --> DIR
    WAT -->|"file changed"| EX
    WAT --> DIR
    DIR <-->|"Google Drive sync"| APP
```

## Edit Task Data Flow

```mermaid
flowchart LR
    U["User edits task\nin Tree or Webview"]
    --> EX["Extension Core\n(command handler)"]
    --> SVC["DecSync Service\n(validate + update model)"]
    --> FS["FS Layer\n(serialize to iCal,\nwrite JSON file)"]
    --> DIR[("DecSync dir\non disk")]
    -->|"Google Drive\npicks up change"| PHN["Tasks.org\non phone"]

    DIR -->|"fs.watch fires"| WAT["File Watcher"]
    WAT -->|"refresh"| UI["Tree + Webview\nrefresh"]
```

## Source File Structure

```
src/
  extension.ts
  config/
    settings.ts
  decsync/
    types.ts
    parser.ts
    service.ts
    fsLayer.ts
    watcher.ts
  views/
    taskTreeProvider.ts
    calendarPanel.ts
    webview/
      calendar.html
```

## Key Design Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| iCal parsing | `ical.js` npm package | Handles VTODO + VEVENT + recurrence rules |
| Calendar UI | Custom webview | No native VS Code calendar widget |
| File watching | `workspace.createFileSystemWatcher` | Integrates with extension lifecycle |
| Sync abstraction | FS layer is sync-tool-agnostic | Google Drive (v1) / Syncthing / Proton Drive are interchangeable |
| State | In-memory cache in `service.ts`, invalidated on file change | Avoids re-parsing on every UI interaction |
