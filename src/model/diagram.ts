// Derive a diagram from workspace quads, view figures and turtle-lsp diagnostics using the copied notation engine.
import type { Violation } from '../catenary/model/validation';
import type { ElementSchema } from '../catenary/model/diagram-schema';
import { hiddenShapeSources } from '../catenary/model/shapes-schema';
import { iriId } from '../catenary/model/ids';
import { toSchema } from '../catenary/model/view-schema';
import { authoringMetamodel } from '../catenary/rdf/authoring';
import type { ModelGraph } from '../catenary/rdf/graph';
import { viewFiguresOf } from '../catenary/rdf/notations';
import { hiddenNeighborCounts } from '../catenary/rdf/scoped-doc';
import { shapesIndexOf } from '../catenary/rdf/shapes-read';
import { buildVocabulary, shapesTriples, vocabularyQuads } from '../catenary/rdf/shapes';
import { rdf } from '../catenary/rdf/terms';
import { readView } from '../catenary/rdf/view-read';
import { graphPrefixes } from './graph-input';

/** `cardScale`: the card text scale of the canvas (Catenary's catenarySetCardScale); default 1. */
export interface DiagramOptions { cardScale?: number; violations?: Violation[] }

/** Catenary's ViewGModelFactory options, with turtle-lsp input and diagnostics. Accepts a view IRI or its element id. */
export function diagramOf(graph: ModelGraph, viewId: string, opts: DiagramOptions = {}): ElementSchema {
    graphPrefixes(graph);
    const id = viewId.includes(':') ? iriId(viewId) : viewId;
    const part = readView(graph, id, shapesIndexOf(graph).model), view = part.views[id];
    const dataset = rdf.dataset([...shapesTriples(graph), ...vocabularyQuads(graph).map(q => rdf.quad(q.subject, q.predicate, q.object))]);
    const meta = authoringMetamodel(graph, buildVocabulary(dataset, graph.language));
    const schemes = new Map((meta.schemes ?? []).map(x => [x.iri, x.label]));
    const neighbors = view ? hiddenNeighborCounts(graph, part.shapes, view) : new Map();
    return toSchema(part, meta, id, {
        cardScale: opts.cardScale ?? 1, violations: opts.violations ?? [], schemeLabel: iri => schemes.get(iri) ?? iri.replace(/^.*[#/:]/, ''),
        hidden: { neighbors: x => neighbors.get(x), shapeSources: x => hiddenShapeSources(part.shapes, view, x).length },
        notation: view ? viewFiguresOf(graph, view.uri) : undefined
    });
}
