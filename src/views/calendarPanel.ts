import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { TodoistService } from '../todoist/todoistService';
import { CalendarView } from '../todoist/types';
import { getDefaultCalendarView } from '../config/settings';

const VALID_VIEWS = new Set<CalendarView>(['day', 'week', 'month']);

export class CalendarPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private currentView: CalendarView;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly service: TodoistService,
        private readonly extensionUri: vscode.Uri,
    ) {
        this.currentView = getDefaultCalendarView();
        this.disposables.push(
            service.onDidChange(() => this._postData())
        );
    }

    // -------------------------------------------------------------------------
    // Open / reveal
    // -------------------------------------------------------------------------

    open(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const nonce = crypto.randomBytes(16).toString('hex');

        this.panel = vscode.window.createWebviewPanel(
            'todoistCalendar',
            'Todoist Calendar',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.extensionUri, 'out', 'views', 'webview'),
                ],
            }
        );

        this.panel.webview.html = this._getHtml(nonce);

        this.panel.webview.onDidReceiveMessage(
            msg => this._handleMessage(msg),
            undefined,
            this.disposables
        );

        this.panel.onDidDispose(() => {
            this.panel = undefined;
        }, undefined, this.disposables);

        // Send initial data after the webview has loaded
        setTimeout(() => this._postData(), 300);
    }

    // -------------------------------------------------------------------------
    // Message handling (webview → extension)
    // -------------------------------------------------------------------------

    private _handleMessage(msg: { command: string; [key: string]: unknown }): void {
        switch (msg.command) {
            case 'setView': {
                const view = msg.view as CalendarView;
                if (!VALID_VIEWS.has(view)) { return; }
                this.currentView = view;
                this._postData();
                break;
            }
            case 'editTask': {
                if (typeof msg.uid !== 'string' || !msg.uid) { return; }
                vscode.commands.executeCommand('todoistTasks.editTask', msg.uid);
                break;
            }
        }
    }

    // -------------------------------------------------------------------------
    // Send data to webview
    // -------------------------------------------------------------------------

    private _postData(): void {
        if (!this.panel) { return; }

        const now = new Date().toISOString();
        const tasks = this.service.getTasks({ showCompleted: false })
            .filter(t => t.dueDate);
        const collections = this.service.getCollections();

        this.panel.webview.postMessage({
            command: 'load',
            view: this.currentView,
            now,
            tasks,
            collections,
        });
    }

    // -------------------------------------------------------------------------
    // HTML
    // -------------------------------------------------------------------------

    private _getHtml(nonce: string): string {
        const htmlPath = path.join(
            this.extensionUri.fsPath,
            'out', 'views', 'webview', 'calendar.html'
        );
        const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">\n`;
        if (fs.existsSync(htmlPath)) {
            const html = fs.readFileSync(htmlPath, 'utf8');
            // Inject CSP and nonce into existing HTML
            return html
                .replace(/<head>/i, `<head>\n    ${csp}`)
                .replace(/<script/g, `<script nonce="${nonce}"`);
        }
        return this._fallbackHtml(nonce);
    }

    private _fallbackHtml(nonce: string): string {
        const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';`;
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>Todoist Calendar</title>
</head>
<body><p>calendar.html not found</p></body>
</html>`;
    }

    // -------------------------------------------------------------------------
    // Disposal
    // -------------------------------------------------------------------------

    dispose(): void {
        this.panel?.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
