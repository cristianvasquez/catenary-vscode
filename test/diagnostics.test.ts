import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import type { Diagnostic } from 'vscode';
import { iriId } from '../src/catenary/model/ids';
import { diagramOf } from '../src/model/diagram';
import { graphOf } from '../src/model/graph-input';
import { diagnosticsOf, SHACL_CODE } from '../src/node/diagnostics';
import type { GraphResult } from '../src/node/turtle-api';
import { modelContextOf } from '../src/read/diagram';
import { diagnosticsOf as portDiagnosticsOf } from '../src/read/diagnostics';
import { FIXTURE, fixtureGraph } from './fixture-graph';
import { startServer } from './server';

const result = fixtureGraph();
const graph = graphOf(result, [resolve('test/fixtures/shapes/instances.trig')]).graph;
const animal = 'urn:name:Animal%20Farm';
const edge = result.edges.find(e => result.nodes[e.source].id === animal && e.predicate.endsWith('publicationYear'))!;
const value = result.nodes[edge.target];
const data = readFileSync('test/fixtures/shapes/data.ttl', 'utf8'), textOf = () => data;
const diagnostic = (range = value.range, code = SHACL_CODE, severity = 0) => ({ range, code, severity, message: 'expected at most 1 value(s)' }) as Diagnostic;

test('literal range gives focus, path, count and badge message', () => {
    const violations = diagnosticsOf(graph, result, { [value.uri]: [diagnostic()] }, textOf);
    expect(violations).toEqual([{ focus: animal, instance: iriId(animal), path: edge.predicate, shape: iriId('urn:name:Book%20shape-publicationYear'), severity: 'Violation', component: '', message: 'expected at most 1 value(s)', uri: value.uri, range: value.range }]);
    const card = diagramOf(graph, 'urn:name:Bookshop', { violations }).children!.find(x => x.name === 'Animal Farm')!;
    expect(card).toMatchObject({ violations: 1, violationMessage: 'expected at most 1 value(s)' });
});

test('predicate-only diagnostic range maps the next literal when only whitespace separates them', () => {
    const line = value.range.start.line, shape = iriId('urn:name:Book%20shape-publicationYear');
    const range = { start: { line, character: 4 }, end: { line, character: value.range.start.character - 1 } };
    expect(diagnosticsOf(graph, result, { [value.uri]: [diagnostic(range)] }, textOf)[0]).toMatchObject({ instance: iriId(animal), path: edge.predicate, shape, range });
    // The predicate on the line before the literal.
    const lines = data.split('\n');
    lines[line - 1] = '    <http://www.example.org/publicationYear>';
    lines[line] = ' '.repeat(value.range.start.character) + '1945 .';
    const broken = { start: { line: line - 1, character: 4 }, end: { line: line - 1, character: lines[line - 1].length } };
    expect(diagnosticsOf(graph, result, { [value.uri]: [diagnostic(broken)] }, () => lines.join('\n'))[0]).toMatchObject({ path: edge.predicate, shape });
});

test('predicate-only diagnostic on an IRI-valued predicate does not take the next literal', () => {
    const line = value.range.start.line - 1, author = data.split('\n')[line];
    const range = { start: { line, character: 4 }, end: { line, character: author.indexOf('>') + 1 } };
    const violation = diagnosticsOf(graph, result, { [value.uri]: [diagnostic(range)] }, textOf)[0];
    expect(violation.focus).toBe(animal);
    expect(violation).not.toHaveProperty('path');
    expect(violation).not.toHaveProperty('shape');
});

test('non-SHACL and other-file diagnostics do not map', () => {
    expect(diagnosticsOf(graph, result, { [value.uri]: [diagnostic(value.range, 'unknown-term')] }, textOf)).toEqual([]);
    expect(diagnosticsOf(graph, result, { 'file:///elsewhere.ttl': [diagnostic()] }, textOf)).toEqual([]);
});

test('node range and last subject fallback map focus', () => {
    const node = result.nodes[edge.source];
    expect(diagnosticsOf(graph, result, { [node.uri]: [diagnostic(node.range)] }, textOf)[0].focus).toBe(animal);
    const lastEdge = result.edges.filter(e => e.uri === value.uri).sort((a, b) => result.nodes[b.source].range.start.line - result.nodes[a.source].range.start.line)[0];
    const end = { start: { line: 100000, character: 0 }, end: { line: 100000, character: 1 } };
    expect(diagnosticsOf(graph, result, { [value.uri]: [diagnostic(end)] }, textOf)[0].focus).toBe(result.nodes[lastEdge.source].id);
});

test('VS Code warning and information severities are not violation counts', () => {
    for (const [severity, expected] of [[1, 'Warning'], [2, 'Info'], [3, 'Info']] as const) {
        const violations = diagnosticsOf(graph, result, { [value.uri]: [diagnostic(value.range, SHACL_CODE, severity)] }, textOf);
        expect(violations[0].severity).toBe(expected);
        expect(diagramOf(graph, 'urn:name:Bookshop', { violations }).children!.find(x => x.name === 'Animal Farm')!.violations).toBe(0);
    }
});

test('over the port: the same violations as on the old graph, with the classes and the instance test from one query', async () => {
    const server = await startServer(FIXTURE, 282);
    try {
        const live = await server.graph({ literals: true, types: true, maxNodes: 20000, layout: { iterations: 0 } });
        const old = graphOf(live, [resolve('test/fixtures/shapes/instances.trig'), resolve('test/fixtures/shapes/model.trig')]).graph;
        const { ctx } = await modelContextOf(server.port(), readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(f => join(FIXTURE, f)));
        const e = live.edges.find(x => live.nodes[x.source].id === animal && x.predicate.endsWith('publicationYear'))!, v = live.nodes[e.target];
        const line = v.range.start.line;
        // A literal range; a predicate-only range without relatedInformation (the shape comes from the rdf:type of the focus); a node range.
        const byUri = { [v.uri]: [diagnostic(v.range), diagnostic({ start: { line, character: 4 }, end: { line, character: v.range.start.character - 1 } }),
            diagnostic(live.nodes[e.source].range)] };
        const now = await portDiagnosticsOf(ctx, live, byUri, textOf);
        expect(now).toEqual(diagnosticsOf(old, live, byUri, textOf));
        expect(now.map(x => [x.instance, x.shape])).toEqual(Array(2).fill([iriId(animal), iriId('urn:name:Book%20shape-publicationYear')]).concat([[iriId(animal), undefined]]));
        expect(await portDiagnosticsOf(ctx, live, {}, textOf)).toEqual([]);
    } finally {
        await server.stop();
    }
}, 20000);
