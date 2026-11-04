// The diagram of a view from turtle/query answers: the figure prefetch (the answer of the view), the Doc (viewDocOf: the view text and the
// answer), the hidden neighbours (from the answer), the target badges (two count queries), then toSchema (pure).
import type { Quad } from '@rdfjs/types';
import { Parser, Writer } from 'n3';
import { pathToFileURL } from 'node:url';
import type { Doc } from '../catenary/model/doc';
import { emptyDoc } from '../catenary/model/doc';
import { type ElementSchema, TYPES } from '../catenary/model/diagram-schema';
import { idIri, iriId } from '../catenary/model/ids';
import type { ViewFigures } from '../catenary/model/notation-join';
import { hiddenShapeSources } from '../catenary/model/shapes-schema';
import type { Violation } from '../catenary/model/validation';
import { toSchema } from '../catenary/model/view-schema';
import type { ModelPort } from '../model/port';
import { modelFilesOf, type ViewFiles, viewFilesOf } from '../model/view-files';
import { applyPrefixes, manifestOf, type ManifestRecords } from './manifest';
import { emptyPrefetch, figuresFromText, viewFiguresOf, type KeptPrefetch } from './figures';
import { hiddenNeighborCounts, neighborMisses, viewBadges } from './neighbors';
import { shapesModelOf, type ShapesModelRecords } from './shapes';
import { viewDocOf, type ViewDocOptions, viewGraphsOf, type ViewGraph } from './view';

/**
 * What a read of the model needs. `modelFiles`: the model documents WITHOUT the manifest document (`shapes.files`): the manifest is not
 * part of the model, and shapeTargetMatches, targetBadges and viewFiguresOf do not remove it themselves.
 */
export interface ModelContext {
    port: ModelPort;
    modelFiles: string[];
    shapes: ShapesModelRecords;
    manifest: ManifestRecords;
    /** View IRI → file path of its view file (viewFilesOf). */
    views: Map<string, string>;
    /** View metadata read once per refresh; the drawn view is re-read from its file. */
    viewLabels: Map<string, ViewGraph>;
}

/** `port` with the queries without `files` restricted to `documents`: the port of the window answers for every folder (multi-root). */
function scopedPort(port: ModelPort, documents: string[]): ModelPort {
    return {
        select: (query, files) => port.select(query, files ?? documents),
        construct: (query, files) => port.construct(query, files ?? documents),
        ask: (query, files) => port.ask(query, files ?? documents),
    };
}

/**
 * The context of the RDF `documents` of a folder (file paths), and its view files: the view files among the `.trig` documents (viewFilesOf),
 * the manifest and the shapes model of the other documents. `modelFiles` = `shapes.files`. The context port reads `documents` only.
 */
export async function modelContextOf(window: ModelPort, documents: string[]): Promise<{ ctx: ModelContext; viewFiles: ViewFiles }> {
    const port = scopedPort(window, documents);
    const viewFiles = await viewFilesOf(port, documents.filter(f => f.endsWith('.trig')));
    const files = modelFilesOf(documents, viewFiles), manifest = await manifestOf(port, files);
    const [shapes, viewLabels] = await Promise.all([shapesModelOf(port, files, manifest), viewGraphsOf(port, viewFiles.views)]);
    return { ctx: { port, modelFiles: shapes.files, shapes, manifest, views: viewFiles.views, viewLabels }, viewFiles };
}

/** `cardScale`: the card text scale of the canvas (Catenary's catenarySetCardScale); default 1. */
export interface DiagramOptions { cardScale?: number; violations?: Violation[]; kept?: KeptPrefetch }

/** The schema of a view, the Doc it is drawn from, and its notation figures (undefined: no view). `reads`: the misses of the Doc of phase 1 (viewDocOf). */
export interface Drawn { schema: ElementSchema; doc: Doc; figures?: ViewFigures; kept?: KeptPrefetch; phase?: 1 | 2; options?: DiagramOptions; reads?: string[] }

export interface DrawingUpdate { viewId: string; drawn: Drawn; base: Drawn }

/** Copy layout only; phase 2 is not a layout operation. */
export function keepGeometry(schema: ElementSchema, base: ElementSchema): ElementSchema {
    const byId = new Map<string, ElementSchema>();
    const collect = (e: ElementSchema) => { byId.set(e.id, e); e.children?.forEach(collect); };
    collect(base);
    const copy = (e: ElementSchema): ElementSchema => {
        const old = byId.get(e.id), result = { ...e };
        if (old) for (const p of ['position', 'size', 'vertices'] as const) {
            if (p in old) Object.assign(result, { [p]: old[p] });
            else delete result[p];
        }
        if (e.children) result.children = e.children.map(copy);
        return result;
    };
    return copy(schema);
}

/** The diagram of no view: an empty root, an empty Doc. */
export const emptyDrawn = (): Drawn => ({ schema: { type: TYPES.GRAPH, id: 'root', children: [] }, doc: emptyDoc() });

/** diagramOf of model/diagram.ts over the port. Accepts a view IRI or its element id; a view that is not in the model gives emptyDrawn. */
export async function diagramOf(ctx: ModelContext, viewId: string, opts: DiagramOptions = {}): Promise<Drawn> {
    const iri = viewId.includes(':') ? viewId : idIri(viewId), file = iri && ctx.views.get(iri);
    if (!file) return emptyDrawn();
    const served = await ctx.port.construct('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', [file]);
    const first = drawFromText(ctx, viewId, new Writer({ format: 'application/trig' }).quadsToString(served), opts.kept, opts);
    return completeDrawing(ctx, viewId, first.drawn, first.misses, served);
}

/** The text of the view file `file` as the server has it (one turtle/query): for a view that no editor has open. */
export async function viewTextOf(ctx: ModelContext, file: string): Promise<string> {
    return new Writer({ format: 'application/trig' }).quadsToString(await ctx.port.construct('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', [file]));
}

/** Phase 1: no port calls, including when there is no retained index yet. */
export function drawFromText(ctx: ModelContext, viewId: string, viewText: string, kept?: KeptPrefetch, opts: DiagramOptions = {}) {
    const retained = kept ?? emptyPrefetch(ctx.shapes);
    const iri = viewId.includes(':') ? viewId : idIri(viewId);
    if (!iri || !ctx.views.has(iri)) return { drawn: emptyDrawn(), misses: 0, kept };
    const quads = new Parser({ format: 'application/trig', baseIRI: pathToFileURL(ctx.views.get(iri)!).href }).parse(viewText);
    const reads = new Set<string>();
    const doc = viewDocOf(ctx, iri, quads, retained, { misses: reads });
    const figures = figuresFromText(iri, quads, retained);
    applyPrefixes(ctx.manifest);
    const schema = toSchema(doc, ctx.shapes.meta, iriId(iri), {
        cardScale: opts.cardScale ?? 1, violations: [], notation: figures,
        hidden: { neighbors: () => undefined, shapeSources: () => 0 }
    });
    const drawn: Drawn = { schema, doc, figures, kept, phase: 1, options: opts, reads: [...reads] };
    return { drawn, misses: figures.misses, kept };
}

/** At most this many prefetches for the misses of viewDocOf (the first reads what phase 1 missed; a second only for what that answer adds). */
const DOC_PREFETCHES = 3;

/**
 * The figure prefetch of the view with the reads of viewDocOf, then viewDocOf over its answer, until the Doc has no miss. The view quads
 * are those of the prefetch (the server's view file), read once: `served` when the caller has them.
 */
async function answered(ctx: ModelContext, iri: string, file: string, kept: KeptPrefetch | undefined, reads: string[], options: ViewDocOptions = {}, served?: Quad[]) {
    for (let i = 1; ; i++) {
        const figures = await viewFiguresOf(ctx.port, iri, file, ctx.shapes, ctx.modelFiles, [], kept, reads, served);
        served = figures.view;
        const misses = new Set<string>(), warnings: string[] = [];
        const doc = viewDocOf(ctx, iri, figures.view, figures.kept, { ...options, warnings, misses });
        kept = figures.kept;
        if (!misses.size || i === DOC_PREFETCHES) {
            options.warnings?.push(...warnings);
            return { doc, figures };
        }
        reads = [...misses];
    }
}

/**
 * The Doc of a view for a caller without a drawing (scopedDoc, the pickers): the view statements, viewDocOf on `kept` (or nothing) for its
 * misses, then the figure prefetch with those reads (answered).
 */
export async function viewDocRead(ctx: ModelContext, iri: string, options: ViewDocOptions & { kept?: KeptPrefetch } = {}): Promise<Doc> {
    const file = ctx.views.get(iri);
    if (!file) return emptyDoc();
    const { kept, ...rest } = options;
    const view = await ctx.port.construct('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', [file]);
    const reads = new Set<string>();
    viewDocOf(ctx, iri, view, kept ?? emptyPrefetch(ctx.shapes), { elements: rest.elements, misses: reads });
    return (await answered(ctx, iri, file, kept, [...reads], rest, view)).doc;
}

/**
 * Phase 2: the figure prefetch with the misses of phase 1 (none when the kept answer has every read of phase 1 and of the hidden
 * neighbours), the Doc from its answer, the hidden neighbours from the answer, the target badges (two queries at most). `served`: the
 * view statements of the server that phase 1 was drawn from, when the caller read them.
 */
export async function completeDrawing(ctx: ModelContext, viewId: string, drawn: Drawn, misses: number, served?: Quad[]): Promise<Drawn> {
    const opts = { ...drawn.options, kept: drawn.kept };
    const { shapes, manifest, views } = ctx;
    const iri = viewId.includes(':') ? viewId : idIri(viewId), id = viewId.includes(':') ? iriId(viewId) : viewId;
    const file = iri && views.get(iri);
    if (!iri || !file) return emptyDrawn();
    const shown = drawn.doc.views[id];
    const complete = opts.kept && drawn.figures && !misses && !drawn.reads?.length && shown && !neighborMisses(shapes, shown, opts.kept).length;
    const read = complete ? undefined : await answered(ctx, iri, file, opts.kept, drawn.reads ?? [], {}, served);
    const doc = read?.doc ?? drawn.doc, figures = read?.figures ?? drawn.figures!, answer = read?.figures.kept ?? opts.kept!;
    const view = doc.views[id];
    if (!view || !views.get(view.uri)) return { ...emptyDrawn(), doc };
    const neighbors = hiddenNeighborCounts(ctx, view, answer, await viewBadges(ctx, view));
    // After the queries: another workspace can set the prefix table while this one waits; toSchema below is synchronous.
    applyPrefixes(manifest);
    const schemes = new Map((shapes.meta.schemes ?? []).map(x => [x.iri, x.label]));
    const schema = toSchema(doc, shapes.meta, id, {
        cardScale: opts.cardScale ?? 1, violations: opts.violations ?? [], schemeLabel: iri => schemes.get(iri) ?? iri.replace(/^.*[#/:]/, ''),
        hidden: { neighbors: x => neighbors.get(x), shapeSources: x => hiddenShapeSources(doc.shapes, view, x).length },
        notation: figures
    });
    const kept = { ...answer, records: { instances: { ...drawn.kept?.records?.instances, ...doc.instances }, relations: { ...drawn.kept?.records?.relations, ...doc.relations } } };
    return { schema, doc, figures, kept, phase: 2 };
}
