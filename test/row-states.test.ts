import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Diagnostic } from 'vscode';
import type { VNode } from 'snabbdom';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { diagramOf, modelContextOf, type ModelContext } from '../src/read/diagram';
import { diagnosticsOf, SHACL_CODE } from '../src/read/diagnostics';
import type { Violation } from '../src/catenary/model/validation';
import { renderCard, type CardProps } from '../src/webview/card-chrome';
import { viewFiguresOf } from '../src/read/figures';
import { startServer } from './server';

const VIEW = 'urn:name:Warnings', EX = 'http://ex.org/';
const dir = resolve('test/fixtures/warning');
let server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext, warnings: Violation[];
const card = async (diagnostics = warnings) => (await diagramOf(ctx, VIEW, { violations: diagnostics })).schema.children!.find(c => c.name === 'Alice')!;
const render = (c: Awaited<ReturnType<typeof card>>) => renderCard({ ...c, width: 450, height: 300 } as unknown as CardProps, []);
const children = (n: VNode) => (n.children ?? []).filter((v): v is VNode => typeof v !== 'string');
const descendants = (n: VNode): VNode[] => [n, ...children(n).flatMap(descendants)];

beforeAll(async () => {
    server = await startServer(dir, 27);
    ctx = (await modelContextOf(server.port(), ['data.ttl', 'view.trig'].map(f => resolve(dir, f)))).ctx;
    const graph = await server.graph({ literals: true, types: true, maxNodes: 20000, layout: { iterations: 0 } });
    const byUri: Record<string, Diagnostic[]> = {};
    for (const predicate of ['age', 'score']) {
        const edge = graph.edges.find(e => graph.nodes[e.source].id === EX + 'alice' && e.predicate === EX + predicate)!;
        const value = graph.nodes[edge.target];
        (byUri[value.uri] ??= []).push({ range: value.range, severity: 1, code: SHACL_CODE, message: `${predicate} below minimum` } as Diagnostic);
    }
    warnings = await diagnosticsOf(ctx, graph, byUri, () => readFileSync(resolve(dir, 'data.ttl'), 'utf8'));
}, 20000);
afterAll(async () => { await server?.stop(); });

test('Warning diagnostics mark shaped and unshaped rows amber, with separate count and badge', async () => {
    expect(warnings.map(v => [v.focus, v.path, v.severity])).toEqual([
        [EX + 'alice', EX + 'age', 'Warning'], [EX + 'alice', EX + 'score', 'Warning']
    ]);
    const drawn = await card();
    expect(drawn).toMatchObject({ lines: ['age: 12', 'score: 1'], lineStates: ['warning', 'warning'], violations: 0, warnings: 2 });
    const rendered = render(drawn);
    expect(rendered.data?.class).toMatchObject({ invalid: false, warning: true });
    const nodes = descendants(rendered);
    expect(nodes.filter(n => n.data?.class?.['card-line']).map(n => n.data?.class)).toEqual([
        { 'card-line': true, invalid: false, warning: true }, { 'card-line': true, invalid: false, warning: true }
    ]);
    const badge = nodes.find(n => n.data?.class?.badge)!;
    expect(badge.data?.class?.warning).toBe(true);
    expect(children(badge).find(n => n.sel === 'text')?.text).toBe('2');
    expect(children(badge).find(n => n.sel === 'title')?.text).toContain('age below minimum');
});

test('join rows carry predicate IRIs even when the row has no property shape', async () => {
    const figures = await viewFiguresOf(ctx.port, VIEW, ctx.views.get(VIEW)!, ctx.shapes, ctx.modelFiles);
    const rows = figures.join.boxes.find(b => b.figure.focus.value === EX + 'alice')!.rows;
    expect(rows.filter(r => !r.text.startsWith('rdf:type: ')).map(r => [r.path, r.shaped])).toEqual([[EX + 'age', undefined], [EX + 'score', false]]);
});

test('a diagnostic on another focus or path cannot color these rows', async () => {
    const drawn = await card([{ ...warnings[0], focus: EX + 'bob' }, { ...warnings[0], path: EX + 'missing' }]);
    expect(drawn).toMatchObject({ violations: 0, warnings: 1 });
    expect(drawn.lineStates).toBeUndefined();
});

test('Info diagnostics leave the card and its rows neutral', async () => {
    const drawn = await card(warnings.map(v => ({ ...v, severity: 'Info' })));
    expect(drawn.violations).toBe(0);
    expect(drawn.warnings ?? 0).toBe(0);
    expect(drawn.lineStates).toBeUndefined();
    expect(render(drawn).data?.class).toMatchObject({ invalid: false, warning: false });
});

test('focus alone is sufficient and a different-path Violation does not suppress a Warning row', async () => {
    const drawn = await card([{ ...warnings[0], instance: undefined }, { ...warnings[1], severity: 'Violation' }]);
    expect(drawn).toMatchObject({ violations: 1, warnings: 1, lineStates: ['warning', 'invalid'] });
    expect(render(drawn).data?.class).toMatchObject({ invalid: true, warning: false });
});
