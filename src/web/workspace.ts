// The workspace of the page: turtle-lsp in a worker (engine.wasm, built from turtle-lsp 0.14.0 or later) answers turtle/query and turtle/graph for the open
// buffers; diagnostics arrive as LSP notifications. The documents of the model are the RDF files of the FileStore; every file is an open
// buffer of the server (main.ts sends didOpen and didChange). A canvas command replaces the text of the view buffer (didChange follows)
// and writes the file to the FileStore.
import type { Diagnostic } from 'vscode';
import type { ModelPort } from '../model/port';
import { type VersionedEdit, type ViewDocumentState, WorkspaceCore } from '../model/workspace-core';
import type { GraphResult } from '../node/turtle-api';
import { type FileStore, ROOT, pathOf, relOfPath, relOfUri, uriOf } from './files';
import { webPort } from './port';
import type { LspClient, LspDiagnostic } from './turtle-lsp/editor-lsp.js';

/** Ask again this long after the last change. */
const REFRESH_MS = 300;

/** The RDF documents of the FileStore that turtle-lsp reads (Turtle and TriG). */
const RDF_DOCUMENT = /\.(ttl|trig)$/;

/** The text buffers of the page (Monaco models), by relative path. */
export interface Buffers {
    /** The text and the version of the buffer of `rel`; undefined when it has none. */
    get(rel: string): { text: string; version: number } | undefined;
    /** Opens a buffer of `rel` with the text of the FileStore (didOpen). */
    open(rel: string): void;
    /** Replaces the text of the buffer of `rel` with one undoable edit (didChange). */
    replace(rel: string, text: string): void;
}

export class WebWorkspace extends WorkspaceCore {
    protected readonly name = 'workspace';
    protected readonly port: ModelPort;
    /** The last diagnostics of turtle-lsp by document URI. */
    readonly diagnostics = new Map<string, LspDiagnostic[]>();
    protected timer: ReturnType<typeof setTimeout> | undefined;

    constructor(protected readonly lsp: LspClient, protected readonly files: FileStore, protected readonly buffers: Buffers,
        protected readonly logLine: (line: string) => void, protected readonly warnUser: (message: string) => void) {
        super();
        this.port = webPort(lsp);
    }

    protected async requestGraph(): Promise<GraphResult> {
        const all = await this.lsp.request('turtle/graph', { literals: true, types: true, maxNodes: 20000, layout: { iterations: 0 } }) as GraphResult;
        return { ...all, edges: all.edges.filter(e => e.uri.startsWith(`file://${ROOT}/`)) };
    }

    /** The RDF files of the FileStore: viewFilesOf picks the view files among them, the others are the model documents. */
    protected override documentsOf(): string[] {
        return this.files.list().filter(rel => RDF_DOCUMENT.test(rel)).map(pathOf);
    }

    /** LSP severities (1 error … 4 hint) as VS Code severities (0 error … 3 hint), as diagnosticsOf reads them. */
    protected diagnosticsByUri(): Record<string, Diagnostic[]> {
        return Object.fromEntries([...this.diagnostics].map(([uri, list]) => [uri, list.map(d => ({ ...d, severity: (d.severity ?? 1) - 1 }) as unknown as Diagnostic)]));
    }

    protected textOf(uri: string): string {
        const rel = relOfUri(uri);
        return (rel === undefined ? undefined : this.buffers.get(rel)?.text) ?? '';
    }

    protected async documentOf(file: string, load: boolean): Promise<ViewDocumentState | undefined> {
        const rel = relOfPath(file);
        if (rel === undefined || !this.files.has(rel)) return undefined;
        if (!this.buffers.get(rel) && load) this.buffers.open(rel);
        const buffer = this.buffers.get(rel);
        return buffer && { uri: uriOf(rel), text: buffer.text, version: buffer.version };
    }

    /** Checks every version, then replaces each buffer and writes each file, with no await between. */
    protected async applyEdits(edits: VersionedEdit[]): Promise<'applied' | 'changed' | 'refused'> {
        const rels = edits.map(e => relOfUri(e.uri));
        if (rels.some(rel => rel === undefined || !this.files.has(rel))) return 'refused';
        if (rels.some((rel, i) => this.buffers.get(rel!)?.version !== edits[i].version)) return 'changed';
        let stored = true;
        edits.forEach((e, i) => {
            this.buffers.replace(rels[i]!, e.text);
            stored = this.files.write(rels[i]!, e.text) && stored;
        });
        if (!stored) this.warn('Not stored: the browser storage is full or blocked. The file is kept in memory; use Download to keep it.');
        return 'applied';
    }

    protected log(line: string): void { this.logLine(line); }

    protected warn(message: string): void { this.warnUser(message); }

    /** New diagnostics of a document: the canvases draw their badges again. */
    setDiagnostics(uri: string, list: LspDiagnostic[]): void {
        this.diagnostics.set(uri, list);
        void this.readDiagnostics().then(() => this.fire());
    }

    override refresh(): Promise<void> {
        clearTimeout(this.timer);
        return super.refresh();
    }

    schedule(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh(), REFRESH_MS);
    }
}
