// The model facts that a view edit reads: plain lookups, filled by one prefetch query per command (K9). No graph, no store.
import type { NamedNode, Quad } from '@rdfjs/types';
import type { ShapesIndex } from '../catenary/rdf/shapes-read';

export interface Facts {
    /** The shapes model: node shapes, property shapes, value sets, pills. */
    shapes: ShapesIndex;
    /** An instance of the model (vocabulary.ts `isInstance`): an IRI with rdf:type or rdfs:label in a model file, or a SKOS subject of a shapes file. */
    isInstance(iri: string): boolean;
    /** The label of an instance or another element of the model. */
    label(iri: string): string;
    /** A view of the workspace. */
    isView(iri: string): boolean;
    /** The label of a view, from its own file. */
    viewLabel(iri: string): string;
    /** The model has the statement `s p o` (in the file that holds `s`). */
    has(s: string, p: string, o: string): boolean;
    /** The shape card of an id (shapes-read.ts `shapesCardTerm`) when the IRI of the id has a statement in a shapes file. */
    shapesCard(id: string): NamedNode | undefined;
    /** The relations among `iris`: statements of the model whose subject and object are both in `iris` and are instances (type or label), not rdf:type or rdfs:label. */
    statementsAmong(iris: string[]): Quad[];
}
