// The workspace of the page: turtle-lsp in a worker (engine.wasm) answers turtle/graph for the open buffers; diagnostics arrive as LSP
// notifications. The engine of the page is the upstream build without turtle/query until K13 builds it from the fork: its port throws, a
// refresh fails with that message, the canvas draws nothing and a canvas command is refused.
import type { Diagnostic } from 'vscode';
import type { ViewCommand } from '../catenary/model/commands';
import { fail, type Result } from '../edit/ops';
import type { ModelPort } from '../model/port';
import { WorkspaceCore } from '../model/workspace-core';
import type { GraphResult } from '../node/turtle-api';
import { type FileStore, ROOT } from './files';
import type { LspClient, LspDiagnostic } from './turtle-lsp/editor-lsp.js';

/** Ask again this long after the last change. */
const REFRESH_MS = 300;

/** Why the page has no model: its engine has no turtle/query. */
const NO_QUERY = 'The browser page needs the fork engine (turtle/query); it is built in K13.';

/** The port of the page until K13: every question fails. */
const stubPort: ModelPort = {
    select: () => Promise.reject(new Error(NO_QUERY)),
    construct: () => Promise.reject(new Error(NO_QUERY)),
    ask: () => Promise.reject(new Error(NO_QUERY)),
};

export class WebWorkspace extends WorkspaceCore {
    protected readonly name = 'workspace';
    protected readonly port = stubPort;
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

    /** LSP severities (1 error … 4 hint) as VS Code severities (0 error … 3 hint), as diagnosticsOf reads them. */
    protected diagnosticsByUri(): Record<string, Diagnostic[]> {
        return Object.fromEntries([...this.diagnostics].map(([uri, list]) => [uri, list.map(d => ({ ...d, severity: (d.severity ?? 1) - 1 }) as unknown as Diagnostic)]));
    }

    protected textOf(uri: string): string {
        return this.bufferOf(uri) ?? '';
    }

    protected async documentOf(): Promise<undefined> { return undefined; }

    protected async applyEdits(): Promise<'refused'> { return 'refused'; }

    override async execute(_viewId: string, command: ViewCommand): Promise<Result<unknown>> {
        return fail(`"${command.kind}": ${NO_QUERY}`);
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
