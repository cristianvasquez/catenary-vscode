// The diagram of a view from turtle/query answers: the Doc (viewDocOf), the hidden neighbours, the notation figures, then toSchema (pure).
import { Parser, Writer } from 'n3';
import { viewDocFromText } from './view-text';
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
import { hiddenNeighborCounts } from './neighbors';
import { shapesModelOf, type ShapesModelRecords } from './shapes';
import { viewDocOf, viewGraphsOf, type ViewGraph } from './view';

/**
 * What a read of the model needs. `modelFiles`: the model documents WITHOUT the manifest document (`shapes.files`): the manifest is not
 * part of the model, and shapeTargetMatches, hiddenNeighborCounts and viewFiguresOf do not remove it themselves.
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

/** The schema of a view, the Doc it is drawn from, and its notation figures (undefined: no view). */
export interface Drawn { schema: ElementSchema; doc: Doc; figures?: ViewFigures; kept?: KeptPrefetch; phase?: 1 | 2; options?: DiagramOptions }

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
    const quads = await ctx.port.construct('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', [file]);
    const first = drawFromText(ctx, viewId, new Writer({ format: 'application/trig' }).quadsToString(quads), opts.kept, opts);
    return completeDrawing(ctx, viewId, first.drawn, first.misses);
}

/** Phase 1: no port calls, including when there is no retained index yet. */
export function drawFromText(ctx: ModelContext, viewId: string, viewText: string, kept?: KeptPrefetch, opts: DiagramOptions = {}) {
    const retained = kept ?? emptyPrefetch(ctx.shapes);
    const iri = viewId.includes(':') ? viewId : idIri(viewId);
    if (!iri || !ctx.views.has(iri)) return { drawn: emptyDrawn(), misses: 0, kept };
    const quads = new Parser({ format: 'application/trig' }).parse(viewText);
    const doc = viewDocFromText(ctx, iri, quads, retained);
    const figures = figuresFromText(iri, quads, retained);
    applyPrefixes(ctx.manifest);
    const schema = toSchema(doc, ctx.shapes.meta, iriId(iri), {
        cardScale: opts.cardScale ?? 1, violations: [], notation: figures,
        hidden: { neighbors: () => undefined, shapeSources: () => 0 }
    });
    const drawn: Drawn = { schema, doc, figures, kept, phase: 1, options: opts };
    return { drawn, misses: figures.misses, kept };
}

/** Phase 2: model records, missed figure reads, hidden counts, targets and diagnostics. */
export async function completeDrawing(ctx: ModelContext, viewId: string, drawn: Drawn, _misses: number): Promise<Drawn> {
    const opts = { ...drawn.options, kept: drawn.kept };
    const { port, modelFiles, shapes, manifest, views } = ctx;
    const iri = viewId.includes(':') ? viewId : idIri(viewId), id = viewId.includes(':') ? iriId(viewId) : viewId;
    if (!iri) return emptyDrawn();
    const doc = await viewDocOf(port, views, iri, shapes, manifest, { viewLabels: ctx.viewLabels }), view = doc.views[id], file = view && views.get(view.uri);
    if (!view || !file) return { ...emptyDrawn(), doc };
    const [neighbors, figures] = await Promise.all([hiddenNeighborCounts(port, modelFiles, shapes, view), viewFiguresOf(port, view.uri, file, shapes, modelFiles, [], opts.kept)]);
    // After the queries: another workspace can set the prefix table while this one waits; toSchema below is synchronous.
    applyPrefixes(manifest);
    const schemes = new Map((shapes.meta.schemes ?? []).map(x => [x.iri, x.label]));
    const schema = toSchema(doc, shapes.meta, id, {
        cardScale: opts.cardScale ?? 1, violations: opts.violations ?? [], schemeLabel: iri => schemes.get(iri) ?? iri.replace(/^.*[#/:]/, ''),
        hidden: { neighbors: x => neighbors.get(x), shapeSources: x => hiddenShapeSources(doc.shapes, view, x).length },
        notation: figures
    });
    const kept = { ...figures.kept, records: { instances: { ...drawn.kept?.records?.instances, ...doc.instances }, relations: { ...drawn.kept?.records?.relations, ...doc.relations } } };
    return { schema, doc, figures, kept, phase: 2 };
}
