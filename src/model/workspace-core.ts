// The platform-free part of one folder's workspace: the model records read through turtle/query (the canvas draws from them and the
// commands read them), and the old graph of the pickers until K7. A command edits the text of the view documents (src/edit/executor.ts);
// the host applies the edits. The VS Code host (node/workspace-model.ts) and the browser page (web/workspace.ts) supply the port, the
// turtle-lsp graph, the view files, the documents and the diagnostics.
import { fileURLToPath } from 'node:url';
import type { Diagnostic } from 'vscode';
import type { ViewCommand } from '../catenary/model/commands';
import { idIri } from '../catenary/model/ids';
import type { ModelGraph } from '../catenary/rdf/graph';
import type { Violation } from '../catenary/model/validation';
import { runCommand, type ViewEdit, type ViewInput } from '../edit/executor';
import { fail, type Result } from '../edit/ops';
import { graphOf } from './graph-input';
import type { ViewSource } from '../node/glsp/view-session';
import type { GraphResult } from '../node/turtle-api';
import { type DiagramOptions, type Drawn, type ModelContext, diagramOf, emptyDrawn, modelContextOf } from '../read/diagram';
import { diagnosticsOf } from '../read/diagnostics';
import type { ManifestRecords } from '../read/manifest';
import type { ShapesModelRecords } from '../read/shapes';
import { expandChoices, instancesNamed, memberOptions } from './choices';
import type { ModelPort } from './port';
import { viewFilesOf } from './view-files';

export interface Releasable { dispose(): void }

/** The IRI of a view given by its IRI or its element id. */
const viewIriOf = (view: string) => view.includes(':') ? view : idIri(view);

/** The sessions draw again this long after the last change of a view document. */
const REDRAW_MS = 100;

export abstract class WorkspaceCore implements ViewSource {
    /** The old graph of the pickers until K7 (read from the saved view files); undefined before the first answer. */
    graph: ModelGraph | undefined;
    /** The turtle/graph answer: node ranges of the diagnostics. */
    result: GraphResult | undefined;
    /** View IRI to its workspace file path (viewFilesOf; without a port: graphOf), refreshed on each refresh. */
    readonly viewFiles = new Map<string, string>();
    /** The model documents without the manifest document (ShapesModelRecords.files). */
    modelFiles: string[] = [];
    /** The shapes model of the model documents, computed once per refresh; undefined before the first answer or without a port. */
    shapes: ShapesModelRecords | undefined;
    manifest: ManifestRecords = {};
    /** Incremented on each refresh that succeeds. */
    generation = 0;
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
    protected readonly listeners = new Set<() => void>();
    /** The last command started: the next command reads the views after its edits. */
    protected commands: Promise<unknown> = Promise.resolve();

    /** A short name of the folder, for log lines. */
    protected abstract readonly name: string;
    /** turtle/query of this host; undefined: the host has none (the browser page until K13), the old graph draws. */
    protected abstract readonly port: ModelPort | undefined;
    /** turtle-lsp `turtle/graph`, limited to the documents of this folder. */
    protected abstract requestGraph(): Promise<GraphResult>;
    /** The view file paths of this folder, sorted. */
    protected abstract viewFilePaths(): Promise<string[]>;
    /** The diagnostics of this folder by document URI, with VS Code severities (0 error … 3 hint). */
    protected abstract diagnosticsByUri(): Record<string, Diagnostic[]>;
    /** The text of a document URI; '' when it cannot be read. */
    protected abstract textOf(uri: string): string;
    /**
     * The document of a view file: its URI and its text. `load` false: undefined when no editor has the document open; true: the host opens
     * it without showing it (the language server receives it).
     */
    protected abstract documentOf(file: string, load: boolean): Promise<{ uri: string; text: string } | undefined>;
    /** Applies the edits as one edit of the workspace (one undo step in each document); false when the host refuses it. */
    protected abstract applyEdits(edits: ViewEdit[]): Promise<boolean>;
    protected abstract log(line: string): void;
    protected abstract warn(message: string): void;

    onDidChange(listener: () => void): Releasable {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    protected fire(): void {
        for (const listener of [...this.listeners]) listener();
    }

    protected redrawTimer: ReturnType<typeof setTimeout> | undefined;

    /** A view document changed (a canvas edit, an undo, a text editor): the sessions draw again after REDRAW_MS without a change. */
    viewChanged(): void {
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
        const views: ViewInput[] = [];
        for (const v of new Set(iris)) {
            const file = v && this.viewFiles.get(v);
            if (!v || !file) return fail(`The view ${v ?? ''} has no view file in ${this.name}.`);
            const document = await this.documentOf(file, v !== iri);
            if (!document) return fail('The view is not open in an editor.');
            views.push({ iri: v, ...document });
        }
        const { edits, ...r } = await runCommand(ctx, views, command);
        if (r.ok && edits.length && !await this.applyEdits(edits)) return fail('The editor refused the edit of the view file.');
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
            const views = await this.viewFilePaths();
            const old = graphOf(result, views);
            // The RDF documents of the folder: the documents of the turtle/graph answer (requestGraph keeps this folder's).
            const documents = [...new Set(result.edges.map(e => e.uri).filter(u => u.startsWith('file:')))].map(u => fileURLToPath(u)).sort();
            const records = this.port ? await modelContextOf(this.port, documents) : undefined;
            if (seq !== this.seq) return;
            const { graph } = old, { views: viewFiles, skipped } = records?.viewFiles ?? old;
            for (const { file, reason } of skipped) this.log(`workspace ${this.name}: skipped ${file}: ${reason}`);
            if (skipped.length) this.warn(`Catenary: skipped ${skipped.length} view file(s) in ${this.name}. See the Catenary output for details.`);
            this.viewFiles.clear();
            for (const [iri, file] of viewFiles) this.viewFiles.set(iri, file);
            this.graph = graph;
            this.result = result;
            if (records) ({ manifest: this.manifest, shapes: this.shapes, modelFiles: this.modelFiles } = this.ctx = records.ctx);
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

    /** The context of the reads; undefined before the first refresh or without a port. */
    protected context(): ModelContext | undefined {
        return this.ctx;
    }

    /** The view IRI of a view file of this folder (the last refresh); undefined when the file is not one. */
    viewOfFile(file: string): string | undefined {
        for (const [iri, f] of this.viewFiles) if (f === file) return iri;
        return undefined;
    }

    /** True when the server has a view:View graph in the document `file`, also when the folder skipped it (a duplicate). */
    async holdsView(file: string): Promise<boolean> {
        const ctx = this.context();
        if (!ctx) return false;
        const { views, skipped } = await viewFilesOf(ctx.port, [file]);
        return views.size > 0 || skipped.length > 0;
    }

    /** The diagram of the view `viewId` from turtle/query: the open buffer of its document wins over the saved file. */
    async diagram(viewId: string, opts: DiagramOptions): Promise<Drawn> {
        const ctx = this.context();
        return ctx ? diagramOf(ctx, viewId, opts) : emptyDrawn();
    }

    /** The pickers on the old graph until K7. */
    expandChoices(viewId: string, from: string, dir: 'in' | 'out' | 'targets') {
        return this.graph ? expandChoices(this.graph, viewId, from, dir) : undefined;
    }

    memberOptions(viewId: string, collection: string): string[] {
        return this.graph ? memberOptions(this.graph, viewId, collection) : [];
    }

    instancesNamed(text: string): string[] {
        return this.graph ? instancesNamed(this.graph, text) : [];
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
