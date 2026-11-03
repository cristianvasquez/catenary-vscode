// Expose the core graph under the RDF module's type and value names; adapted from Catenary packages/rdf/src/graph.ts.
import { ModelGraph as CoreModelGraph } from '../rdf-core/graph';


export type ModelGraph = CoreModelGraph;

export const ModelGraph = CoreModelGraph;

