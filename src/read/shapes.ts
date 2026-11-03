// The shapes model (shapes index, SKOS vocabulary, authoring metamodel) from turtle/query answers. Nothing is kept between calls.
import type { Quad } from '@rdfjs/types';
import type { Classes } from '../catenary/model/metamodel';
import { mergeContributions } from '../catenary/model/metamodel';
import { NS } from '../catenary/model/terms';
import { rdfsAuthoring } from '../catenary/rdfs/domain-range';
import { shapePart } from '../catenary/rdf/loader';
import { buildVocabulary } from '../catenary/rdf/shapes';
import { readShapes, type ShapesIndex } from '../catenary/rdf/shapes-read';
import { rdf, termKey } from '../catenary/rdf/terms';
import { shaclAuthoring } from '../catenary/shacl/backend/authoring';
import type { ModelPort, Row } from '../model/port';
import { applyPrefixes, type ManifestRecords } from './manifest';

const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX sh: <${NS.sh}> PREFIX skos: <${NS.skos}>`;

/**
 * The candidate statements of the shapes, per document (`?g`): the statements of the roots (a subject with an sh: predicate or an sh: shape
 * type), of every blank node, and of every RDF list cell. shapePart picks the shapes among them.
 */
const SHAPE_CANDIDATES = `${PREFIXES} SELECT DISTINCT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o FILTER (isBlank(?s)
    || EXISTS { ?s rdf:first ?first }
    || EXISTS { ?s a ?t FILTER (?t IN (sh:NodeShape, sh:PropertyShape, sh:Shape)) }
    || EXISTS { ?s ?sp ?x FILTER (STRSTARTS(STR(?sp), "${NS.sh}")) }) } }`;

/** Every statement (with its document) of each subject typed as a SKOS scheme, concept or collection in one of the documents. */
const VOCABULARY = `${PREFIXES} SELECT DISTINCT ?g ?s ?p ?o WHERE { ?s a ?t . VALUES ?t { skos:ConceptScheme skos:Concept skos:Collection } GRAPH ?g { ?s ?p ?o } }`;

const quadOf = ({ g, s, p, o }: Row): Quad => rdf.quad(s as Quad['subject'], p as Quad['predicate'], o as Quad['object'], g as Quad['graph']);

/**
 * The statements of the shapes of `modelFiles`, each with its document as graph: the statements of the subjects that shapePart (loader.ts)
 * gives for the candidates of each document. The port gives a blank node as a skolem IRI, so shapePart follows it as in the old loader.
 */
export async function shapesClosureOf(port: ModelPort, modelFiles: string[]): Promise<Quad[]> {
    const docs = new Map<string, Quad[]>();
    for (const q of (await port.select(SHAPE_CANDIDATES, modelFiles)).map(quadOf)) (docs.get(q.graph.value) ?? docs.set(q.graph.value, []).get(q.graph.value)!).push(q);
    return [...docs.values()].flatMap(quads => {
        const part = shapePart(quads);
        return quads.filter(q => part.has(termKey(q.subject)));
    });
}

/** The statements of the SKOS schemes, concepts and collections of `modelFiles`, each with its document as graph. */
export async function vocabularyOf(port: ModelPort, modelFiles: string[]): Promise<Quad[]> {
    return (await port.select(VOCABULARY, modelFiles)).map(quadOf);
}

/** `shapeSubjects`: the subjects of the shapes statements (termKey). `closure`: the shapes statements (shapesClosureOf), each with its document as graph. */
export interface ShapesModelRecords {
    index: ShapesIndex;
    vocabulary: Pick<Classes, 'schemes' | 'concepts'>;
    meta: Classes;
    shapeSubjects: Set<string>;
    closure: Quad[];
}

/**
 * The shapes model of `modelFiles` without the manifest document (graphOf does not load it). As shapesIndexOf, buildVocabulary and
 * authoringMetamodel on the old pipeline: SHACL first, then RDFS over the model files. Sets the prefix table of the manifest (applyPrefixes)
 * before the derivation: the texts of the index use it.
 */
export async function shapesModelOf(port: ModelPort, modelFiles: string[], manifest: ManifestRecords): Promise<ShapesModelRecords> {
    const files = modelFiles.filter(f => f !== manifest.file);
    const [closure, skos, rdfs] = await Promise.all([shapesClosureOf(port, files), vocabularyOf(port, files), rdfsAuthoring(query => port.select(query, files))]);
    // After the queries: an overlapping call with another manifest cannot change the table during the synchronous derivation below.
    applyPrefixes(manifest);
    const index = readShapes([...closure, ...skos], manifest.language);
    const triple = (q: Quad) => rdf.quad(q.subject, q.predicate, q.object);
    const vocabulary = buildVocabulary(rdf.dataset([...closure, ...skos].map(triple)), manifest.language);
    const shacl = shaclAuthoring(closure.map(q => ({ s: q.subject, p: q.predicate, o: q.object })));
    const meta = mergeContributions([{ id: 'shacl', ...shacl }, { id: 'rdfs', ...rdfs }], vocabulary);
    return { index, vocabulary, meta, shapeSubjects: new Set(closure.map(q => termKey(q.subject))), closure };
}
