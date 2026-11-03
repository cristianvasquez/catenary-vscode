// Read SKOS schemes and concepts for the metamodel; adapted from Catenary packages/rdf/src/shapes.ts.
import { ConceptDef, SchemeDef } from '../model/metamodel';
import { NS, localName } from '../model/terms';
import { pickLabel } from '../model/labels';
import type { Quad, Quad_Subject, Term } from '@rdfjs/types';
import type { Dataset } from 'rdf-ext';
import { ModelGraph } from './graph';
import { rdf } from './terms';
import { P, SKOS_TYPES } from './vocabulary';


/** Quads of all shapes graphs, with their graphs. */
function shapesQuads(g: ModelGraph): Quad[] {
    return g.shapesGraphs().flatMap(sg => g.match(null, null, null, sg));
}


/**
 * SKOS vocabulary of the model graph: the statements of its concept schemes, concepts and collections (subjects with one of these
 * types), with their graph. Concepts in the data file are instances too; the shapes read and the metamodel also use these quads.
 */
export function vocabularyQuads(g: ModelGraph): Quad[] {
    const subjects = rdf.termSet<Term>();
    for (const t of SKOS_TYPES) for (const q of g.match(null, P.type, t, g.union)) subjects.add(q.subject);
    return [...subjects].flatMap(s => g.match(s as Quad_Subject, null, null, g.union));
}


/** Shapes quads and the SKOS vocabulary of the model graph. */
export function shapesAndVocabulary(g: ModelGraph): Quad[] {
    return [...shapesQuads(g), ...vocabularyQuads(g)];
}


/** Triples of all shapes graphs (the union of the shapes files). */
export function shapesTriples(g: ModelGraph): Quad[] {
    return shapesQuads(g).map(q => rdf.quad(q.subject, q.predicate, q.object));
}


const n = (iri: string) => rdf.namedNode(iri);


const SKOS = NS.skos;


/** SKOS concept schemes and concepts in the shapes files. `language`: of the labels and texts (pickLabel). */
export function buildVocabulary(dataset: Dataset, language?: string): { schemes: SchemeDef[]; concepts: ConceptDef[] } {
    const node = (t: Term) => rdf.grapoi({ dataset, term: t });
    const iris = (p: string, o?: string, side: 'subject' | 'object' = 'subject') =>
        [...dataset.match(null, n(p), o ? n(o) : null)].map(q => q[side]).filter(t => t.termType === 'NamedNode').map(t => t.value);
    // The label rule (pickLabel) over the objects of `preds`, in that order.
    const text = (iri: string, ...preds: string[]) => pickLabel(preds.map(p => node(n(iri)).out(n(p)).terms
        .map(t => ({ value: t.value, language: t.termType === 'Literal' ? t.language : undefined }))), language);

    const schemeIris = new Set([
        ...iris(NS.rdf + 'type', SKOS + 'ConceptScheme'), ...iris(SKOS + 'hasTopConcept'),
        ...iris(SKOS + 'inScheme', undefined, 'object'), ...iris(SKOS + 'topConceptOf', undefined, 'object')
    ]);
    const conceptIris = new Set([
        ...iris(NS.rdf + 'type', SKOS + 'Concept'), ...iris(SKOS + 'inScheme'), ...iris(SKOS + 'topConceptOf'),
        ...iris(SKOS + 'hasTopConcept', undefined, 'object'), ...iris(SKOS + 'broader'), ...iris(SKOS + 'narrower'),
        ...iris(SKOS + 'broader', undefined, 'object'), ...iris(SKOS + 'narrower', undefined, 'object')
    ]);
    for (const s of schemeIris) conceptIris.delete(s);

    const pairs = (p: string) => [...dataset.match(null, n(p), null)].filter(q => q.subject.termType === 'NamedNode' && q.object.termType === 'NamedNode');
    const concepts = new Map<string, ConceptDef>([...conceptIris].map(iri => [iri, {
        iri, label: text(iri, SKOS + 'prefLabel', NS.rdfs + 'label') ?? localName(iri),
        notation: text(iri, SKOS + 'notation'),
        definition: text(iri, SKOS + 'definition', NS.rdfs + 'comment'),
        schemes: [], broader: [], top: false
    }]));
    const add = (list: string[], v: string) => { if (!list.includes(v)) list.push(v); };
    for (const q of pairs(SKOS + 'inScheme')) { const c = concepts.get(q.subject.value); if (c) add(c.schemes, q.object.value); }
    for (const q of pairs(SKOS + 'topConceptOf')) { const c = concepts.get(q.subject.value); if (c) { add(c.schemes, q.object.value); c.top = true; } }
    for (const q of pairs(SKOS + 'hasTopConcept')) { const c = concepts.get(q.object.value); if (c) { add(c.schemes, q.subject.value); c.top = true; } }
    for (const q of pairs(SKOS + 'broader')) { const c = concepts.get(q.subject.value); if (c && concepts.has(q.object.value)) add(c.broader, q.object.value); }
    for (const q of pairs(SKOS + 'narrower')) { const c = concepts.get(q.object.value); if (c && concepts.has(q.subject.value)) add(c.broader, q.subject.value); }

    const schemes = [...schemeIris].map(iri => ({
        iri, label: text(iri, SKOS + 'prefLabel', NS.dct + 'title', NS.rdfs + 'label') ?? localName(iri),
        description: text(iri, NS.dct + 'description', SKOS + 'definition', NS.rdfs + 'comment')
    }));
    const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
    return { schemes: schemes.sort(byLabel), concepts: [...concepts.values()].sort(byLabel) };
}

