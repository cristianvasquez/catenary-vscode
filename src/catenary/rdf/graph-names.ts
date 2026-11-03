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


/** Store graph of a file: its file URI, as turtle-lsp names the document. */
export const fileGraphIri = (file: string) => pathToFileURL(file).href;

/** File of a store graph (its path), or the graph IRI when it is not a file URI. */
export const fileOfGraph = (graph: string) => {
    if (!graph.startsWith('file:')) return graph;
    try { return fileURLToPath(graph); } catch { return graph; }
};


export const CATENARY_GRAPH_NAMES: GraphNames = {
    union: UNION_GRAPH,
    report: REPORT_GRAPH,
    file: fileGraphIri,
    fileOf: graph => graph.startsWith('file:') ? fileOfGraph(graph) : undefined
};

