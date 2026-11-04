// The shapes model (shapes index, SKOS vocabulary, authoring metamodel) from turtle/query answers. Nothing is kept between calls.
import type { Quad } from '@rdfjs/types';
import type { Classes } from '../catenary/model/metamodel';
import { mergeContributions } from '../catenary/model/metamodel';
import { NS } from '../catenary/model/terms';
import { rdfsAuthoring } from '../catenary/rdfs/domain-range';
import { shapePart } from '../catenary/rdf/loader';
import { isSkolem } from '../catenary/rdf-core/skolem';
import { buildVocabulary } from '../catenary/rdf/shapes';
import { readShapes, type ShapesIndex } from './shapes-index';
import { dataGraphIri, fileOfGraph } from '../catenary/rdf/files';
import { rdf, termKey } from '../catenary/rdf/terms';
import { shaclAuthoring } from '../catenary/shacl/backend/authoring';
import { byFile, type ModelPort, type Row } from '../model/port';
import { applyPrefixes, type ManifestRecords } from './manifest';

const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX sh: <${NS.sh}> PREFIX skos: <${NS.skos}>`;

/**
 * The candidate statements of the IRI roots of the shapes, run per document (byFile): the statements of an IRI subject with an sh: predicate
 * or an sh: shape type, and of every IRI list cell.
 */
const SHAPE_ROOTS = `${PREFIXES} SELECT DISTINCT ?s ?p ?o WHERE { ?s ?p ?o FILTER (isIRI(?s) && (EXISTS { ?s rdf:first ?first }
    || EXISTS { ?s a ?t FILTER (?t IN (sh:NodeShape, sh:PropertyShape, sh:Shape)) }
    || EXISTS { ?s ?sp ?x FILTER (STRSTARTS(STR(?sp), "${NS.sh}")) })) }`;

/** The statements of every blank node and RDF list cell, run once over the whole folder: a blank node belongs to the IRI that reaches it. */
const SHAPE_BLANKS = `${PREFIXES} SELECT DISTINCT ?s ?p ?o WHERE { ?s ?p ?o FILTER (isBlank(?s) || EXISTS { ?s rdf:first ?first }) }`;

/** Every statement of each IRI subject typed as a SKOS scheme, concept or collection, run per document (byFile). */
const VOCABULARY = `${PREFIXES} SELECT DISTINCT ?s ?p ?o WHERE { ?s a ?t . VALUES ?t { skos:ConceptScheme skos:Concept skos:Collection } ?s ?p ?o FILTER (isIRI(?s)) }`;

const quadOf = ({ s, p, o }: Row, graph: Quad['graph'] = rdf.defaultGraph()): Quad => rdf.quad(s as Quad['subject'], p as Quad['predicate'], o as Quad['object'], graph);

/** The rows of `byFile`, each as a quad with its document (`dataGraphIri` of its file) as graph. */
const documentQuads = (rows: (Row & { file: string })[]): Quad[] => rows.map(r => quadOf(r, rdf.namedNode(dataGraphIri(r.file))));

/**
 * The statements of the shapes of `modelFiles`, each with its document as graph: per document, the subjects that shapePart (loader.ts)
 * gives for the IRI candidates of the document and every blank-node candidate of the folder. A blank-node statement belongs to the document
 * whose IRI statements of the shapes reach it; a blank node that no IRI reaches is in no document. The port gives a blank node as a skolem IRI.
 */
export async function shapesClosureOf(port: ModelPort, modelFiles: string[]): Promise<Quad[]> {
    if (!modelFiles.length) return [];
    const [named, blankRows] = await Promise.all([byFile(port, modelFiles, SHAPE_ROOTS), port.select(SHAPE_BLANKS)]);
    const blanks = blankRows.map(r => quadOf(r)).filter(q => isSkolem(q.subject));
    return modelFiles.flatMap(file => {
        const graph = rdf.namedNode(dataGraphIri(file));
        const own = documentQuads(named.filter(r => r.file === file));
        const part = shapePart([...own, ...blanks]);
        const bySubject = new Map<string, Quad[]>();
        for (const q of [...own, ...blanks]) (bySubject.get(termKey(q.subject)) ?? bySubject.set(termKey(q.subject), []).get(termKey(q.subject))!).push(q);
        // The subjects of the part that the IRI subjects of the part reach.
        const reached = new Set(own.map(q => termKey(q.subject)).filter(k => part.has(k)));
        for (const queue = [...reached]; queue.length;) for (const q of bySubject.get(queue.pop()!) ?? []) {
            const k = termKey(q.object);
            if (part.has(k) && !reached.has(k)) { reached.add(k); queue.push(k); }
        }
        return [...own.filter(q => reached.has(termKey(q.subject))),
            ...blanks.filter(q => reached.has(termKey(q.subject))).map(q => rdf.quad(q.subject, q.predicate, q.object, graph))];
    });
}

/** The statements of the SKOS schemes, concepts and collections of `modelFiles`, each with its document as graph. */
export async function vocabularyOf(port: ModelPort, modelFiles: string[]): Promise<Quad[]> {
    return documentQuads(await byFile(port, modelFiles, VOCABULARY));
}

/**
 * `shapeSubjects`: the subjects of the shapes statements (termKey). `shapeSubjectsByFile`: the same per document (file path), as shapePart
 * classifies per file. `files`: the model files read, without the manifest document. `closure`: the shapes statements (shapesClosureOf),
 * each with its document as graph.
 */
export interface ShapesModelRecords {
    files: string[];
    index: ShapesIndex;
    vocabulary: Pick<Classes, 'schemes' | 'concepts'>;
    meta: Classes;
    shapeSubjects: Set<string>;
    shapeSubjectsByFile: Map<string, Set<string>>;
    closure: Quad[];
}

/**
 * The shapes model of `modelFiles` without the manifest document (the manifest is not part of the model): SHACL first, then RDFS over
 * the model files. Sets the prefix table of the manifest (applyPrefixes)
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
    const shapeSubjectsByFile = new Map<string, Set<string>>();
    for (const q of closure) {
        const file = fileOfGraph(q.graph.value);
        (shapeSubjectsByFile.get(file) ?? shapeSubjectsByFile.set(file, new Set()).get(file)!).add(termKey(q.subject));
    }
    return { files, index, vocabulary, meta, shapeSubjects: new Set(closure.map(q => termKey(q.subject))), shapeSubjectsByFile, closure };
}
