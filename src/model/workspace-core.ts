// The platform-free part of one folder's workspace: the model records read through turtle/query (the canvas draws from them), and until
// K10 the old graph with the open view stores for the edits. The VS Code host (node/workspace-model.ts) and the browser page
// (web/workspace.ts) supply the port, the turtle-lsp graph, the view files and the diagnostics.
import { fileURLToPath } from 'node:url';
import type { Diagnostic } from 'vscode';
import type { ViewCommand } from '../catenary/model/commands';
import { iriId } from '../catenary/model/ids';
import { skolemize } from '../catenary/rdf-core/skolem';
import type { Patch } from '../catenary/rdf-core/graph';
import type { ModelGraph } from '../catenary/rdf/graph';
import { parseRdfSync } from '../catenary/rdf-files/oxigraph-store';
import { readLegacy } from '../catenary/rdf/loader';
import { fail, type Result } from '../catenary/rdf/ops';
import { rdf } from '../catenary/rdf/terms';
import { V } from '../catenary/rdf/views';
import type { Violation } from '../catenary/model/validation';
import { graphOf } from './graph-input';
import { ViewStore } from './store';
import type { ViewSource } from '../node/glsp/view-session';
import type { GraphResult } from '../node/turtle-api';
import { type DiagramOptions, type Drawn, type ModelContext, diagramOf, emptyDrawn, modelContextOf } from '../read/diagram';
import { diagnosticsOf } from '../read/diagnostics';
import type { ManifestRecords } from '../read/manifest';
import type { ShapesModelRecords } from '../read/shapes';
import { expandChoices, instancesNamed, memberOptions } from '../read/choices';
import type { Choices } from '../catenary/model/prompts';
import type { ModelPort } from './port';

/** The quads of a view file, as graphOf reads them. */
function viewQuads(text: string) {
    return skolemize(readLegacy(parseRdfSync(text, 'application/trig')).quads).quads;
}

/** A view open in an editor: its store, and the editor step of each edit. */
export interface OpenView {
    readonly iri: string;
    readonly store: ViewStore;
    /** One step of the edit history of the document: one store step and its patch. */
    step(label: string, patch: Patch): void;
}

export interface Releasable { dispose(): void }

export abstract class WorkspaceCore implements ViewSource {
    /** The old graph, for the write path (execute, open view stores) until K10; undefined before the first answer. */
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
    /** The views open in an editor, by view id. */
    protected readonly open = new Map<string, OpenView & { references: number; steps: Set<OpenView['step']> }>();

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
    protected abstract log(line: string): void;
    protected abstract warn(message: string): void;

    onDidChange(listener: () => void): Releasable {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    protected fire(): void {
        for (const listener of [...this.listeners]) listener();
    }

    /** One store per IRI; a caller without a step callback is a read-only reference (export). */
    openView(iri: string, step?: OpenView['step'], close: () => void = () => undefined): OpenView & Releasable {
        if (!this.graph) throw new Error(this.error ?? 'The workspace graph is not read yet.');
        const id = iriId(iri);
        let view = this.open.get(id);
        if (!view) {
            const steps = new Set<OpenView['step']>();
            view = { iri, store: new ViewStore(this.graph), references: 0, steps,
                step: (label, patch) => steps.values().next().value?.(label, patch) };
            this.open.set(id, view);
        }
        const shared = view;
        shared.references++;
        if (step) shared.steps.add(step);
        let released = false;
        return { iri, store: shared.store, step: shared.step, dispose: () => {
            if (released) return;
            released = true;
            if (step) shared.steps.delete(step);
            if (--shared.references !== 0) return;
            this.open.delete(id);
            close();
        } };
    }

    /**
     * One edit of the open view `viewId`: a store step is a step of its document. Refused when no editor has the view open. A step that
     * changes several views (a paste of a cut: moveBetweenViews) is one step in each of their documents, with the changes of its view;
     * it is undone and refused when one of the views is not open in an editor.
     */
    execute(viewId: string, command: ViewCommand): Result<unknown> {
        const view = this.open.get(viewId);
        if (!view?.steps.size) return fail('The view is not open in an editor.');
        const last = view.store.last;
        const r = view.store.execute(command);
        const patch = view.store.last;
        if (r.ok && patch && patch !== last) {
            const graphs = [...new Set(patch.map(c => c.quad.graph.value))];
            const closed = graphs.filter(g => !this.open.get(iriId(g))?.steps.size);
            if (closed.length) {
                view.store.graph.undo(patch);
                return fail(`Open the view ${closed.join(', ')} in an editor: the edit changes it.`);
            }
            for (const g of graphs) this.open.get(iriId(g))!.step(command.kind, patch.filter(c => c.quad.graph.value === g));
            this.fire();
        }
        return r;
    }

    /** After an undo or redo of an open view: the sessions draw again. */
    redraw(): void {
        this.fire();
    }

    /** The view graph `iri` becomes the statements of the TriG `text` (revert, backup restore). */
    replaceView(iri: string, text: string): void {
        const graph = this.graph;
        if (!graph) return;
        const g = rdf.namedNode(iri), quads = viewQuads(text).filter(q => q.graph.equals(g));
        graph.update(() => {
            graph.removeMatches(null, null, null, g);
            for (const q of quads) graph.add(q.subject, q.predicate, q.object, q.graph);
        });
        this.fire();
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
            if (this.graph) this.keepOpenViews(this.graph, graph);
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
    context(): ModelContext | undefined {
        return this.ctx;
    }

    /** The diagram of the view `viewId` from turtle/query: the saved view file (an unsaved canvas edit is not drawn until K10). */
    async diagram(viewId: string, opts: DiagramOptions): Promise<Drawn> {
        const ctx = this.context();
        return ctx ? diagramOf(ctx, viewId, opts) : emptyDrawn();
    }

    /** The pickers of the halo and of "+ member" from turtle/query (read/choices.ts); none before the first refresh or without a port. */
    async expandChoices(viewId: string, from: string, dir: 'in' | 'out' | 'targets'): Promise<Choices | undefined> {
        const ctx = this.context();
        return ctx ? expandChoices(ctx, viewId, from, dir) : undefined;
    }

    async memberOptions(viewId: string, collection: string): Promise<string[]> {
        const ctx = this.context();
        return ctx ? memberOptions(ctx, viewId, collection) : [];
    }

    async instancesNamed(text: string): Promise<string[]> {
        const ctx = this.context();
        return ctx ? instancesNamed(ctx, text) : [];
    }

    /**
     * The open views keep their view graph (it can differ from the file: unsaved edits) and their store, on the new graph. Blank nodes of
     * the model get new ids from turtle-lsp: a placed element whose id is gone stays in the view graph and is not drawn (log line).
     */
    protected keepOpenViews(from: ModelGraph, to: ModelGraph): void {
        for (const view of this.open.values()) {
            const g = rdf.namedNode(view.iri);
            to.update(() => {
                to.removeMatches(null, null, null, g);
                for (const q of from.match(null, null, null, g)) to.add(q.subject, q.predicate, q.object, q.graph);
            });
            view.store.graph = to;
            const gone = to.match(null, V.element, null, g).filter(q => !to.match(q.object, null, null).some(m => !m.graph.equals(g)));
            for (const q of gone) this.log(`workspace ${this.name}: ${view.iri}: placed element ${q.object.value} is not in the model; it is not drawn`);
        }
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
