// Kata 1rhb: the ModelPort over turtle/query, and the facts of the fork's dataset on test/fixtures/shapes, against the real binary over stdio.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { answerPort, type Row } from '../src/model/port';
import { modelFilesOf, viewFilesOf } from '../src/model/view-files';
import { nodePort } from '../src/node/port';
import type { QueryAnswer } from '../src/node/sparql-endpoint';
import { QUERY_MISSING } from '../src/node/turtle-api';
import { startServer } from './server';

const folder = join(__dirname, 'fixtures/shapes');
const file = (name: string) => join(folder, name);
const uri = (name: string) => pathToFileURL(file(name)).href;
const VIEW = 'https://cristianvasquez.github.io/catenary/vocab/view#';
/** Triples of the six fixture documents: cities 8, data 27, prefixes 28, shapes 57, instances.trig 93, model.trig 69. */
const TRIPLES = 282;
const count = (rows: Row[]) => Number(rows[0]?.n?.value ?? NaN);
const bnodes = (a: QueryAnswer) => a.kind === 'select' ? a.results.bindings.map(b => b.s).flatMap(t => (t?.type === 'bnode' ? [t.value] : [])) : [];

describe('the server dataset (fork binary over stdio)', () => {
    let server: Awaited<ReturnType<typeof startServer>>;
    beforeAll(async () => { server = await startServer(folder, TRIPLES); }, 20000);
    afterAll(async () => { await server?.stop(); });

    test('the default graph is the union of every document, the triples of the TriG graph blocks included', async () => {
        expect(count(await server.port().select('SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }'))).toBe(TRIPLES);
        const rows = await server.port().select('SELECT (COUNT(*) AS ?n) WHERE { <urn:name:Bookshop> a ?t }');
        expect(count(rows)).toBe(1);
    });

    test('GRAPH <file URI> reads one file; files: [file] restricts the dataset to that document', async () => {
        const port = server.port();
        expect(count(await port.select(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${uri('data.ttl')}> { ?s ?p ?o } }`))).toBe(27);
        expect(count(await port.select('SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }', [file('data.ttl')]))).toBe(27);
        const graphs = await port.select('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }', [file('data.ttl')]);
        expect(graphs.map(r => r.g.value)).toEqual([uri('data.ttl')]);
    });

    test('the view graph of instances.trig holds its statements; the document has no graph under its file URI', async () => {
        const port = server.port();
        expect(count(await port.select('SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:name:Bookshop> { ?s ?p ?o } }'))).toBe(93);
        expect(count(await port.select(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${uri('instances.trig')}> { ?s ?p ?o } }`))).toBe(0);
        const graphs = await port.select('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }', [file('instances.trig')]);
        expect(graphs.map(r => r.g.value)).toEqual(['urn:name:Bookshop']);
    });

    test('a blank node comes back as bnode with a <document>:<n> label, the same label in two queries', async () => {
        // shapes.ttl has no blank node; prefixes.ttl has nine (sh:declare [ ... ]).
        const q = { query: 'SELECT ?s WHERE { ?s <http://www.w3.org/ns/shacl#prefix> "ex" }', files: [uri('prefixes.ttl')] };
        const first = bnodes(await server.query(q)), second = bnodes(await server.query(q));
        expect(first).toHaveLength(1);
        expect(first[0]).toMatch(/^\d+:\d+$/);
        expect(second).toEqual(first);
        const [row] = await server.port().select(q.query, [file('prefixes.ttl')]);
        const [d, n] = first[0].split(':');
        expect(row.s.termType).toBe('NamedNode');
        expect(row.s.value).toBe(`urn:skolem:blank:${d.padStart(6, '0')}-${n.padStart(8, '0')}`);
    });

    test('a construct answer keeps the blank-node labels', async () => {
        const select = bnodes(await server.query({ query: 'SELECT ?s WHERE { ?s <http://www.w3.org/ns/shacl#prefix> ?p }', files: [uri('prefixes.ttl')] }));
        const construct = await server.query({ query: 'CONSTRUCT { ?s <urn:x:p> ?p } WHERE { ?s <http://www.w3.org/ns/shacl#prefix> ?p }', files: [uri('prefixes.ttl')] });
        expect(construct.kind).toBe('construct');
        const labels = construct.kind === 'construct' ? construct.triples.map(t => (t.subject.type === 'bnode' ? t.subject.value : '')) : [];
        expect(labels.sort()).toEqual(select.sort());
        expect(select).toHaveLength(9);
        const quads = await server.port().construct('CONSTRUCT { ?s <urn:x:p> ?p } WHERE { ?s <http://www.w3.org/ns/shacl#prefix> ?p }', [file('prefixes.ttl')]);
        expect(quads).toHaveLength(9);
        expect(quads.every(q => q.subject.value.startsWith('urn:skolem:blank:') && q.graph.termType === 'DefaultGraph')).toBe(true);
    });

    test('ask answers a boolean', async () => {
        expect(await server.port().ask(`ASK { GRAPH <urn:name:Bookshop%20model> { <urn:name:Bookshop%20model> a <${VIEW}View> } }`)).toBe(true);
        expect(await server.port().ask(`ASK { <urn:name:Bookshop> a <${VIEW}View> }`, [file('data.ttl')])).toBe(false);
    });

    test('viewFilesOf gives the two view IRIs with their paths; modelFilesOf the four .ttl files', async () => {
        const rdfFiles = readdirSync(folder).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(file);
        const views = await viewFilesOf(server.port(), rdfFiles.filter(f => f.endsWith('.trig')));
        expect(views).toEqual(new Map([['urn:name:Bookshop', file('instances.trig')], ['urn:name:Bookshop%20model', file('model.trig')]]));
        expect(modelFilesOf(rdfFiles, views)).toEqual(['cities.ttl', 'data.ttl', 'prefixes.ttl', 'shapes.ttl'].map(file));
    });

    // Last: it changes the dataset of the tests above.
    test('after didChange, the next select sees the open buffer, not the disk', async () => {
        const text = readFileSync(file('data.ttl'), 'utf8');
        server.open(uri('data.ttl'), text);
        server.change(uri('data.ttl'), text + '\n<urn:x:new> <urn:x:p> "added" .\n');
        const rows = await server.port().select('SELECT ?o WHERE { <urn:x:new> <urn:x:p> ?o }');
        expect(rows.map(r => r.o.value)).toEqual(['added']);
        expect(count(await server.port().select('SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }', [file('data.ttl')]))).toBe(28);
    });
});

describe('answerPort and nodePort without a server', () => {
    const XSD = 'http://www.w3.org/2001/XMLSchema#';
    const answer = (a: QueryAnswer) => answerPort(async () => a);

    test('terms: language, typed and plain literals, triple terms', async () => {
        const [row] = await answer({
            kind: 'select', head: { vars: [] }, omitted: 0, elapsedMs: 0, results: {
                bindings: [{
                    l: { type: 'literal', value: 'chat', 'xml:lang': 'fr', datatype: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString' },
                    n: { type: 'literal', value: '1', datatype: `${XSD}integer` },
                    s: { type: 'literal', value: 'x', datatype: `${XSD}string` },
                    t: { type: 'triple', value: { subject: { type: 'bnode', value: '3:7' }, predicate: { type: 'uri', value: 'urn:x:p' }, object: { type: 'literal', value: 'o' } } },
                }],
            },
        }).select('');
        expect(row.l.termType === 'Literal' && row.l.language).toBe('fr');
        expect(row.n.termType === 'Literal' && row.n.datatype.value).toBe(`${XSD}integer`);
        expect(row.s.termType === 'Literal' && row.s.language === '' && row.s.datatype.value).toBe(`${XSD}string`);
        expect(row.t.termType).toBe('Quad');
        expect(row.t.termType === 'Quad' && row.t.subject.value).toBe('urn:skolem:blank:000003-00000007');
    });

    test('omitted > 0 and an answer of another kind throw', async () => {
        await expect(answer({ kind: 'select', head: { vars: [] }, results: { bindings: [] }, omitted: 2, elapsedMs: 0 }).select('')).rejects.toThrow(/maxRows/);
        await expect(answer({ kind: 'select', head: { vars: [] }, results: { bindings: [] }, omitted: 0, elapsedMs: 0 }).construct('')).rejects.toThrow(/select to a construct/);
        await expect(answer({ kind: 'construct', triples: [], omitted: 0, elapsedMs: 0 }).select('')).rejects.toThrow(/construct to a select/);
    });

    test('a server without turtle/query (-32601) gives QUERY_MISSING; another error passes unchanged', async () => {
        const failing = (err: unknown) => nodePort({ client: () => ({ isRunning: () => true, sendRequest: async () => { throw err; } }), idle: async () => {} });
        await expect(failing({ code: -32601, message: 'Unhandled method' }).ask('ASK {}')).rejects.toThrow(QUERY_MISSING);
        await expect(failing({ code: -32602, message: 'bad query' }).ask('ASK {}')).rejects.toMatchObject({ code: -32602 });
    });
});
