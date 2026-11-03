// Define graph identities and encode file graph names; adapted from Catenary packages/rdf/src/graph-names.ts.
import type { GraphNames } from '../rdf-core/graph';


/**
 * The union graph: the model resource (subject of dct:conformsTo and the label of the model, in the data file), the graph name of the data in TriG text
 * (workspace files, test fixtures), and the model graph when there is no data file. Files contain this value: do not change it.
 */
export const UNION_GRAPH = 'urn:name:model';

/** The SHACL report of the last validation: derived, not saved, not in undo, not in the canonical form. */
export const REPORT_GRAPH = 'urn:catenary:report';


/** Store graph of a file: the prefix and the encoded absolute path. */
const SHAPES_GRAPH_PREFIX = 'urn:shapes:';

const DATA_GRAPH_PREFIX = 'urn:data:';

export const dataGraphIri = (file: string) => DATA_GRAPH_PREFIX + encodeURI(file);

export const shapesGraphIri = (file: string) => SHAPES_GRAPH_PREFIX + encodeURI(file);

/** File of a store graph (its path), or the graph IRI when it has no path. */
export const fileOfGraph = (graph: string) => {
    const prefix = [SHAPES_GRAPH_PREFIX, DATA_GRAPH_PREFIX].find(p => graph.startsWith(p));
    const rest = prefix ? graph.slice(prefix.length) : graph;
    try { return decodeURI(rest); } catch { return rest; }
};


export const CATENARY_GRAPH_NAMES: GraphNames = {
    union: UNION_GRAPH,
    report: REPORT_GRAPH,
    data: dataGraphIri,
    shapes: shapesGraphIri,
    fileOf: graph => [SHAPES_GRAPH_PREFIX, DATA_GRAPH_PREFIX].some(p => graph.startsWith(p)) ? fileOfGraph(graph) : undefined
};

