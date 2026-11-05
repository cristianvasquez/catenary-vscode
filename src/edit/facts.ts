// The model facts that a view edit reads: plain lookups, filled by one prefetch query per command (facts-of.ts). No graph, no store.
import type { NamedNode, Quad } from '@rdfjs/types';
import type { ShapesIndex } from '../read/shapes-index';
import { NS } from '../catenary/model/terms';
import { elementTerm, rdf } from './terms';

export interface Facts {
    /** The shapes model: node shapes, property shapes, value sets, pills. */
    shapes: ShapesIndex;
    /** The language of the labels (the manifest). */
    language?: string;
    /** A card IRI, with or without statements: not UNION_GRAPH, a blank/skolem node, a view-file subject or a subject with only shapes-closure statements. */
    isInstance(iri: string): boolean;
    /** The label of an instance or another element of the model. */
    label(iri: string): string;
    /** A view of the workspace. */
    isView(iri: string): boolean;
    /** The label of a view, from its own file. */
    viewLabel(iri: string): string;
    /** The model has the statement `s p o` (in the file that holds `s`). */
    has(s: string, p: string, o: string): boolean;
    /** The shape card of an id (the old shapesCardTerm) when the IRI of the id has a statement in a shapes file. */
    shapesCard(id: string): NamedNode | undefined;
    /** The relations among `iris`: statements of the model whose subject and object are both in `iris` and are instances (type or label), not rdf:type or rdfs:label. */
    statementsAmong(iris: string[]): Quad[];
    /** The statements of the shapes part of the model files that match (IRIs; null matches every term), each with its graph. */
    shapesMatch(s: string | null, p: string | null, o?: string | null): Quad[];
    /**
     * The statements of the model (not the shapes part) with a subject in `iris`, as the view read takes them (view-read.ts): rdf:type, a
     * value that is no IRI, an object in `iris`, an object without rdf:type and rdfs:label.
     */
    statementsOf(iris: string[]): Quad[];
    /** Every statement of the model (not the shapes part) of each subject typed as a SKOS scheme, concept or collection there. */
    vocabularyStatements(): Quad[];
}

const SH = NS.sh;

const SHAPE_PREDICATES = ['targetClass', 'targetSubjectsOf', 'targetObjectsOf', 'targetNode', 'node', 'property', 'or', 'xone', 'and', 'not'].map(p => SH + p);

/** A node shape by its id, over the shapes statements (the old nodeShapeTerm). */
export function nodeShapeTerm(facts: Facts, id: string): NamedNode | undefined {
    const t = elementTerm(id);
    if (!t) return undefined;
    const quads = facts.shapesMatch(t.value, null);
    if (quads.some(q => q.predicate.value === SH + 'path')) return undefined;
    const declared = quads.some(q => (q.predicate.value === NS.rdf + 'type' && q.object.value === SH + 'NodeShape') || SHAPE_PREDICATES.includes(q.predicate.value));
    return declared || (quads.length > 0 && facts.shapesMatch(null, SH + 'node', t.value).length > 0) ? rdf.namedNode(t.value) : undefined;
}
