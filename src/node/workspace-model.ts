// Maintain one folder's model records (turtle/query), view-file index and shared open ViewStores for editors and export (VS Code host).
// Model edits, saves and view-file changes refresh the records and the graph while open stores keep their view edits and undo history
// (model/workspace-core.ts).
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import { isViewFile, viewIriOf } from '../model/graph-input';
import type { ModelPort } from '../model/port';
import { WorkspaceCore } from '../model/workspace-core';
import { nodePort } from './port';
import { type TurtleApi, type GraphResult, requestGraph } from './turtle-api';

export type { OpenView } from '../model/workspace-core';

/** Candidate view files: a .trig file is a view when it has a view:View (isViewFile). */
const VIEW_FILES = '**/*.trig';
/** Ask again this long after the last change. */
const REFRESH_MS = 300;

/** The view graph IRI of a view file. */
export function viewIriOfFile(file: string): string | undefined {
    return viewIriOf(readFileSync(file, 'utf8'));
}

export class WorkspaceModel extends WorkspaceCore implements vscode.Disposable {
    protected readonly disposables: vscode.Disposable[] = [];
    protected timer: ReturnType<typeof setTimeout> | undefined;
    protected readonly port: ModelPort;

    constructor(readonly folder: vscode.WorkspaceFolder, protected readonly api: () => TurtleApi, protected readonly logLine: (line: string) => void) {
        super();
        this.port = nodePort({ client: () => this.api().client(), idle: () => this.api().idle() });
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, VIEW_FILES));
        const schedule = () => this.schedule();
        this.disposables.push(watcher, watcher.onDidChange(schedule), watcher.onDidCreate(schedule), watcher.onDidDelete(schedule),
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (!isViewFile(doc.uri.fsPath, doc.getText()) && vscode.workspace.getWorkspaceFolder(doc.uri) === folder) schedule();
            }),
            // turtle-lsp reads the open buffer of a model document: the next query sees the change before a save.
            vscode.workspace.onDidChangeTextDocument(e => {
                const file = e.document.uri.fsPath;
                if (e.contentChanges.length && (this.modelFiles.includes(file) || file === this.manifest.file)) schedule();
            }),
            vscode.languages.onDidChangeDiagnostics(e => {
                if (e.uris.some(uri => vscode.workspace.getWorkspaceFolder(uri) === folder)) void this.readDiagnostics().then(() => this.fire());
            }));
    }

    protected get name(): string { return this.folder.name; }

    protected async requestGraph(): Promise<GraphResult> {
        const all = await requestGraph(this.api(), { literals: true, types: true, maxNodes: 20000, layout: { iterations: 0 } });
        // turtle-lsp answers for every document of the window: keep the statements of this folder (multi-root workspaces).
        const inFolder = (uri: string) => uri.startsWith('file:') && fileURLToPath(uri).startsWith(this.folder.uri.fsPath + path.sep);
        return { ...all, edges: all.edges.filter(e => inFolder(e.uri)) };
    }

    protected async viewFilePaths(): Promise<string[]> {
        return (await vscode.workspace.findFiles(new vscode.RelativePattern(this.folder, VIEW_FILES))).map(u => u.fsPath).filter(f => { try { return isViewFile(f, readFileSync(f, 'utf8')); } catch { return false; } }).sort();
    }

    protected diagnosticsByUri(): Record<string, vscode.Diagnostic[]> {
        return Object.fromEntries(vscode.languages.getDiagnostics().filter(([uri]) => vscode.workspace.getWorkspaceFolder(uri) === this.folder).map(([uri, list]) => [uri.toString(), list]));
    }

    protected textOf(uri: string): string {
        try { return readFileSync(fileURLToPath(uri), 'utf8'); } catch { return ''; }
    }

    protected log(line: string): void { this.logLine(line); }

    protected warn(message: string): void { void vscode.window.showWarningMessage(message); }

    override refresh(): Promise<void> {
        clearTimeout(this.timer);
        return super.refresh();
    }

    protected schedule(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh(), REFRESH_MS);
    }

    dispose(): void {
        clearTimeout(this.timer);
        for (const d of this.disposables.splice(0)) d.dispose();
        this.listeners.clear();
    }
}
