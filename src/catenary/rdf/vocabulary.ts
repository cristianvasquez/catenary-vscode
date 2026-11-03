// Vocabulary terms, resource classification and label reads; adapted from Catenary packages/rdf/src/vocabulary.ts.
import type { Literal, NamedNode, Quad, Term } from '@rdfjs/types';
import { nameFromURI } from 'canonical-md';
import { LABEL_PREDICATES, LabelLiteral } from '../model/labels';
import { NS, RDFS_LABEL, RDF_TYPE, localName } from '../model/terms';
import { sorted } from '../rdf-core/graph';
import { ModelGraph } from './graph';
import { rdf } from './terms';


export const P = {
    type: rdf.namedNode(RDF_TYPE),
    label: rdf.namedNode(RDFS_LABEL),
    conformsTo: rdf.namedNode(NS.dct + 'conformsTo'),
    /** RDF 1.2: `r rdf:reifies <<( s p o )>>`. A placement of a connector is a reifier of its triple. */
    reifies: rdf.namedNode(NS.rdf + 'reifies')
};


/** Types of the SKOS vocabulary (see vocabularyQuads in shapes.ts). */
export const SKOS_TYPES = ['ConceptScheme', 'Concept', 'Collection'].map(t => rdf.namedNode(NS.skos + t));

/** Predicates that make a subject a SKOS concept without rdf:type (see vocabularySubjects). */
export const SKOS_MEMBERSHIP = ['inScheme', 'topConceptOf'].map(p => rdf.namedNode(NS.skos + p));

/** A quad of the model graph that changes the vocabulary: a SKOS predicate, or rdf:type of a SKOS class. */
const isVocabularyQuad = (q: Quad) => q.predicate.value.startsWith(NS.skos) || (q.predicate.value === RDF_TYPE && q.object.value.startsWith(NS.skos));

/** Predicates of the RDFS rules (@catenary/rdfs domain-range.ts). */
const RDFS_PREDICATES = new Set(['domain', 'range', 'subClassOf'].map(p => NS.rdfs + p));

/** Text of a predicate or a class of an RDFS rule: its name and description in the metamodel. */
const RDFS_TEXT = new Set([NS.rdfs + 'label', NS.rdfs + 'comment', NS.skos + 'prefLabel']);

/** A quad of the model graph that can change the RDFS rules of the metamodel (without the text of the predicates and classes). */
const isRdfsQuad = (q: Quad) => RDFS_PREDICATES.has(q.predicate.value) || (q.predicate.value === RDF_TYPE && q.object.value === NS.rdfs + 'Datatype');


/**
 * A quad of a data graph that changes the metamodel: the SKOS vocabulary, an RDFS rule, a statement of a SKOS subject, or the text of
 * a predicate or a class of an RDFS rule (GraphFacts.metamodelQuad).
 */
export function metamodelQuad(g: ModelGraph, q: Quad): boolean {
    return isVocabularyQuad(q) || isRdfsQuad(q)
        || SKOS_TYPES.some(t => g.match(q.subject, P.type, t, g.union).length > 0)
        || (RDFS_TEXT.has(q.predicate.value) && inRdfsRule(g, q.subject));
}


/**
 * A predicate or a class of an RDFS rule of the model graph: its label and comment are in the metamodel. A written subclass
 * counts too: the rules expand to it.
 */
function inRdfsRule(g: ModelGraph, t: Term): boolean {
    if (t.termType !== 'NamedNode') return false;
    return ['domain', 'range', 'subClassOf'].map(p => rdf.namedNode(NS.rdfs + p))
        .some(p => g.match(t as NamedNode, p, null, g.union).length > 0 || g.match(null, p, t as NamedNode, g.union).length > 0);
}


/** An IRI with an rdf:type or an rdfs:label in the model graph. */
function inModel(g: ModelGraph, t: Term): boolean {
    return g.match(t, P.type, null, g.union).length > 0 || g.match(t, P.label, null, g.union).length > 0;
}


/** The shapes graph in which `t` is a SKOS subject (a SKOS type, skos:inScheme or skos:topConceptOf), first in order. */
function vocabularyGraph(g: ModelGraph, t: Term): NamedNode | undefined {
    const graphs = [
        ...SKOS_TYPES.flatMap(type => g.match(t, P.type, type)), ...SKOS_MEMBERSHIP.flatMap(p => g.match(t, p))
    ].map(q => q.graph).filter(graph => g.isShapesGraph(graph)) as NamedNode[];
    return sorted(graphs)[0];
}


/** The graph that holds the statements of an instance: the model graph, or the shapes graph of a SKOS subject of a shapes file. */
export function homeOf(g: ModelGraph, t: Term): NamedNode {
    return inModel(g, t) ? g.union : vocabularyGraph(g, t) ?? g.union;
}


/**
 * The label literals of a subject for pickLabel (@catenary/model): one list per label predicate (LABEL_PREDICATES). `objects`: the
 * objects of a predicate; terms that are not literals do not count.
 */
export function labelLiterals(objects: (predicate: string) => Term[]): LabelLiteral[][] {
    return LABEL_PREDICATES.map(p => objects(p).filter((o): o is Literal => o.termType === 'Literal').map(o => ({ value: o.value, language: o.language })));
}


export function labelFromIri(value: string): string {
    return nameFromURI(rdf.namedNode(value)) ?? localName(value);
}


import { UNION_GRAPH } from './graph-names';

/**
 * Instance: an IRI in the model graph with an rdf:type or an rdfs:label (not the model graph IRI), or a SKOS subject of a shapes
 * graph (concept scheme, concept, collection). A resource is an instance whatever file holds it; `homeOf` gives the graph to edit.
 */
export function isInstance(g: ModelGraph, t: Term | undefined): t is NamedNode {
    return !!t && t.termType === 'NamedNode' && t.value !== UNION_GRAPH && !t.equals(g.union) && (inModel(g, t) || !!vocabularyGraph(g, t));
}

import { pickLabel } from '../model/labels';


import { isSkolem } from '../rdf-core/skolem';


/** Label of an instance (graph: model) or a view (graph: the view): pickLabel in the language of the graph, else the name from the IRI. */
export function label(g: ModelGraph, t: Term, graph: Term = g.union): string {
    return pickLabel(labelLiterals(p => g.objects(t, rdf.namedNode(p), graph)), g.language) ?? labelFromIri(t.value);
}

/**
 * Owned by `s`: an object IRI that was a blank node in its file (skolem.ts), is not an instance, has statements in `graph`, and that no other subject
 * refers to. A delete or copy of `s` includes it.
 */
export function ownedBy(g: ModelGraph, o: Term, s: Term, graph: Term): o is NamedNode {
    return isSkolem(o) && !isInstance(g, o) && g.match(o, null, null, graph).length > 0
        && g.match(null, null, o).every(q => q.subject.equals(s));
}
