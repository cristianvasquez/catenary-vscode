// The workspace graph of the page: turtle-lsp in a worker (engine.wasm) answers turtle/graph for the open buffers; view files are read
// from the saved files (FileStore), as the VS Code host reads them from disk. Diagnostics arrive as LSP notifications.
// The engine has no turtle/query until K13: the page draws from the old graph (model/diagram.ts), reads the pickers (model/choices.ts) and maps diagnostics on it.
import type { Diagnostic } from 'vscode';
import { iriId } from '../catenary/model/ids';
import { shapesIndexOf } from '../catenary/rdf/shapes-read';
import { viewFiguresOf } from '../catenary/rdf/notations';
import { readView } from '../catenary/rdf/view-read';
import * as choices from '../model/choices';
import { diagramOf } from '../model/diagram';
import { graphPrefixes, isViewFile } from '../model/graph-input';
import { WorkspaceCore } from '../model/workspace-core';
import { diagnosticsOf } from '../node/diagnostics';
import type { GraphResult } from '../node/turtle-api';
import type { Choices } from '../catenary/model/prompts';
import { type DiagramOptions, type Drawn, emptyDrawn } from '../read/diagram';
import { type FileStore, ROOT, pathOf } from './files';
import type { LspClient, LspDiagnostic } from './turtle-lsp/editor-lsp.js';

/** Ask again this long after the last change. */
const REFRESH_MS = 300;

export class WebWorkspace extends WorkspaceCore {
    protected readonly name = 'workspace';
    protected readonly port = undefined;
    /** The last diagnostics of turtle-lsp by document URI. */
    readonly diagnostics = new Map<string, LspDiagnostic[]>();
    protected timer: ReturnType<typeof setTimeout> | undefined;

    constructor(protected readonly lsp: LspClient, protected readonly files: FileStore, protected readonly bufferOf: (uri: string) => string | undefined,
        protected readonly logLine: (line: string) => void, protected readonly warnUser: (message: string) => void) {
        super();
    }

    protected async requestGraph(): Promise<GraphResult> {
        const all = await this.lsp.request('turtle/graph', { literals: true, types: true, maxNodes: 20000, layout: { iterations: 0 } }) as GraphResult;
        return { ...all, edges: all.edges.filter(e => e.uri.startsWith(`file://${ROOT}/`)) };
    }

    protected async viewFilePaths(): Promise<string[]> {
        return this.files.list().filter(rel => rel.endsWith('.trig') && isViewFile(rel, this.files.read(rel))).map(pathOf).sort();
    }

    /** LSP severities (1 error … 4 hint) as VS Code severities (0 error … 3 hint), as diagnosticsOf reads them. */
    protected diagnosticsByUri(): Record<string, Diagnostic[]> {
        return Object.fromEntries([...this.diagnostics].map(([uri, list]) => [uri, list.map(d => ({ ...d, severity: (d.severity ?? 1) - 1 }) as unknown as Diagnostic)]));
    }

    protected textOf(uri: string): string {
        return this.bufferOf(uri) ?? '';
    }

    protected log(line: string): void { this.logLine(line); }

    protected warn(message: string): void { this.warnUser(message); }

    /** New diagnostics of a document: the canvases draw their badges again. */
    setDiagnostics(uri: string, list: LspDiagnostic[]): void {
        this.diagnostics.set(uri, list);
        void this.readDiagnostics().then(() => this.fire());
    }

    override async diagram(viewId: string, opts: DiagramOptions): Promise<Drawn> {
        const graph = this.graph;
        if (!graph) return emptyDrawn();
        const id = viewId.includes(':') ? iriId(viewId) : viewId;
        graphPrefixes(graph);
        const doc = readView(graph, id, shapesIndexOf(graph).model), view = doc.views[id];
        return { schema: diagramOf(graph, id, opts), doc, ...(view ? { figures: viewFiguresOf(graph, view.uri) } : {}) };
    }

    /** The pickers on the old graph: the engine has no turtle/query until K13. */
    override async expandChoices(viewId: string, from: string, dir: 'in' | 'out' | 'targets'): Promise<Choices | undefined> {
        return this.graph ? choices.expandChoices(this.graph, viewId, from, dir) : undefined;
    }

    override async memberOptions(viewId: string, collection: string): Promise<string[]> {
        return this.graph ? choices.memberOptions(this.graph, viewId, collection) : [];
    }

    override async instancesNamed(text: string): Promise<string[]> {
        return this.graph ? choices.instancesNamed(this.graph, text) : [];
    }

    override async readDiagnostics(): Promise<void> {
        if (this.graph && this.result) this.violations = diagnosticsOf(this.graph, this.result, this.diagnosticsByUri(), uri => this.textOf(uri));
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
