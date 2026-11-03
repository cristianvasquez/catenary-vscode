// The SPARQL protocol front end (kata 9h08): request forms, content negotiation, serializations, error statuses.
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { startSparqlEndpoint, type JsonTerm, type JsonTriple, type QueryAnswer, type QueryFn, type SparqlEndpoint } from '../src/node/sparql-endpoint';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const row: Record<string, JsonTerm> = {
    s: { type: 'uri', value: 'http://ex.org/a' },
    label: { type: 'literal', value: 'chat, "noir"', 'xml:lang': 'fr' },
    n: { type: 'literal', value: '42', datatype: `${XSD}integer` },
    b: { type: 'bnode', value: 'b0' },
};
const select: QueryAnswer = { kind: 'select', head: { vars: ['s', 'label', 'n', 'b'] }, results: { bindings: [row, { s: { type: 'uri', value: 'http://ex.org/c' } }] }, omitted: 0, elapsedMs: 1 };
const ask: QueryAnswer = { kind: 'ask', head: {}, boolean: true, elapsedMs: 1 };
const triple: JsonTriple = { subject: { type: 'bnode', value: 'x' }, predicate: { type: 'uri', value: 'http://ex.org/p' }, object: { type: 'literal', value: 'line 1\nline "2" \\ end' } };
const construct: QueryAnswer = { kind: 'construct', triples: [triple, { subject: { type: 'uri', value: 'http://ex.org/a' }, predicate: { type: 'uri', value: 'http://ex.org/says' }, object: { type: 'triple', value: triple } }], omitted: 0, elapsedMs: 1 };

const queries: string[] = [];
const lines: string[] = [];
const fake: QueryFn = async q => {
    queries.push(q);
    if (q.startsWith('ASK')) return ask;
    if (q.startsWith('CONSTRUCT')) return construct;
    if (q.startsWith('BAD')) throw { code: -32602, message: 'Syntax error at line 1' };
    if (q.startsWith('SLOW')) throw { code: -32803, message: 'Time limit reached' };
    if (q.startsWith('BOOM')) throw new Error('internal');
    return select;
};

let ep: SparqlEndpoint;
beforeAll(async () => { ep = await startSparqlEndpoint(fake, { port: 0, log: l => lines.push(l) }); });
afterAll(() => ep.close());
beforeEach(() => { queries.length = 0; });

const get = (q: string, accept?: string) => fetch(`${ep.url}?query=${encodeURIComponent(q)}`, { headers: accept ? { Accept: accept } : {} });

test('the URL names the /sparql path on 127.0.0.1 and the port', () => {
    expect(ep.url).toBe(`http://127.0.0.1:${ep.port}/sparql`);
    expect(ep.port).toBeGreaterThan(0);
});

test('GET with a query parameter runs the query and answers SPARQL JSON by default', async () => {
    const res = await fetch(`${ep.url}?query=${encodeURIComponent('SELECT * { ?s ?p ?o }')}&default-graph-uri=urn:g`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/sparql-results\+json/);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ head: select.head, results: (select as { results: unknown }).results });
    expect(queries).toEqual(['SELECT * { ?s ?p ?o }']);
    expect(lines.at(-1)).toMatch(/^GET \/sparql 200 \d+ms$/);
});

test('POST form and POST sparql-query give the query text to the function', async () => {
    const form = await fetch(ep.url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ query: 'SELECT ?x {}', 'named-graph-uri': 'urn:g' }) });
    expect(form.status).toBe(200);
    const direct = await fetch(ep.url, { method: 'POST', headers: { 'Content-Type': 'application/sparql-query; charset=utf-8' }, body: 'SELECT ?y {}' });
    expect(direct.status).toBe(200);
    expect(queries).toEqual(['SELECT ?x {}', 'SELECT ?y {}']);
});

test('application/json gives the same body as the SPARQL JSON type', async () => {
    const res = await get('SELECT', 'application/json');
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect((await res.json()).results.bindings[0].label).toEqual(row.label);
});

test('CSV: lexical forms, quoted when needed, empty for unbound, CRLF', async () => {
    const res = await get('SELECT', 'text/csv');
    expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(await res.text()).toBe('s,label,n,b\r\nhttp://ex.org/a,"chat, ""noir""",42,_:b0\r\nhttp://ex.org/c,,,\r\n');
});

test('TSV: IRIs in <>, literals with @lang or ^^<dt>, blank nodes, empty for unbound, LF', async () => {
    const res = await get('SELECT', 'text/tab-separated-values');
    expect(await res.text()).toBe(`?s\t?label\t?n\t?b\n<http://ex.org/a>\t"chat, \\"noir\\""@fr\t"42"^^<${XSD}integer>\t_:b0\n<http://ex.org/c>\t\t\t\n`);
});

test('the first acceptable type wins; */* gives the default', async () => {
    expect((await get('SELECT', 'text/html, text/csv, application/json')).headers.get('content-type')).toMatch(/^text\/csv/);
    expect((await get('SELECT', 'text/html, */*;q=0.1')).headers.get('content-type')).toMatch(/^application\/sparql-results\+json/);
    expect((await get('SELECT', 'application/sparql-results+json;q=0, */*')).headers.get('content-type')).toMatch(/^application\/json/);
    expect((await get('SELECT', '*/*;q=0.5, text/csv;q=0.2, text/*')).headers.get('content-type')).toMatch(/^text\/tab-separated-values/);
});

test('ASK in JSON and in CSV', async () => {
    expect(await (await get('ASK {}')).json()).toEqual({ head: {}, boolean: true });
    expect(await (await get('ASK {}', 'text/csv')).text()).toBe('true\n');
});

test('CONSTRUCT as N-Triples escapes literals and writes triple terms', async () => {
    const res = await get('CONSTRUCT {}');
    expect(res.headers.get('content-type')).toMatch(/^application\/n-triples/);
    const lit = '"line 1\\nline \\"2\\" \\\\ end"';
    expect(await res.text()).toBe(`_:x <http://ex.org/p> ${lit} .\n<http://ex.org/a> <http://ex.org/says> <<( _:x <http://ex.org/p> ${lit} )>> .\n`);
    expect((await get('CONSTRUCT {}', 'text/turtle')).headers.get('content-type')).toMatch(/^text\/turtle/);
    expect(await (await get('CONSTRUCT {}', 'application/json')).json()).toEqual({ triples: (construct as { triples: unknown }).triples });
});

test('no query: 400; another path: 404; PUT: 405 with Allow; impossible Accept: 406', async () => {
    expect((await fetch(ep.url)).status).toBe(400);
    expect((await fetch(ep.url.replace('/sparql', '/other'))).status).toBe(404);
    const put = await fetch(ep.url, { method: 'PUT', body: 'x' });
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('GET, POST');
    expect(put.headers.get('access-control-allow-origin')).toBe('*');
    expect((await get('SELECT', 'image/png')).status).toBe(406);
    expect((await get('CONSTRUCT {}', 'text/csv')).status).toBe(406);
});

test('a body over 1 MiB: 413', async () => {
    const res = await fetch(ep.url, { method: 'POST', headers: { 'Content-Type': 'application/sparql-query' }, body: 'x'.repeat(1024 * 1024 + 1) });
    expect(res.status).toBe(413);
});

test('rejections map to 400, 503 and 500 with the message as text, no stack', async () => {
    const bad = await get('BAD');
    expect(bad.status).toBe(400);
    expect(bad.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await bad.text()).toBe('Syntax error at line 1\n');
    const slow = await get('SLOW');
    expect(slow.status).toBe(503);
    expect(await slow.text()).toBe('Time limit reached\n');
    const boom = await get('BOOM');
    expect(boom.status).toBe(500);
    expect(await boom.text()).toBe('internal\n');
});

test('GET / names the endpoint URL and the formats in one line', async () => {
    const res = await fetch(ep.url.replace('/sparql', '/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    const text = await res.text();
    expect(text.trimEnd().split('\n')).toHaveLength(1);
    expect(text).toContain(ep.url);
    expect(text).toContain('text/csv');
    expect(text).toContain('application/n-triples');
});
