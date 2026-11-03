// Kata q74p: the shapes model from turtle/query (fork binary over stdio) equals the old pipeline on test/fixtures/shapes.
import type { NamedNode, Quad, Term } from '@rdfjs/types';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { authoringMetamodel } from '../src/catenary/rdf/authoring';
import type { ModelGraph } from '../src/catenary/rdf/graph';
import { UNION_GRAPH, dataGraphIri, fileOfGraph, shapesGraphIri } from '../src/catenary/rdf/graph-names';
import { shapePart } from '../src/catenary/rdf/loader';
import { buildVocabulary, shapesTriples, vocabularyQuads } from '../src/catenary/rdf/shapes';
import { shapesIndexOf } from '../src/catenary/rdf/shapes-read';
import { rdf, termKey } from '../src/catenary/rdf/terms';
import { graphOf, graphPrefixes } from '../src/model/graph-input';
import { modelFilesOf, viewFilesOf } from '../src/model/view-files';
import { manifestOf, type ManifestRecords } from '../src/read/manifest';
import { shapesClosureOf, shapesModelOf, vocabularyOf, type ShapesModelRecords } from '../src/read/shapes';
import { FIXTURE, fixtureGraph } from './fixture-graph';
import { startServer } from './server';

const file = (name: string) => join(FIXTURE, name);
/** Triples of the six fixture documents (port.test.ts). */
const TRIPLES = 282;

describe('shapesModelOf on test/fixtures/shapes', () => {
    let server: Awaited<ReturnType<typeof startServer>>, manifest: ManifestRecords, now: ShapesModelRecords, graph: ModelGraph;
    beforeAll(async () => {
        server = await startServer(FIXTURE, TRIPLES);
        const rdfFiles = readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(file);
        const modelFiles = modelFilesOf(rdfFiles, await viewFilesOf(server.port(), rdfFiles.filter(f => f.endsWith('.trig'))));
        manifest = await manifestOf(server.port(), modelFiles);
        now = await shapesModelOf(server.port(), modelFiles, manifest);
        graph = graphOf(fixtureGraph(), ['instances.trig', 'model.trig'].map(file)).graph;
        graphPrefixes(graph);
    }, 20000);
    afterAll(async () => { await server?.stop(); });

    test('the manifest is prefixes.ttl with its nine prefixes', () => {
        expect(manifest.file).toBe(file('prefixes.ttl'));
        expect(Object.keys(manifest.prefixes ?? {}).sort()).toEqual(['dct', 'ex', 'rdf', 'rdfs', 'sh', 'skos', 'view', 'ws', 'xsd']);
        expect(manifest.language).toBe(graph.language);
    });

    /**
     * The old graph names as the server names them: the server has no shapes graph (`<file>#shapes` is the file URI) and no union graph
     * (a SKOS term read from the union graph is in the document that holds its statements). Nothing else changes.
     */
    const documentOf = (term: Term): NamedNode => {
        const holders = graph.dataGraphs().filter(g => graph.match(term as Quad['subject'], null, null, g).length > 0);
        expect(holders, term.value).toHaveLength(1);
        return holders[0];
    };
    const serverGraph = (g: NamedNode, term: Term): NamedNode => g.value === UNION_GRAPH ? documentOf(term) : rdf.namedNode(g.value.replace(/#shapes$/, ''));
    const serverFile = (file: string, uri: string): string => file === UNION_GRAPH ? fileOfGraph(documentOf(rdf.namedNode(uri)).value) : file;

    /** RDF/JS terms as plain values (the old ones are Oxigraph wasm objects); other values unchanged. */
    const plain = (x: unknown): unknown => {
        if (Array.isArray(x)) return x.map(plain);
        if (x && typeof x === 'object' && 'termType' in x) {
            const t = x as Term;
            return t.termType === 'Literal' ? { termType: t.termType, value: t.value, language: t.language, datatype: t.datatype.value } : { termType: t.termType, value: t.value };
        }
        if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, plain(v)]));
        return x;
    };

    test('index: the model and every map equal shapesIndexOf (file and graph fields as the server names the documents)', () => {
        const old = shapesIndexOf(graph);
        expect([old.nodeShape.size, old.property.size, old.valueSet.size]).toEqual([3, 5, 1]);
        const model = structuredClone(old.model);
        for (const x of [...Object.values(model.nodeShapes), ...Object.values(model.valueSets)]) x.file = serverFile(x.file, x.uri);
        expect(now.index.model).toEqual(model);
        const regraph = <V extends { graph: NamedNode }>(m: Map<string, V>, term: (v: V) => Term) => plain([...m].map(([k, v]) => [k, { ...v, graph: serverGraph(v.graph, term(v)) }]));
        expect(plain([...now.index.nodeShape])).toEqual(regraph(old.nodeShape, v => v.term));
        expect(plain([...now.index.property])).toEqual(regraph(old.property, v => v.term));
        expect(plain([...now.index.constraint])).toEqual(regraph(old.constraint, v => v.owner));
        expect(plain([...now.index.valueSet])).toEqual(regraph(old.valueSet, v => v.term));
        for (const k of ['schemeShape', 'memberShapes', 'byTerm'] as const) expect(plain([...now.index[k]]), k).toEqual(plain([...old[k]]));
    });

    test('vocabulary and meta equal buildVocabulary and authoringMetamodel', () => {
        const dataset = rdf.dataset([...shapesTriples(graph), ...vocabularyQuads(graph).map(q => rdf.quad(q.subject, q.predicate, q.object))]);
        const vocabulary = buildVocabulary(dataset, graph.language);
        expect(vocabulary.concepts).toHaveLength(2);
        expect(now.vocabulary).toEqual(vocabulary);
        expect(now.meta).toEqual(authoringMetamodel(graph, vocabulary));
    });

    test('the closure and the vocabulary carry their document as graph: shapes.ttl and cities.ttl (57 and 8 statements)', async () => {
        const files = ['cities.ttl', 'data.ttl', 'shapes.ttl'].map(file);
        const graphs = (quads: Quad[]) => [...new Set(quads.map(q => q.graph.value))];
        const closure = await shapesClosureOf(server.port(), files), skos = await vocabularyOf(server.port(), files);
        expect([graphs(closure), closure.length]).toEqual([[dataGraphIri(file('shapes.ttl'))], 57]);
        expect([graphs(skos), skos.length]).toEqual([[dataGraphIri(file('cities.ttl'))], 8]);
    });

    test('shapeSubjects equals the union of shapePart over the model files; shapeSubjectsByFile equals shapePart per file', () => {
        const old = new Set<string>(), byFile: [string, string[]][] = [];
        for (const f of graph.dataGraphs().map(g => g.value)) {
            const path = new URL(f).pathname;
            const quads = [dataGraphIri(path), shapesGraphIri(path)].flatMap(g => graph.match(null, null, null, rdf.namedNode(g)));
            const part = shapePart(quads);
            for (const k of part) old.add(k);
            if (part.size) byFile.push([path, [...part].sort()]);
        }
        expect(old.size).toBeGreaterThan(0);
        expect([...now.shapeSubjects].sort()).toEqual([...old].sort());
        expect([...now.shapeSubjectsByFile].map(([f, ks]) => [f, [...ks].sort()]).sort()).toEqual(byFile.sort());
    });
});

describe('the shapes closure follows shapePart (temp folder)', () => {
    const EX = 'http://example.org/';
    const text = `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> . @prefix ex: <${EX}> .
ex:S a sh:NodeShape ; sh:in ex:l1 ; ex:annotation [ ex:note "x" ] .
ex:l1 rdf:first ex:a ; rdf:rest ex:l2 .
ex:l2 rdf:first ex:b ; rdf:rest rdf:nil .
ex:orphan rdf:first ex:c ; rdf:rest ex:l2 .
ex:thing ex:p [ ex:q "plain" ] .
`;
    let dir: string, path: string, server: Awaited<ReturnType<typeof startServer>>;
    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'catenary-shapes-'));
        path = join(dir, 'shapes.ttl');
        writeFileSync(path, text);
        server = await startServer(dir, 12);
    }, 20000);
    afterAll(async () => {
        await server?.stop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    test('a blank node under a custom predicate and an orphan list cell are in; a blank node under a plain subject is not', async () => {
        const port = server.port();
        const quads = await port.construct('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', [path]);
        expect(quads).toHaveLength(12);
        const object = (s: string, p: string) => termKey(quads.find(q => q.subject.value === s && q.predicate.value === p)!.object);
        const annotation = object(`${EX}S`, `${EX}annotation`), plainNode = object(`${EX}thing`, `${EX}p`);
        expect(annotation).toMatch(/^<urn:skolem:blank:/);
        const { shapeSubjects } = await shapesModelOf(port, [path], {});
        expect([...shapeSubjects].sort()).toEqual([...shapePart(quads)].sort());
        expect([...shapeSubjects].sort()).toEqual([`<${EX}S>`, annotation, `<${EX}l1>`, `<${EX}l2>`, `<${EX}orphan>`].sort());
        expect(shapeSubjects.has(plainNode)).toBe(false);
    });
});
