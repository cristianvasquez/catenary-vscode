// Vocabulary terms and label reads; adapted from Catenary packages/rdf/src/vocabulary.ts.
import type { Literal, Term } from '@rdfjs/types';
import { nameFromURI } from 'canonical-md';
import { LABEL_PREDICATES, LabelLiteral } from '../model/labels';
import { NS, RDFS_LABEL, RDF_TYPE, localName } from '../model/terms';
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
