// Kata q74p: the shapes model from turtle/query (turtle-lsp binary over stdio) on test/fixtures/shapes, against the values that the old pipeline
// gave (recorded before K11 deleted it: test/fixtures/expected/read-shapes.json).
import type { Quad, Term } from '@rdfjs/types';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { dataGraphIri } from '../src/catenary/rdf/files';
import { shapePart } from '../src/catenary/rdf/loader';
import { termKey } from '../src/catenary/rdf/terms';
import { modelFilesOf, viewFilesOf } from '../src/model/view-files';
import { manifestOf, type ManifestRecords } from '../src/read/manifest';
import { shapesClosureOf, shapesModelOf, vocabularyOf, type ShapesModelRecords } from '../src/read/shapes';
import { json, recorded } from './expected';
import { FIXTURE, startServer } from './server';

const R = recorded('read-shapes');

const file = (name: string) => join(FIXTURE, name);
/** Triples of the six fixture documents (port.test.ts). */
const TRIPLES = 282;

describe('shapesModelOf on test/fixtures/shapes', () => {
    let server: Awaited<ReturnType<typeof startServer>>, manifest: ManifestRecords, now: ShapesModelRecords;
    beforeAll(async () => {
        server = await startServer(FIXTURE, TRIPLES);
        const rdfFiles = readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(file);
        const modelFiles = modelFilesOf(rdfFiles, await viewFilesOf(server.port(), rdfFiles.filter(f => f.endsWith('.trig'))));
        manifest = await manifestOf(server.port(), modelFiles);
        now = await shapesModelOf(server.port(), modelFiles, manifest);
    }, 20000);
    afterAll(async () => { await server?.stop(); });

    test('the manifest is prefixes.ttl with its nine prefixes and no language', () => {
        expect(manifest.file).toBe(file('prefixes.ttl'));
        expect(Object.keys(manifest.prefixes ?? {}).sort()).toEqual(['dct', 'ex', 'rdf', 'rdfs', 'sh', 'skos', 'view', 'ws', 'xsd']);
        expect(manifest.language).toBeUndefined();
    });

    /** RDF/JS terms as plain values; other values unchanged. */
    const plain = (x: unknown): unknown => {
        if (Array.isArray(x)) return x.map(plain);
        if (x && typeof x === 'object' && 'termType' in x) {
            const t = x as Term;
            return t.termType === 'Literal' ? { termType: t.termType, value: t.value, language: t.language, datatype: t.datatype.value } : { termType: t.termType, value: t.value };
        }
        if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, plain(v)]));
        return x;
    };

    /**
     * The recorded index is the old one with its graph names as the server names them: the server has no shapes graph (`<file>#shapes`
     * is the file URI) and no union graph (a SKOS term read from the union graph is in the document that holds its statements).
     */
    test('index: the model and every map equal the recorded shapesIndexOf', () => {
        expect([now.index.nodeShape.size, now.index.property.size, now.index.valueSet.size]).toEqual([3, 5, 1]);
        expect(json(now.index.model)).toEqual(R('index.model'));
        for (const k of ['nodeShape', 'property', 'constraint', 'valueSet', 'schemeShape', 'memberShapes', 'byTerm'] as const) {
            expect(json(plain([...now.index[k]])), k).toEqual(R(`index.${k}`));
        }
    });

    test('vocabulary and meta equal the recorded buildVocabulary and authoringMetamodel', () => {
        expect(now.vocabulary.concepts).toHaveLength(2);
        expect(json(now.vocabulary)).toEqual(R('vocabulary'));
        expect(json(now.meta)).toEqual(R('meta'));
    });

    test('the closure and the vocabulary carry their document as graph: shapes.ttl and cities.ttl (57 and 8 statements)', async () => {
        const files = ['cities.ttl', 'data.ttl', 'shapes.ttl'].map(file);
        const graphs = (quads: Quad[]) => [...new Set(quads.map(q => q.graph.value))];
        const closure = await shapesClosureOf(server.port(), files), skos = await vocabularyOf(server.port(), files);
        expect([graphs(closure), closure.length]).toEqual([[dataGraphIri(file('shapes.ttl'))], 57]);
        expect([graphs(skos), skos.length]).toEqual([[dataGraphIri(file('cities.ttl'))], 8]);
    });

    test('shapeSubjects and shapeSubjectsByFile equal the recorded shapePart of the model files', () => {
        expect(now.shapeSubjects.size).toBeGreaterThan(0);
        expect([...now.shapeSubjects].sort()).toEqual(R('shapeSubjects'));
        expect(json([...now.shapeSubjectsByFile].map(([f, ks]) => [f, [...ks].sort()]).sort())).toEqual(R('shapeSubjectsByFile'));
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
