// The shapes model (shapes index, SKOS vocabulary, authoring metamodel) from turtle/query answers. Nothing is kept between calls.
import type { Quad } from '@rdfjs/types';
import type { Classes } from '../catenary/model/metamodel';
import { mergeContributions } from '../catenary/model/metamodel';
import { NS } from '../catenary/model/terms';
import { rdfsAuthoring } from '../catenary/rdfs/domain-range';
import { buildVocabulary } from '../catenary/rdf/shapes';
import { readShapes, type ShapesIndex } from '../catenary/rdf/shapes-read';
import { rdf, termKey } from '../catenary/rdf/terms';
import { shaclAuthoring } from '../catenary/shacl/backend/authoring';
import type { ModelPort, Row } from '../model/port';
import { applyPrefixes, type ManifestRecords } from './manifest';

const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX sh: <${NS.sh}> PREFIX skos: <${NS.skos}>`;

/** The predicates from a shape to the nodes of its shape: nested shapes, paths, lists. */
const CLOSURE_PATH = '(sh:property|sh:node|sh:or|sh:xone|sh:and|sh:not|sh:in|sh:path|sh:inversePath|sh:alternativePath|sh:zeroOrMorePath|sh:oneOrMorePath|sh:zeroOrOnePath|sh:languageIn|rdf:first|rdf:rest)*';

/**
 * The statements of the shapes of each document (`?g`): the roots are the subjects with an sh: predicate or an sh: shape type (as shapePart
 * of loader.ts), and the closure is every node reachable from a root over CLOSURE_PATH in the same document.
 */
const SHAPES_CLOSURE = `${PREFIXES} SELECT DISTINCT ?g ?s ?p ?o WHERE { GRAPH ?g {
    { ?root ?sp ?x . FILTER (STRSTARTS(STR(?sp), "${NS.sh}")) } UNION { ?root a ?t . VALUES ?t { sh:NodeShape sh:PropertyShape sh:Shape } }
    ?root ${CLOSURE_PATH} ?s . ?s ?p ?o
} }`;

/** Every statement (with its document) of each subject typed as a SKOS scheme, concept or collection in one of the documents. */
const VOCABULARY = `${PREFIXES} SELECT DISTINCT ?g ?s ?p ?o WHERE { ?s a ?t . VALUES ?t { skos:ConceptScheme skos:Concept skos:Collection } GRAPH ?g { ?s ?p ?o } }`;

const quadOf = ({ g, s, p, o }: Row): Quad => rdf.quad(s as Quad['subject'], p as Quad['predicate'], o as Quad['object'], g as Quad['graph']);

/** The statements of the shapes of `modelFiles`, each with its document as graph. */
export async function shapesClosureOf(port: ModelPort, modelFiles: string[]): Promise<Quad[]> {
    return (await port.select(SHAPES_CLOSURE, modelFiles)).map(quadOf);
}

/** The statements of the SKOS schemes, concepts and collections of `modelFiles`, each with its document as graph. */
export async function vocabularyOf(port: ModelPort, modelFiles: string[]): Promise<Quad[]> {
    return (await port.select(VOCABULARY, modelFiles)).map(quadOf);
}

/** `shapeSubjects`: the subjects of the shapes statements (termKey). */
export interface ShapesModelRecords {
    index: ShapesIndex;
    vocabulary: Pick<Classes, 'schemes' | 'concepts'>;
    meta: Classes;
    shapeSubjects: Set<string>;
}

/**
 * The shapes model of `modelFiles` without the manifest document (graphOf does not load it). As shapesIndexOf, buildVocabulary and
 * authoringMetamodel on the old pipeline: SHACL first, then RDFS over the model files. Sets the prefix table of the manifest (applyPrefixes)
 * first: the texts of the index use it.
 */
export async function shapesModelOf(port: ModelPort, modelFiles: string[], manifest: ManifestRecords): Promise<ShapesModelRecords> {
    const files = modelFiles.filter(f => f !== manifest.file);
    applyPrefixes(manifest);
    const [closure, skos, rdfs] = await Promise.all([shapesClosureOf(port, files), vocabularyOf(port, files), rdfsAuthoring(query => port.select(query, files))]);
    const index = readShapes([...closure, ...skos], manifest.language);
    const triple = (q: Quad) => rdf.quad(q.subject, q.predicate, q.object);
    const vocabulary = buildVocabulary(rdf.dataset([...closure, ...skos].map(triple)), manifest.language);
    const shacl = shaclAuthoring(closure.map(q => ({ s: q.subject, p: q.predicate, o: q.object })));
    const meta = mergeContributions([{ id: 'shacl', ...shacl }, { id: 'rdfs', ...rdfs }], vocabulary);
    return { index, vocabulary, meta, shapeSubjects: new Set(closure.map(q => termKey(q.subject))) };
}
