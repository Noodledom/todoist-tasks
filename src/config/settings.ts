import * as vscode from 'vscode';
import { TaskSort, CalendarView, TaskSortBy, TaskSortOrder } from '../todoist/types';

function cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('todoist');
}

export function getDefaultCalendarView(): CalendarView {
    return cfg().get<CalendarView>('defaultView', 'week');
}

export function getTaskSort(): TaskSort {
    return {
        by: cfg().get<TaskSortBy>('taskSortBy', 'dueDate'),
        order: cfg().get<TaskSortOrder>('taskSortOrder', 'asc'),
    };
}

export async function setTaskSort(sort: TaskSort): Promise<void> {
    await cfg().update('taskSortBy', sort.by, vscode.ConfigurationTarget.Global);
    await cfg().update('taskSortOrder', sort.order, vscode.ConfigurationTarget.Global);
}

export function getPollInterval(): number {
    return cfg().get<number>('pollIntervalSeconds', 60);
}
