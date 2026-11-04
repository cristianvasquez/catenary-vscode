// The platform-free part of one folder's workspace: the model records read through turtle/query (the canvas draws from them and the
// commands read them). A command edits the text of the view documents (src/edit/executor.ts); the host applies the edits. The VS Code host
// (node/workspace-model.ts) and the browser page (web/workspace.ts) supply the port, the turtle-lsp graph, the documents and the diagnostics.
import { fileURLToPath } from 'node:url';
import type { Diagnostic } from 'vscode';
import type { ViewCommand } from '../catenary/model/commands';
import { idIri } from '../catenary/model/ids';
import type { Violation } from '../catenary/model/validation';
import { runCommand, type ViewEdit, type ViewInput, viewFileProblem } from '../edit/executor';
import { fail, type Result } from '../edit/ops';
import type { ViewSource } from '../node/glsp/view-session';
import type { GraphResult } from '../node/turtle-api';
import { type DiagramOptions, type Drawn, type ModelContext, diagramOf, drawFromText, completeDrawing, emptyDrawn, modelContextOf, viewTextOf, type DrawingUpdate } from '../read/diagram';
import { diagnosticsOf } from '../read/diagnostics';
import type { ManifestRecords } from '../read/manifest';
import type { KeptPrefetch } from '../read/figures';
import type { ShapesModelRecords } from '../read/shapes';
import { expandChoices, instancesNamed, memberOptions } from '../read/choices';
import type { Choices } from '../catenary/model/prompts';
import type { ModelPort } from './port';
import { viewFilesOf } from './view-files';

export interface Releasable { dispose(): void }

/** A view document as a command reads it. */
export interface ViewDocumentState { uri: string; text: string; version: number }

/** A new text of a view document and the version of the document that the command read. */
export type VersionedEdit = ViewEdit & { version: number };

/** The IRI of a view given by its IRI or its element id. */
const viewIriOf = (view: string) => view.includes(':') ? view : idIri(view);

/** The sessions draw again this long after the last change of a view document. */
const REDRAW_MS = 100;

export abstract class WorkspaceCore implements ViewSource {
    /** The turtle/graph answer: node ranges of the diagnostics. */
    result: GraphResult | undefined;
    /** View IRI to its workspace file path (viewFilesOf), refreshed on each refresh. */
    readonly viewFiles = new Map<string, string>();
    /** The model documents without the manifest document (ShapesModelRecords.files). */
    modelFiles: string[] = [];
    /** The shapes model of the model documents, computed once per refresh; undefined before the first answer. */
    shapes: ShapesModelRecords | undefined;
    manifest: ManifestRecords = {};
    /** Incremented on each refresh that succeeds. */
    generation = 0;
    /** Prefetched figure statements per view; only entries of the current model generation are reused. */
    private readonly keptFigures = new Map<string, { generation: number; kept: KeptPrefetch }>();
    /** The context of the reads (modelContextOf): its port reads the documents of this folder only. */
    protected ctx: ModelContext | undefined;
    violations: Violation[] = [];
    /** Why the last refresh failed; undefined after a success. */
    error: string | undefined;
    /** The last clip of a copy or cut in a canvas of this folder (glsp/handlers.ts). */
    clip?: { id: string; data: string };
    protected seq = 0;
    protected diagnosticsSeq = 0;
    protected first?: Promise<void>;
    protected readonly listeners = new Set<(update?: DrawingUpdate) => void>();
    private drawingEpoch = 0;
    /** The last command started: the next command reads the views after its edits. */
    protected commands: Promise<unknown> = Promise.resolve();

    /** A short name of the folder, for log lines. */
    protected abstract readonly name: string;
    /** turtle/query of this host. */
    protected abstract readonly port: ModelPort;
    /** turtle-lsp `turtle/graph`, limited to the documents of this folder. */
    protected abstract requestGraph(): Promise<GraphResult>;
    /** The RDF documents of the folder (file paths): by default the documents of the turtle/graph answer (requestGraph keeps this folder's). */
    protected documentsOf(result: GraphResult): string[] {
        return [...new Set(result.edges.map(e => e.uri).filter(u => u.startsWith('file:')))].map(u => fileURLToPath(u)).sort();
    }
    /** The diagnostics of this folder by document URI, with VS Code severities (0 error … 3 hint). */
    protected abstract diagnosticsByUri(): Record<string, Diagnostic[]>;
    /** The text of a document URI; '' when it cannot be read. */
    protected abstract textOf(uri: string): string;
    /**
     * The document of a view file: its URI, its text and its version. `load` false: undefined when no editor has the document open; true:
     * the host opens it without showing it (the language server receives it).
     */
    protected abstract documentOf(file: string, load: boolean): Promise<ViewDocumentState | undefined>;
    /**
     * Applies the edits as one edit of the workspace (one undo step in each document). Each edit carries the version of its document that
     * the command read: the host loads the documents first, then checks every version and submits the edit with no await between.
     * 'changed': a document has another version (a text editor, an undo); 'refused': the host refused the edit.
     */
    protected abstract applyEdits(edits: VersionedEdit[]): Promise<'applied' | 'changed' | 'refused'>;
    protected abstract log(line: string): void;
    protected abstract warn(message: string): void;

    onDidChange(listener: (update?: DrawingUpdate) => void): Releasable {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    protected fire(update?: DrawingUpdate): void {
        for (const listener of [...this.listeners]) listener(update);
    }

    protected redrawTimer: ReturnType<typeof setTimeout> | undefined;

    /** A view document changed (a canvas edit, an undo, a text editor): the sessions draw again after REDRAW_MS without a change. */
    viewChanged(): void {
        this.drawingEpoch++;
        clearTimeout(this.redrawTimer);
        this.redrawTimer = setTimeout(() => this.fire(), REDRAW_MS);
    }

    /**
     * One command on the view `viewId` (IRI or element id): the views it edits are this view and, for a paste of a cut, the source view.
     * Refused when no editor has the view `viewId` open; the source view of a cut is opened without an editor. The command reads the views
     * from the server (the open buffers), and the host applies the new texts in one edit; a refused edit fails the command. Commands run
     * one after the other.
     */
    execute(viewId: string, command: ViewCommand): Promise<Result<unknown>> {
        const run = this.commands.then(() => this.run(viewId, command));
        this.commands = run.catch(() => undefined);
        return run;
    }

    protected async run(viewId: string, command: ViewCommand): Promise<Result<unknown>> {
        const ctx = this.context();
        if (!ctx) return fail(this.error ?? 'The model is not read yet.');
        const iri = viewIriOf(viewId);
        if (!iri) return fail(`No view with the id ${viewId}.`);
        const iris = [iri, ...command.kind === 'moveBetweenViews' ? [command.from, command.to].map(viewIriOf) : []];
        const views: ViewInput[] = [], versions = new Map<string, number>();
        for (const v of new Set(iris)) {
            const file = v && this.viewFiles.get(v);
            if (!v || !file) return fail(`The view ${v ?? ''} has no view file in ${this.name}.`);
            const document = await this.documentOf(file, v !== iri);
            if (!document) return fail('The view is not open in an editor.');
            views.push({ iri: v, uri: document.uri, text: document.text });
            versions.set(document.uri, document.version);
        }
        const generation = this.generation;
        const previous = new Map<string, KeptPrefetch>();
        for (const v of views) {
            const entry = this.keptFigures.get(v.iri);
            if (entry?.generation === generation) previous.set(v.iri, entry.kept);
        }
        const { edits, kept, ...r } = await runCommand(ctx, views, command, line => this.log(line), previous);
        if (kept && generation === this.generation) {
            for (const [key, state] of kept) this.keptFigures.set(key, { generation, kept: state });
        }
        if (!r.ok || !edits.length) return r;
        // A change of a document during the command (a text editor, an undo) wins: the edit would replace it with text of the older state.
        const applied = await this.applyEdits(edits.map(e => ({ ...e, version: versions.get(e.uri)! })));
        if (applied === 'changed') return fail('The view changed during the edit. Do it again.');
        if (applied === 'refused') return fail('The editor refused the edit of the view file.');
        return r;
    }

    /** Resolves after the first refresh. */
    ready(): Promise<void> {
        return this.first ??= this.refresh();
    }

    /** Asks turtle-lsp again and reads the view files; settles after the answer or the failure. */
    async refresh(): Promise<void> {
        const seq = ++this.seq;
        try {
            const result = await this.requestGraph();
            const records = await modelContextOf(this.port, this.documentsOf(result));
            if (seq !== this.seq) return;
            const { views: viewFiles, skipped } = records.viewFiles;
            for (const { file, reason } of skipped) this.log(`workspace ${this.name}: skipped ${file}: ${reason}`);
            if (skipped.length) this.warn(`Catenary: skipped ${skipped.length} view file(s) in ${this.name}. See the Catenary output for details.`);
            this.viewFiles.clear();
            for (const [iri, file] of viewFiles) this.viewFiles.set(iri, file);
            this.result = result;
            ({ manifest: this.manifest, shapes: this.shapes, modelFiles: this.modelFiles } = this.ctx = records.ctx);
            this.generation++;
            await this.readDiagnostics();
            if (seq !== this.seq) return;
            this.error = undefined;
            this.log(`workspace ${this.name}: ${result.edges.length} edges, ${viewFiles.size} view files`);
        } catch (e) {
            if (seq !== this.seq) return;
            this.error = e instanceof Error ? e.message : String(e);
            this.log(`workspace ${this.name}: ${this.error}`);
        }
        this.fire();
    }

    /** The context of the reads; undefined before the first refresh. */
    context(): ModelContext | undefined {
        return this.ctx;
    }

    /** The view IRI of a view file of this folder (the last refresh); undefined when the file is not one. */
    viewOfFile(file: string): string | undefined {
        for (const [iri, f] of this.viewFiles) if (f === file) return iri;
        return undefined;
    }

    /**
     * The view of the document `file` as the server has it now (the open buffer wins over the saved file): its IRI, or why the canvas cannot
     * edit it. Undefined: the document has no view:View graph (a model file).
     */
    async viewOfDocument(file: string): Promise<{ iri: string } | { problem: string } | undefined> {
        const ctx = this.context();
        if (!ctx) return { problem: this.error ?? 'The model is not read yet.' };
        const { views, skipped } = await viewFilesOf(ctx.port, [file]);
        if (skipped.length) return { problem: `${file}: ${skipped[0].reason}: a view file holds one.` };
        const iris = [...views.keys()];
        if (!iris.length) return undefined;
        const problem = await viewFileProblem(file, iris[0], (await this.documentOf(file, false))?.text);
        return problem ? { problem } : { iri: iris[0] };
    }

    /** The diagram of the view `viewId` from turtle/query: the open buffer of its document wins over the saved file. */
    async diagram(viewId: string, opts: DiagramOptions): Promise<Drawn> {
        const ctx = this.context();
        if (!ctx) return emptyDrawn();
        const generation = this.generation, key = viewIriOf(viewId) ?? viewId;
        const entry = this.keptFigures.get(key);
        const kept = entry?.generation === generation ? entry.kept : undefined;
        const epoch = this.drawingEpoch;
        const file = ctx.views.get(key), document = file && await this.documentOf(file, false);
        if (document) {
            const phase1 = drawFromText(ctx, viewId, document.text, kept, opts);
            setTimeout(() => {
                void completeDrawing(ctx, viewId, phase1.drawn, phase1.misses).then(async drawn => {
                    const current = await this.documentOf(file!, false);
                    if (generation !== this.generation || epoch !== this.drawingEpoch || current?.version !== document.version || current.text !== document.text) return;
                    if (drawn.kept) this.keptFigures.set(key, { generation, kept: drawn.kept });
                    this.fire({ viewId, drawn, base: phase1.drawn });
                }).catch(e => this.log(`workspace ${this.name}: drawing completion: ${String(e)}`));
            }, 0);
            return phase1.drawn;
        }
        const drawn = await diagramOf(ctx, viewId, { ...opts, kept });
        // An old draw must not overwrite the state of a newer model generation.
        if (drawn.kept && generation === this.generation) this.keptFigures.set(key, { generation, kept: drawn.kept });
        return drawn;
    }

    /** The pickers of the halo and of "+ member" from turtle/query (read/choices.ts); none before the first refresh. */
    async expandChoices(viewId: string, from: string, dir: 'in' | 'out' | 'targets'): Promise<Choices | undefined> {
        const ctx = this.context(), key = viewIriOf(viewId) ?? viewId, file = ctx?.views.get(key);
        if (!ctx || !file) return undefined;
        // The view text (the open buffer, else the file as the server has it) and the view's answer kept by the last draw.
        const entry = this.keptFigures.get(key), kept = entry?.generation === this.generation ? entry.kept : undefined;
        const text = (await this.documentOf(file, false))?.text ?? await viewTextOf(ctx, file);
        return expandChoices(ctx, viewId, text, from, dir, kept);
    }

    async memberOptions(viewId: string, collection: string): Promise<string[]> {
        const ctx = this.context(), file = ctx?.views.get(viewIriOf(viewId) ?? viewId);
        if (!ctx || !file) return [];
        return memberOptions(ctx, viewId, (await this.documentOf(file, false))?.text ?? await viewTextOf(ctx, file), collection);
    }

    async instancesNamed(text: string): Promise<string[]> {
        const ctx = this.context();
        return ctx ? instancesNamed(ctx, text) : [];
    }

    /** Diagnostics of turtle-lsp as SHACL violations: one turtle/query for the focus terms. A later call wins over an earlier one. */
    async readDiagnostics(): Promise<void> {
        const ctx = this.context(), result = this.result, seq = ++this.diagnosticsSeq;
        if (!ctx || !result) return;
        try {
            const violations = await diagnosticsOf(ctx, result, this.diagnosticsByUri(), uri => this.textOf(uri));
            if (seq === this.diagnosticsSeq) this.violations = violations;
        } catch (e) {
            this.log(`workspace ${this.name}: diagnostics: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}
