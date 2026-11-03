// Maintain one folder's model records (turtle/query) and view-file index (VS Code host). Model edits, saves and view-file changes refresh
// the records; a change of a view document redraws the canvases. A canvas command is one WorkspaceEdit of the view documents
// (model/workspace-core.ts); VS Code keeps the undo history, the dirty state and the backups.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import type { ModelPort } from '../model/port';
import { type VersionedEdit, type ViewDocumentState, WorkspaceCore } from '../model/workspace-core';
import { nodePort } from './port';
import { type TurtleApi, type GraphResult, requestGraph } from './turtle-api';

/** Candidate view files: a .trig file is a view when it has a view:View graph (viewFilesOf). */
const VIEW_FILES = '**/*.trig';
/** The RDF documents whose text changes refresh the model (turtle-lsp: Turtle and TriG). */
const MODEL_DOCUMENT = /\.(ttl|trig)$/;
/** Ask again this long after the last change. */
const REFRESH_MS = 300;

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
                if (!this.viewOfFile(doc.uri.fsPath) && vscode.workspace.getWorkspaceFolder(doc.uri) === folder) schedule();
            }),
            // turtle-lsp reads the open buffer of a document: the next query sees the change before a save. A view document redraws the
            // canvases; any other RDF document of the folder refreshes the model (an empty new file is in no list yet).
            vscode.workspace.onDidChangeTextDocument(e => {
                const file = e.document.uri.fsPath;
                if (!e.contentChanges.length || !MODEL_DOCUMENT.test(file) || vscode.workspace.getWorkspaceFolder(e.document.uri) !== folder) return;
                if (this.viewOfFile(file)) this.viewChanged();
                else schedule();
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

    protected diagnosticsByUri(): Record<string, vscode.Diagnostic[]> {
        return Object.fromEntries(vscode.languages.getDiagnostics().filter(([uri]) => vscode.workspace.getWorkspaceFolder(uri) === this.folder).map(([uri, list]) => [uri.toString(), list]));
    }

    protected textOf(uri: string): string {
        try { return readFileSync(fileURLToPath(uri), 'utf8'); } catch { return ''; }
    }

    protected async documentOf(file: string, load: boolean): Promise<ViewDocumentState | undefined> {
        const uri = vscode.Uri.file(file);
        const document = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString()) ?? (load ? await vscode.workspace.openTextDocument(uri) : undefined);
        return document && { uri: document.uri.toString(), text: document.getText(), version: document.version };
    }

    /**
     * One WorkspaceEdit: each view document is replaced as a whole (the tree-sitter patch is K12). The documents load first; the version
     * check, the edit and its submission are synchronous (applyEdit is called in the same turn). VS Code has no version precondition on a
     * WorkspaceEdit: a change that reaches the extension host after this turn is replaced.
     */
    protected async applyEdits(edits: VersionedEdit[]): Promise<'applied' | 'changed' | 'refused'> {
        const documents = await Promise.all(edits.map(e => vscode.workspace.openTextDocument(vscode.Uri.parse(e.uri))));
        if (documents.some((d, i) => d.version !== edits[i].version)) return 'changed';
        const edit = new vscode.WorkspaceEdit();
        documents.forEach((d, i) => edit.replace(d.uri, d.validateRange(new vscode.Range(0, 0, d.lineCount, 0)), edits[i].text));
        return await vscode.workspace.applyEdit(edit) ? 'applied' : 'refused';
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
        clearTimeout(this.redrawTimer);
        for (const d of this.disposables.splice(0)) d.dispose();
        this.listeners.clear();
    }
}
