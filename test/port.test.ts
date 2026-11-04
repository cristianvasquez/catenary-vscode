// Kata 1rhb: the ModelPort over turtle/query, and the facts of the fork's dataset on test/fixtures/shapes, against the real binary over stdio.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { answerPort, MAX_ROWS, type Row } from '../src/model/port';
import { modelFilesOf, viewFilesOf } from '../src/model/view-files';
import { nodePort } from '../src/node/port';
import type { QueryAnswer } from '../src/node/sparql-endpoint';
import { QUERY_MISSING } from '../src/node/turtle-api';
import { webPort } from '../src/web/port';
import type { LspClient } from '../src/web/turtle-lsp/editor-lsp.js';
import { fileUriOf } from '../src/web/files';
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

    test('files: [file] restricts the dataset to that document; without files: every document; there are no named graphs', async () => {
        const port = server.port();
        expect(count(await port.select('SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }', [file('data.ttl')]))).toBe(27);
        expect(count(await port.select('SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }'))).toBe(TRIPLES);
        expect(await port.select('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }', [file('data.ttl')])).toEqual([]);
    });

    test('the statements of the view graph block of instances.trig are the statements of its file', async () => {
        const port = server.port();
        expect(count(await port.select('SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }', [file('instances.trig')]))).toBe(93);
        expect(await port.select('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }', [file('instances.trig')])).toEqual([]);
    });

    test('a blank node comes back as bnode with a g<n> label, the same label in two queries', async () => {
        // shapes.ttl has no blank node; prefixes.ttl has nine (sh:declare [ ... ]).
        const q = { query: 'SELECT ?s WHERE { ?s <http://www.w3.org/ns/shacl#prefix> "ex" }', files: [uri('prefixes.ttl')] };
        const first = bnodes(await server.query(q)), second = bnodes(await server.query(q));
        expect(first).toHaveLength(1);
        expect(first[0]).toMatch(/^g\d+$/);
        expect(second).toEqual(first);
        const [row] = await server.port().select(q.query, [file('prefixes.ttl')]);
        expect(row.s.termType).toBe('NamedNode');
        expect(row.s.value).toBe(`urn:skolem:blank:x${first[0]}`);
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
        expect(await server.port().ask(`ASK { <urn:name:Bookshop%20model> a <${VIEW}View> }`, [file('model.trig')])).toBe(true);
        expect(await server.port().ask(`ASK { <urn:name:Bookshop> a <${VIEW}View> }`, [file('data.ttl')])).toBe(false);
    });

    test('viewFilesOf gives the two view IRIs with their paths; modelFilesOf the four .ttl files', async () => {
        const rdfFiles = readdirSync(folder).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(file);
        const views = await viewFilesOf(server.port(), rdfFiles.filter(f => f.endsWith('.trig')));
        expect(views).toEqual({ views: new Map([['urn:name:Bookshop', file('instances.trig')], ['urn:name:Bookshop%20model', file('model.trig')]]), skipped: [] });
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

describe('two view files with the same view IRI (temp folder)', () => {
    const view = (label: string) => `<urn:x:v> { <urn:x:v> a <${VIEW}View>; <http://www.w3.org/2000/01/rdf-schema#label> "${label}". }\n`;
    let dir: string, server: Awaited<ReturnType<typeof startServer>>;
    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'catenary-port-'));
        writeFileSync(join(dir, 'a.trig'), view('a'));
        writeFileSync(join(dir, 'b.trig'), view('b'));
        writeFileSync(join(dir, 'c.trig'), `<urn:x:w> { <urn:x:w> a <${VIEW}View>. }\n`);
        writeFileSync(join(dir, 'm.ttl'), '<urn:x:s> <urn:x:p> <urn:x:o> .\n');
        server = await startServer(dir, 6);
    }, 20000);
    afterAll(async () => {
        await server?.stop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    test('both files are skipped and reported; neither is a model file', async () => {
        const trig = ['a.trig', 'b.trig', 'c.trig'].map(f => join(dir, f));
        const found = await viewFilesOf(server.port(), trig);
        expect(found.views).toEqual(new Map([['urn:x:w', join(dir, 'c.trig')]]));
        expect(found.skipped).toEqual([{ file: join(dir, 'a.trig'), reason: 'duplicate view urn:x:v' }, { file: join(dir, 'b.trig'), reason: 'duplicate view urn:x:v' }]);
        expect(modelFilesOf([...trig, join(dir, 'm.ttl')], found)).toEqual([join(dir, 'm.ttl')]);
    });
});

describe('answerPort and nodePort without a server', () => {
    const XSD = 'http://www.w3.org/2001/XMLSchema#';
    const answer = (a: QueryAnswer) => answerPort(async () => a);

    test('both ports send the row limit for every query kind, with and without a file scope', async () => {
        expect(MAX_ROWS).toBe(0);
        const calls: { method: string; params: unknown }[] = [];
        const send = async <R>(method: string, params: unknown): Promise<R> => {
            calls.push({ method, params });
            const { query } = params as { query: string };
            return (query === 'SELECT' ? { kind: 'select', head: { vars: [] }, results: { bindings: [] }, omitted: 0, elapsedMs: 0 }
                : query === 'CONSTRUCT' ? { kind: 'construct', triples: [], omitted: 0, elapsedMs: 0 }
                    : { kind: 'ask', boolean: true, elapsedMs: 0 }) as R;
        };
        const ports = [
            { port: nodePort({ idle: async () => {}, client: () => ({ isRunning: () => true, sendRequest: send }) }), uri: pathToFileURL },
            { port: webPort({ request: send } as unknown as LspClient), uri: (path: string) => ({ href: fileUriOf(path) }) },
        ];
        for (const { port, uri } of ports) {
            for (const files of [undefined, [], [file('data.ttl')]]) {
                for (const [kind, query] of [['select', 'SELECT'], ['construct', 'CONSTRUCT'], ['ask', 'ASK']] as const) {
                    await port[kind](query, files);
                    expect(calls.at(-1)).toEqual({ method: 'turtle/query', params: { query, maxRows: MAX_ROWS, ...(files ? { files: files.map(f => uri(f).href) } : {}) } });
                }
            }
        }
        expect(calls).toHaveLength(18);
    });

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
        await expect(answer({ kind: 'select', head: { vars: [] }, results: { bindings: [] }, omitted: 2, elapsedMs: 0 }).select('')).rejects.toThrow(`server query.maxRows limit (request maxRows: ${MAX_ROWS})`);
        await expect(answer({ kind: 'select', head: { vars: [] }, results: { bindings: [] }, omitted: 0, elapsedMs: 0 }).construct('')).rejects.toThrow(/select to a construct/);
        await expect(answer({ kind: 'construct', triples: [], omitted: 0, elapsedMs: 0 }).select('')).rejects.toThrow(/construct to a select/);
    });

    test('a server without turtle/query (-32601) gives QUERY_MISSING; another error passes unchanged', async () => {
        const failing = (err: unknown) => nodePort({ client: () => ({ isRunning: () => true, sendRequest: async () => { throw err; } }), idle: async () => {} });
        await expect(failing({ code: -32601, message: 'Unhandled method' }).ask('ASK {}')).rejects.toThrow(QUERY_MISSING);
        await expect(failing({ code: -32602, message: 'bad query' }).ask('ASK {}')).rejects.toMatchObject({ code: -32602 });
    });
});
