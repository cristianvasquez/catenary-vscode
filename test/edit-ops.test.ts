// Each op of src/edit/ops.ts over the view quads of the server and the facts of factsOf (fork binary over stdio) gives the result and the
// view change that the op of the old src/catenary/rdf/ops.ts gave over the graph (recorded before K11 deleted it:
// test/fixtures/expected/edit-ops.json). A test starts from the fixture views; its steps reach the server as the text of the view.
import type { NamedNode } from '@rdfjs/types';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { ViewCommand } from '../src/catenary/model/commands';
import { idIri, iriId } from '../src/catenary/model/ids';
import type { Facts } from '../src/edit/facts';
import { factsOf } from '../src/edit/facts-of';
import * as ops from '../src/edit/ops';
import { elementTerm, rdf, tripleKey, V } from '../src/edit/terms';
import { ViewQuads, viewText } from '../src/edit/view-quads';
import { diagramOf, type ModelContext, modelContextOf } from '../src/read/diagram';
import { viewFiguresOf } from '../src/read/figures';
import { changeOf, json, recorded } from './expected';
import { FIXTURE, startServer } from './server';
import { type ViewDocuments, viewDocuments } from './views';

// Mark IRIs take random bytes: each op starts the same sequence, as the recording did.
const random = vi.hoisted(() => ({ n: 0 }));
vi.mock('crypto', async importOriginal => {
    const actual = await importOriginal<typeof import('crypto')>();
    const randomBytes = (size: number) => { const n = random.n++; return Buffer.from(Array.from({ length: size }, (_, i) => (n * 37 + i * 11) & 255)); };
    return { ...actual, default: { ...actual, randomBytes }, randomBytes };
});

const R = recorded('edit-ops');
const cases = new Map<string, number>();
const view = 'urn:name:Bookshop', model = 'urn:name:Bookshop%20model';
const vid = iriId(view), mid = iriId(model);
const at = { x: 1200, y: 1300 };
let server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext, docs: ViewDocuments;
beforeAll(async () => {
    server = await startServer(FIXTURE, 282);
    ctx = (await modelContextOf(server.port(), readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(f => join(FIXTURE, f)))).ctx;
    docs = viewDocuments(server, () => ctx, { [view]: join(FIXTURE, 'instances.trig'), [model]: join(FIXTURE, 'model.trig') });
}, 20000);
afterAll(async () => { await server?.stop(); });
beforeEach(() => { docs.reset(); random.n = 0; });

const children = async (iri = view) => (await diagramOf(ctx, iri)).schema.children!;
const cards = async () => (await children()).filter(e => e.type === 'node:card').map(e => e.element as string);
const relation = async () => (await children()).find(e => e.type === 'edge:relation')!.element as string;
const iriOf = (v: string) => v.includes(':') ? v : idIri(v)!;
const run = async (c: ViewCommand) => {
    const r = await docs.run(c, [iriOf((c as { view: string }).view)]);
    expect(r, c.kind).toMatchObject({ ok: true });
    return r.ok ? r.value as string : '';
};
const note = () => run({ kind: 'createNote', view: vid, text: 'note', at });
const keys = (v: ViewQuads) => v.quads().map(tripleKey).sort();
const figuresOf = (iri: string) => viewFiguresOf(ctx.port, iri, ctx.shapes, ctx.modelFiles);

/**
 * Runs the op on the server quads of view `iri` with the facts of the command `c` (factsOf), and compares its result and the change of the
 * view with the recorded old op. `changes`: the op changes the view (false: it must not). A change reaches the server.
 */
async function compare<T>(iri: string, c: ViewCommand, op: (v: ViewQuads, f: Facts) => T, changes = true): Promise<ViewQuads> {
    const v = await docs.quads(iri), start = keys(v), facts = await factsOf(ctx, c, { [iri]: v });
    random.n = 0;
    const got = op(v, facts), end = keys(v);
    const name = expect.getState().currentTestName!, n = cases.get(name) ?? 0;
    cases.set(name, n + 1);
    const { want, ...change } = R(`${name} ${n}`) as { want: unknown } & ReturnType<typeof changeOf>;
    expect(json(got ?? null)).toEqual(want);
    expect(changeOf(start, end)).toEqual(change);
    if (changes) expect(end).not.toEqual(start); else expect(end).toEqual(start);
    if (changes) docs.set(iri, viewText(v));
    return v;
}

const vertices = async (iri: string) => (await docs.quads(iri)).quads().filter(q => q.predicate.equals(V.vertices)).map(q => q.object.value).sort();
const positionOf = (e: unknown) => (e as { position: { x: number; y: number } }).position;

test('ViewQuads: changes, steps; viewText of the fixture view reads back as the same statements, triple terms included', async () => {
    const v = await docs.quads(view);
    docs.set(view, viewText(v));
    expect(await docs.keys(view)).toEqual(keys(v));
    expect(keys(v).some(k => k.includes('<<( '))).toBe(true);
    const s = rdf.namedNode('urn:x:s'), p = rdf.namedNode('urn:x:p');
    v.add(s, p, rdf.literal('1'));
    v.set(s, p, rdf.literal('2'));
    expect(v.steps().map(c => c.op)).toEqual(['add', 'remove', 'add']);
    expect(v.changes().added.map(tripleKey)).toEqual([`<urn:x:s> <urn:x:p> "2"^^<http://www.w3.org/2001/XMLSchema#string>`]);
    expect(v.changes().removed).toEqual([]);
    v.removeMatches(s);
    expect(v.changes()).toEqual({ added: [], removed: [] });
});

test('addToView, then placeConnectors (addToView)', async () => {
    const id = (await cards())[0];
    await run({ kind: 'removeFromView', view: vid, ids: [id] });
    const c: ViewCommand = { kind: 'addToView', view: vid, ids: [id], at };
    await compare(view, c, (v, f) => ops.cardSize(v, f, id), false);
    await compare(view, c, (v, f) => ops.cardTerm(v, f, id)?.value, false);
    await compare(view, c, (v, f) => ops.instanceTerm(v, f, id)?.value, false);
    const v = await compare(view, c, (v, f) => { const r = ops.addToView(v, f, vid, id, at); ops.placeConnectors(v, f); return r; });
    // The relations to the placed cards came back.
    expect(v.changes().added.some(q => q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies')).toBe(true);
});

test('addToView of a card in the view fails with the same message', async () => {
    const id = (await cards())[0];
    await compare(view, { kind: 'addToView', view: vid, ids: [id], at }, (v, f) => ops.addToView(v, f, vid, id, at), false);
});

test('hideEdge hidden, then shown (hideEdges, showRelations)', async () => {
    const id = await relation(), c: ViewCommand = { kind: 'hideEdges', view: vid, ids: [id], hidden: true };
    await compare(view, c, (v, f) => ops.relationTerms(v, f, id), false);
    await compare(view, c, (v, f) => ops.hideEdge(v, f, vid, id, true));
    await compare(view, c, (v, f) => ops.hideEdge(v, f, vid, id, false));
});

test('removeViewElements of a card (removeFromView)', async () => {
    const id = (await cards())[0];
    await compare(view, { kind: 'removeFromView', view: vid, ids: [id] }, (v, f) => ops.removeViewElements(v, f, vid, [id]));
});

test('setBounds of a card (setBounds)', async () => {
    const id = (await cards())[0], figures = await figuresOf(view), bounds = [{ id, ...at, width: 600 }];
    await compare(view, { kind: 'setBounds', view: vid, bounds }, (v, f) => ops.setBounds(v, f, vid, bounds, () => figures));
});

test('setBounds moves the bends of a relation whose ends move, then clearEdgeLayouts (setLayout)', async () => {
    const id = await relation();
    await run({ kind: 'setEdgeLayout', view: vid, relation: id, patch: { vertices: [{ x: 12, y: 34 }], fromSide: 'top' } });
    const quads = await docs.quads(view), facts = await factsOf(ctx, { kind: 'setEdgeLayout', view: vid, relation: id, patch: {} }, { [view]: quads });
    const r = ops.relationTerms(quads, facts, id)!, before = await vertices(view), elements = await children();
    const bounds = [r.s, r.o].map(t => { const p = positionOf(elements.find(e => e.element === iriId(t.value))); return { id: iriId(t.value), x: p.x + 100, y: p.y + 50 }; });
    const figures = await figuresOf(view);
    await compare(view, { kind: 'setBounds', view: vid, bounds }, (v, f) => ops.setBounds(v, f, vid, bounds, () => figures));
    expect(await vertices(view)).not.toEqual(before);
    await compare(view, { kind: 'setLayout', view: vid, bounds: [] }, (v, f) => ops.clearEdgeLayouts(v, f, vid));
});

test('setEdgeLayout of a relation (setEdgeLayout)', async () => {
    const id = await relation(), patch = { color: '#ff0000', vertices: [{ x: 12, y: 34 }] };
    await compare(view, { kind: 'setEdgeLayout', view: vid, relation: id, patch }, (v, f) => ops.setEdgeLayout(v, f, vid, id, patch));
});

test('setEdgeLayout and setBounds of a property line (the figures of the view)', async () => {
    const line = (await children(model)).find(e => e.type === 'edge:property' && e.name === 'ex:stocks')! as unknown as { id: string; sourceId: string; targetId: string };
    const patch = { vertices: [{ x: 5, y: 6 }] };
    await compare(model, { kind: 'setEdgeLayout', view: mid, relation: line.id, patch }, (v, f) => ops.setEdgeLayout(v, f, mid, line.id, patch));
    const ends = (await children(model)).filter(e => e.id === line.sourceId || e.id === line.targetId) as unknown as { element: string; position: { x: number; y: number } }[];
    expect(ends).toHaveLength(2);
    const bounds = ends.map(e => ({ id: e.element, x: e.position.x + 40, y: e.position.y + 30 })), before = await vertices(model);
    const figures = await figuresOf(model);
    await compare(model, { kind: 'setBounds', view: mid, bounds }, (v, f) => ops.setBounds(v, f, mid, bounds, () => figures));
    expect(await vertices(model)).not.toEqual(before);
});

test('setViewElement of a card (setViewElements)', async () => {
    const id = (await cards())[0], patch = { color: '#123456', display: 'simple' as const };
    await compare(view, { kind: 'setViewElements', view: vid, ids: [id], patch }, (v, f) => ops.setViewElement(v, f, vid, id, patch));
});

test('setViewElement of a note text with expectedText (setViewElements)', async () => {
    const id = await note(), c: ViewCommand = { kind: 'setViewElements', view: vid, ids: [id], patch: { text: 'edited' } };
    await compare(view, c, (v, f) => ops.setViewElement(v, f, vid, id, { text: 'edited' }, 'other'), false);
    await compare(view, c, (v, f) => ops.setViewElement(v, f, vid, id, { text: 'edited' }, 'note'));
});

test('boundsOf and createGroup, then the group label and a group move (createGroup)', async () => {
    const around = [(await cards())[0]], c: ViewCommand = { kind: 'createGroup', view: vid, label: 'frame', around };
    await compare(view, c, (v, f) => ops.boundsOf(v, f, vid, around, 50), false);
    const quads = await docs.quads(view), rect = ops.boundsOf(quads, await factsOf(ctx, c, { [view]: quads }), vid, around, 50)!;
    await compare(view, c, (v, f) => ops.createGroup(v, f, vid, 'frame', rect));
    const id = await run(c);
    const patch = { label: 'renamed', width: 10 };
    await compare(view, { kind: 'setViewElements', view: vid, ids: [id], patch }, (v, f) => ops.setViewElement(v, f, vid, id, patch));
    const figures = await figuresOf(view), bounds = [{ id, x: rect.x + 70, y: rect.y + 20 }];
    await compare(view, { kind: 'setBounds', view: vid, bounds }, (v, f) => ops.setBounds(v, f, vid, bounds, () => figures));
});

test('createNote (createNote)', async () => {
    await compare(view, { kind: 'createNote', view: vid, text: 'new note', at }, (v, f) => ops.createNote(v, f, vid, 'new note', at));
});

test('createArrow, then pruneArrows removes an arrow whose end left (createArrow)', async () => {
    const from = await note(), to = (await cards())[0], c: ViewCommand = { kind: 'createArrow', view: vid, from, to };
    await compare(view, c, (v, f) => ops.createArrow(v, f, vid, from, to));
    // The placement of the card goes without the arrow placement: pruneArrows removes the arrow placement and the arrow statement.
    const placement = (await docs.quads(view)).quads().find(q => q.predicate.equals(V.element) && q.object.value === elementTerm(to)!.value)!.subject;
    const v = await compare(view, c, (v, f) => { ops.removeTree(v, f, placement); ops.pruneArrows(v, f); });
    expect(v.changes().removed.some(q => q.predicate.equals(V.arrow))).toBe(true);
    expect((await docs.quads(view)).quads().some(q => q.predicate.equals(V.arrow) && q.object.value === elementTerm(to)!.value)).toBe(false);
});

test('createViewReference (addViewReference)', async () => {
    for (const e of (await children()).filter(e => e.type === 'node:view-reference')) await run({ kind: 'removeFromView', view: vid, ids: [e.id] });
    const c: ViewCommand = { kind: 'addViewReference', view: vid, target: mid, at };
    await compare(view, c, (v, f) => ops.viewTerm(v, f, mid)?.value, false);
    await compare(view, c, (v, f) => ops.createViewReference(v, f, vid, mid, at));
});

test('createFileReference (addFileReference)', async () => {
    await compare(view, { kind: 'addFileReference', view: vid, file: '../readme.md', at }, (v, f) => ops.createFileReference(v, f, vid, '../readme.md', at));
});

test('createCollection (collect)', async () => {
    const ids = (await cards()).slice(0, 2), rect = { x: 0, y: 0, width: 400, height: 300 };
    await compare(view, { kind: 'collect', view: vid, ids }, (v, f) => ops.createCollection(v, f, vid, ids, rect));
});

test('addToCollection (addToCollection)', async () => {
    const [a, b, c] = await cards(), id = await run({ kind: 'collect', view: vid, ids: [a, b] });
    await compare(view, { kind: 'addToCollection', view: vid, id, ids: [c] }, (v, f) => ops.addToCollection(v, f, vid, id, [c]));
});

test('uncollect of one member, and of the whole collection (uncollect)', async () => {
    const [a, b] = await cards(), id = await run({ kind: 'collect', view: vid, ids: [a, b] });
    await compare(view, { kind: 'uncollect', view: vid, id, ids: [a] }, (v, f) => ops.uncollect(v, f, vid, id, [a]));
    const one = await run({ kind: 'collect', view: vid, ids: [(await cards())[0]] });
    await compare(view, { kind: 'uncollect', view: vid, id: one }, (v, f) => ops.uncollect(v, f, vid, one));
});

test('removeViewElements of a collection removes its members (removeFromView)', async () => {
    const id = await run({ kind: 'collect', view: vid, ids: (await cards()).slice(0, 2) });
    await compare(view, { kind: 'removeFromView', view: vid, ids: [id] }, (v, f) => ops.removeViewElements(v, f, vid, [id]));
});

test('id helpers: elementIdOf, viewElementTerm', async () => {
    const elements = await children(), card = elements.find(e => e.type === 'node:card')!, edge = elements.find(e => e.type === 'edge:relation')!, n = await note();
    for (const id of [card.id, edge.id, n, 'missing']) await compare(view, { kind: 'removeFromView', view: vid, ids: [id] }, (v, f) => ops.elementIdOf(v, f, id), false);
    await compare(view, { kind: 'removeFromView', view: vid, ids: [n] }, (v, f) => ops.viewElementTerm(v, f, n)?.value, false);
});

test('statement helpers: newMark, addPlacement, writeBox, removeTree, dropFromView', async () => {
    const id = (await cards())[0], card = elementTerm(id)!, c: ViewCommand = { kind: 'removeFromView', view: vid, ids: [id] };
    await compare(view, c, (v, f) => ops.newMark(v, f, V.Note, [[V.text, rdf.literal('x')]]).value);
    const other = rdf.namedNode('urn:x:element');
    await compare(view, c, (v, f) => ops.addPlacement(v, f, other).value);
    const placement = (await docs.quads(view)).quads().find(q => q.predicate.equals(V.element) && q.object.equals(card))!.subject as NamedNode;
    await compare(view, c, (v, f) => ops.writeBox(v, f, placement, { x: 1, y: 2, width: 3 }));
    await compare(view, c, (v, f) => ops.removeTree(v, f, placement));
    docs.reset();
    await compare(view, c, (v, f) => ops.dropFromView(v, f, card));
});

test('result helpers', () => {
    expect(ops.ok(1)).toEqual({ ok: true, value: 1 });
    expect(ops.fail('x')).toEqual({ ok: false, error: 'x' });
    expect(ops.noop('x')).toEqual({ ok: true, value: undefined, changed: false, message: 'x' });
    expect(ops.gone('view', 'v')).toEqual({ ok: false, error: 'No view with the id v: the id is wrong or the view was deleted.' });
    expect(ops.LIST_PREFIX).toBe('urn:trellis:list:');
});
