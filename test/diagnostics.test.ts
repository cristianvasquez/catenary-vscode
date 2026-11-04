// Diagnostics of turtle-lsp as SHACL violations over turtle/query (turtle-lsp binary over stdio) on test/fixtures/shapes.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Diagnostic } from 'vscode';
import { iriId } from '../src/catenary/model/ids';
import type { GraphResult } from '../src/node/turtle-api';
import { diagramOf, type ModelContext, modelContextOf } from '../src/read/diagram';
import { diagnosticsOf as portDiagnosticsOf, SHACL_CODE } from '../src/read/diagnostics';
import { json, recorded } from './expected';
import { FIXTURE, startServer } from './server';

const R = recorded('diagnostics');

const animal = 'urn:name:Animal%20Farm';
const data = readFileSync('test/fixtures/shapes/data.ttl', 'utf8'), textOf = () => data;
let server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext, result: GraphResult;
let edge: GraphResult['edges'][number], value: GraphResult['nodes'][number];
beforeAll(async () => {
    server = await startServer(FIXTURE, 282);
    result = await server.graph({ literals: true, types: true, maxNodes: 20000, layout: { iterations: 0 } });
    ctx = (await modelContextOf(server.port(), readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(f => join(FIXTURE, f)))).ctx;
    edge = result.edges.find(e => result.nodes[e.source].id === animal && e.predicate.endsWith('publicationYear'))!;
    value = result.nodes[edge.target];
}, 20000);
afterAll(async () => { await server?.stop(); });
const diagnostic = (range = value.range, code = SHACL_CODE, severity = 0) => ({ range, code, severity, message: 'expected at most 1 value(s)' }) as Diagnostic;
const diagnosticsOf = (byUri: Record<string, Diagnostic[]>, text: (uri: string) => string = textOf) => portDiagnosticsOf(ctx, result, byUri, text);
const card = async (violations: Awaited<ReturnType<typeof diagnosticsOf>>) => (await diagramOf(ctx, 'urn:name:Bookshop', { violations })).schema.children!.find(x => x.name === 'Animal Farm')!;

test('literal range gives focus, path, count and badge message', async () => {
    const violations = await diagnosticsOf({ [value.uri]: [diagnostic()] });
    expect(violations).toEqual([{ focus: animal, instance: iriId(animal), path: edge.predicate, shape: iriId('urn:name:Book%20shape-publicationYear'), severity: 'Violation', component: '', message: 'expected at most 1 value(s)', uri: value.uri, range: value.range }]);
    expect(await card(violations)).toMatchObject({ violations: 1, violationMessage: 'expected at most 1 value(s)' });
});

test('predicate-only diagnostic range maps the next literal when only whitespace separates them', async () => {
    const line = value.range.start.line, shape = iriId('urn:name:Book%20shape-publicationYear');
    const range = { start: { line, character: 4 }, end: { line, character: value.range.start.character - 1 } };
    expect((await diagnosticsOf({ [value.uri]: [diagnostic(range)] }))[0]).toMatchObject({ instance: iriId(animal), path: edge.predicate, shape, range });
    // The predicate on the line before the literal.
    const lines = data.split('\n');
    lines[line - 1] = '    <http://www.example.org/publicationYear>';
    lines[line] = ' '.repeat(value.range.start.character) + '1945 .';
    const broken = { start: { line: line - 1, character: 4 }, end: { line: line - 1, character: lines[line - 1].length } };
    expect((await diagnosticsOf({ [value.uri]: [diagnostic(broken)] }, () => lines.join('\n')))[0]).toMatchObject({ path: edge.predicate, shape });
});

test('predicate-only diagnostic on an IRI-valued predicate does not take the next literal', async () => {
    const line = value.range.start.line - 1, author = data.split('\n')[line];
    const range = { start: { line, character: 4 }, end: { line, character: author.indexOf('>') + 1 } };
    const violation = (await diagnosticsOf({ [value.uri]: [diagnostic(range)] }))[0];
    expect(violation.focus).toBe(animal);
    expect(violation).not.toHaveProperty('path');
    expect(violation).not.toHaveProperty('shape');
});

test('non-SHACL and other-file diagnostics do not map', async () => {
    expect(await diagnosticsOf({ [value.uri]: [diagnostic(value.range, 'unknown-term')] })).toEqual([]);
    expect(await diagnosticsOf({ 'file:///elsewhere.ttl': [diagnostic()] })).toEqual([]);
});

test('node range and last subject fallback map focus', async () => {
    const node = result.nodes[edge.source];
    expect((await diagnosticsOf({ [node.uri]: [diagnostic(node.range)] }))[0].focus).toBe(animal);
    const lastEdge = result.edges.filter(e => e.uri === value.uri).sort((a, b) => result.nodes[b.source].range.start.line - result.nodes[a.source].range.start.line)[0];
    const end = { start: { line: 100000, character: 0 }, end: { line: 100000, character: 1 } };
    expect((await diagnosticsOf({ [value.uri]: [diagnostic(end)] }))[0].focus).toBe(result.nodes[lastEdge.source].id);
});

test('VS Code warning and information severities are not violation counts', async () => {
    for (const [severity, expected] of [[1, 'Warning'], [2, 'Info'], [3, 'Info']] as const) {
        const violations = await diagnosticsOf({ [value.uri]: [diagnostic(value.range, SHACL_CODE, severity)] });
        expect(violations[0].severity).toBe(expected);
        expect((await card(violations)).violations).toBe(0);
    }
});

test('three ranges give the recorded violations of the old graph, with the classes and the instance test from one query', async () => {
    const line = value.range.start.line;
    // A literal range; a predicate-only range without relatedInformation (the shape comes from the rdf:type of the focus); a node range.
    const byUri = { [value.uri]: [diagnostic(value.range), diagnostic({ start: { line, character: 4 }, end: { line, character: value.range.start.character - 1 } }),
        diagnostic(result.nodes[edge.source].range)] };
    const now = await diagnosticsOf(byUri);
    expect(json(now)).toEqual(R('violations'));
    expect(now.map(x => [x.instance, x.shape])).toEqual(Array(2).fill([iriId(animal), iriId('urn:name:Book%20shape-publicationYear')]).concat([[iriId(animal), undefined]]));
    expect(await diagnosticsOf({})).toEqual([]);
});
