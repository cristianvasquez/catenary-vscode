// Define graph identities and encode file graph names; adapted from Catenary packages/rdf/src/graph-names.ts.
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GraphNames } from '../rdf-core/graph';


/**
 * The union graph: the model resource (subject of dct:conformsTo and the label of the model, in the data file), the graph name of the data in TriG text
 * (workspace files, test fixtures), and the model graph when there is no data file. Files contain this value: do not change it.
 */
export const UNION_GRAPH = 'urn:name:model';

/** The SHACL report of the last validation: derived, not saved, not in undo, not in the canonical form. */
export const REPORT_GRAPH = 'urn:catenary:report';


/** Store graphs of a model file: its file URI (as turtle-lsp names the document) holds the data, the same IRI with `#shapes` the shapes. */
const SHAPES_FRAGMENT = '#shapes';

export const dataGraphIri = (file: string) => pathToFileURL(file).href;

export const shapesGraphIri = (file: string) => dataGraphIri(file) + SHAPES_FRAGMENT;

/** File of a store graph (its path), or the graph IRI when it is not a file URI. */
export const fileOfGraph = (graph: string) => {
    const iri = graph.endsWith(SHAPES_FRAGMENT) ? graph.slice(0, -SHAPES_FRAGMENT.length) : graph;
    if (!iri.startsWith('file:')) return iri;
    try { return fileURLToPath(iri); } catch { return iri; }
};


export const CATENARY_GRAPH_NAMES: GraphNames = {
    union: UNION_GRAPH,
    report: REPORT_GRAPH,
    data: dataGraphIri,
    shapes: shapesGraphIri,
    fileOf: graph => graph.startsWith('file:') ? fileOfGraph(graph) : undefined
};
