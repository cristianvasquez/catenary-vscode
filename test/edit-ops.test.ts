// Oracle comparison: each op of src/edit/ops.ts over ViewQuads + Facts gives the same view quads and result as src/catenary/rdf/ops.ts over the graph.
import type { NamedNode, Quad } from '@rdfjs/types';
import { resolve } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import type { ViewCommand } from '../src/catenary/model/commands';
import { iriId } from '../src/catenary/model/ids';
import type { ModelGraph } from '../src/catenary/rdf/graph';
import { elementTerm } from '../src/catenary/rdf/ids';
import { viewFiguresOf } from '../src/catenary/rdf/notations';
import * as old from '../src/catenary/rdf/ops';
import { rdf, tripleKey } from '../src/catenary/rdf/terms';
import { V } from '../src/catenary/rdf/views';
import type { Facts } from '../src/edit/facts';
import * as ops from '../src/edit/ops';
import { ViewQuads, viewText } from '../src/edit/view-quads';
import { diagramOf } from '../src/model/diagram';
import { graphOf } from '../src/model/graph-input';
import { ViewStore } from '../src/model/store';
import { factsFromGraph } from './edit-facts';
import { fixtureGraph } from './fixture-graph';

// Mark IRIs take random bytes: the same sequence for the old and the new op gives the same IRIs.
const random = vi.hoisted(() => ({ n: 0 }));
vi.mock('crypto', async importOriginal => {
    const actual = await importOriginal<typeof import('crypto')>();
    const randomBytes = (size: number) => { const n = random.n++; return Buffer.from(Array.from({ length: size }, (_, i) => (n * 37 + i * 11) & 255)); };
    return { ...actual, default: { ...actual, randomBytes }, randomBytes };
});

const result = fixtureGraph();
const files = ['instances', 'model'].map(f => resolve(`test/fixtures/shapes/${f}.trig`));
const view = 'urn:name:Bookshop', model = 'urn:name:Bookshop%20model';
const vid = iriId(view), mid = iriId(model);
const at = { x: 1200, y: 1300 };
let store: ViewStore;
beforeEach(() => { store = new ViewStore(graphOf(result, files).graph); });

const children = (iri = view) => diagramOf(store.graph, iri).children!;
const cards = () => children().filter(e => e.type === 'node:card').map(e => e.element as string);
const relation = () => children().find(e => e.type === 'edge:relation')!.element as string;
const run = (c: ViewCommand) => {
    const r = store.execute(c);
    expect(r, c.kind).toMatchObject({ ok: true });
    return r.ok ? r.value as string : '';
};
const note = () => run({ kind: 'createNote', view: vid, text: 'note', at });
const keys = (qs: Quad[]) => qs.map(tripleKey).sort();
const viewQuads = (iri: string) => store.graph.match(null, null, null, rdf.namedNode(iri));

/**
 * Runs the new op on the quads of view `iri` with the facts of the graph, then the old op on the graph in one transaction. The view
 * quads after must be the same set, and the results equal. `changes`: the op changes the view (false: it must not).
 */
function compare<T>(iri: string, before: (g: ModelGraph) => T, after: (v: ViewQuads, f: Facts) => T, changes = true): ViewQuads {
    const g = store.graph, start = keys(viewQuads(iri));
    const v = new ViewQuads(viewQuads(iri), rdf.namedNode(iri));
    random.n = 0;
    const got = after(v, factsFromGraph(g));
    random.n = 0;
    let want: T | undefined;
    g.transact(x => { want = before(x); return { ok: true }; });
    expect(got).toEqual(want);
    const end = keys(viewQuads(iri));
    expect(keys(v.quads())).toEqual(end);
    if (changes) expect(end).not.toEqual(start); else expect(end).toEqual(start);
    return v;
}

const vertices = (iri: string) => viewQuads(iri).filter(q => q.predicate.equals(V.vertices)).map(q => q.object.value).sort();

test('ViewQuads: changes, steps and viewText as ViewStore.viewText', () => {
    const v = new ViewQuads(viewQuads(view));
    expect(viewText(v)).toEqual(store.viewText(view));
    const s = rdf.namedNode('urn:x:s'), p = rdf.namedNode('urn:x:p');
    v.add(s, p, rdf.literal('1'));
    v.set(s, p, rdf.literal('2'));
    expect(v.steps().map(c => c.op)).toEqual(['add', 'remove', 'add']);
    expect(keys(v.changes().added)).toEqual([`<urn:x:s> <urn:x:p> "2"^^<http://www.w3.org/2001/XMLSchema#string>`]);
    expect(v.changes().removed).toEqual([]);
    v.removeMatches(s);
    expect(v.changes()).toEqual({ added: [], removed: [] });
});

test('addToView, then placeConnectors (addToView)', () => {
    const id = cards()[0];
    run({ kind: 'removeFromView', view: vid, ids: [id] });
    compare(view, g => old.cardSize(g, id), (v, f) => ops.cardSize(v, f, id), false);
    compare(view, g => old.cardTerm(g, id)?.value, (v, f) => ops.cardTerm(v, f, id)?.value, false);
    compare(view, g => old.instanceTerm(g, id)?.value, (v, f) => ops.instanceTerm(v, f, id)?.value, false);
    const v = compare(view, g => { const r = old.addToView(g, vid, id, at); old.placeConnectors(g); return r; },
        (v, f) => { const r = ops.addToView(v, f, vid, id, at); ops.placeConnectors(v, f); return r; });
    // The relations to the placed cards came back.
    expect(v.changes().added.some(q => q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies')).toBe(true);
});

test('addToView of a card in the view fails with the same message', () => {
    const id = cards()[0];
    compare(view, g => old.addToView(g, vid, id, at), (v, f) => ops.addToView(v, f, vid, id, at), false);
});

test('hideEdge hidden, then shown (hideEdges, showRelations)', () => {
    const id = relation();
    compare(view, g => old.relationTerms(g, id), (v, f) => ops.relationTerms(v, f, id), false);
    compare(view, g => old.hideEdge(g, vid, id, true), (v, f) => ops.hideEdge(v, f, vid, id, true));
    compare(view, g => old.hideEdge(g, vid, id, false), (v, f) => ops.hideEdge(v, f, vid, id, false));
});

test('removeViewElements of a card (removeFromView)', () => {
    const id = cards()[0];
    compare(view, g => old.removeViewElements(g, vid, [id]), (v, f) => ops.removeViewElements(v, f, vid, [id]));
});

test('setBounds of a card (setBounds)', () => {
    const id = cards()[0], figures = viewFiguresOf(store.graph, view);
    compare(view, g => old.setBounds(g, vid, [{ id, ...at, width: 600 }]), (v, f) => ops.setBounds(v, f, vid, [{ id, ...at, width: 600 }], () => figures));
});

test('setBounds moves the bends of a relation whose ends move, then clearEdgeLayouts (setLayout)', () => {
    const id = relation();
    run({ kind: 'setEdgeLayout', view: vid, relation: id, patch: { vertices: [{ x: 12, y: 34 }], fromSide: 'top' } });
    const r = old.relationTerms(store.graph, id)!, before = vertices(view);
    const bounds = [r.s, r.o].map(t => ({ id: iriId(t.value), dx: 100, dy: 50 }))
        .map(b => { const box = children().find(e => e.element === b.id)!; const p = (box as unknown as { position: { x: number; y: number } }).position; return { id: b.id, x: p.x + b.dx, y: p.y + b.dy }; });
    const figures = viewFiguresOf(store.graph, view);
    compare(view, g => old.setBounds(g, vid, bounds), (v, f) => ops.setBounds(v, f, vid, bounds, () => figures));
    expect(vertices(view)).not.toEqual(before);
    compare(view, g => old.clearEdgeLayouts(g, vid), (v, f) => ops.clearEdgeLayouts(v, f, vid));
});

test('setEdgeLayout of a relation (setEdgeLayout)', () => {
    const id = relation(), patch = { color: '#ff0000', vertices: [{ x: 12, y: 34 }] };
    compare(view, g => old.setEdgeLayout(g, vid, id, patch), (v, f) => ops.setEdgeLayout(v, f, vid, id, patch));
});

test('setEdgeLayout and setBounds of a property line (the figures of the view)', () => {
    const line = children(model).find(e => e.type === 'edge:property' && e.name === 'ex:stocks')! as unknown as { id: string; sourceId: string; targetId: string };
    compare(model, g => old.setEdgeLayout(g, mid, line.id, { vertices: [{ x: 5, y: 6 }] }), (v, f) => ops.setEdgeLayout(v, f, mid, line.id, { vertices: [{ x: 5, y: 6 }] }));
    store.graph.transact(g => old.setEdgeLayout(g, mid, line.id, { vertices: [{ x: 5, y: 6 }] }));
    const ends = children(model).filter(e => e.id === line.sourceId || e.id === line.targetId) as unknown as { element: string; position: { x: number; y: number } }[];
    expect(ends).toHaveLength(2);
    const bounds = ends.map(e => ({ id: e.element, x: e.position.x + 40, y: e.position.y + 30 })), before = vertices(model);
    const figures = viewFiguresOf(store.graph, model);
    compare(model, g => old.setBounds(g, mid, bounds), (v, f) => ops.setBounds(v, f, mid, bounds, () => figures));
    expect(vertices(model)).not.toEqual(before);
});

test('setViewElement of a card (setViewElements)', () => {
    const id = cards()[0], patch = { color: '#123456', display: 'simple' as const };
    compare(view, g => old.setViewElement(g, vid, id, patch), (v, f) => ops.setViewElement(v, f, vid, id, patch));
});

test('setViewElement of a note text with expectedText (setViewElements)', () => {
    const id = note();
    compare(view, g => old.setViewElement(g, vid, id, { text: 'edited' }, 'other'), (v, f) => ops.setViewElement(v, f, vid, id, { text: 'edited' }, 'other'), false);
    compare(view, g => old.setViewElement(g, vid, id, { text: 'edited' }, 'note'), (v, f) => ops.setViewElement(v, f, vid, id, { text: 'edited' }, 'note'));
});

test('boundsOf and createGroup, then the group label and a group move (createGroup)', () => {
    const around = [cards()[0]];
    compare(view, g => old.boundsOf(g, vid, around, 50), (v, f) => ops.boundsOf(v, f, vid, around, 50), false);
    const rect = old.boundsOf(store.graph, vid, around, 50)!;
    compare(view, g => old.createGroup(g, vid, 'frame', rect), (v, f) => ops.createGroup(v, f, vid, 'frame', rect));
    const id = run({ kind: 'createGroup', view: vid, label: 'frame', around });
    compare(view, g => old.setViewElement(g, vid, id, { label: 'renamed', width: 10 }), (v, f) => ops.setViewElement(v, f, vid, id, { label: 'renamed', width: 10 }));
    const figures = viewFiguresOf(store.graph, view), bounds = [{ id, x: rect.x + 70, y: rect.y + 20 }];
    compare(view, g => old.setBounds(g, vid, bounds), (v, f) => ops.setBounds(v, f, vid, bounds, () => figures));
});

test('createNote (createNote)', () => {
    compare(view, g => old.createNote(g, vid, 'new note', at), (v, f) => ops.createNote(v, f, vid, 'new note', at));
});

test('createArrow, then pruneArrows removes an arrow whose end left (createArrow)', () => {
    const from = note(), to = cards()[0];
    compare(view, g => old.createArrow(g, vid, from, to), (v, f) => ops.createArrow(v, f, vid, from, to));
    // The placement of the card goes without the arrow placement: pruneArrows removes the arrow placement and the arrow statement.
    const g0 = rdf.namedNode(view), placement = viewQuads(view).find(q => q.predicate.equals(V.element) && q.object.value === elementTerm(to)!.value)!.subject;
    const v = compare(view, g => { old.removeTree(g, placement, g0); old.pruneArrows(g); }, (v, f) => { ops.removeTree(v, f, placement); ops.pruneArrows(v, f); });
    expect(v.changes().removed.some(q => q.predicate.equals(V.arrow))).toBe(true);
    expect(viewQuads(view).some(q => q.predicate.equals(V.arrow) && q.object.value === elementTerm(to)!.value)).toBe(false);
});

test('createViewReference (addViewReference)', () => {
    for (const e of children().filter(e => e.type === 'node:view-reference')) run({ kind: 'removeFromView', view: vid, ids: [e.id] });
    compare(view, g => old.viewTerm(g, mid)?.value, (v, f) => ops.viewTerm(v, f, mid)?.value, false);
    compare(view, g => old.createViewReference(g, vid, mid, at), (v, f) => ops.createViewReference(v, f, vid, mid, at));
});

test('createFileReference (addFileReference)', () => {
    compare(view, g => old.createFileReference(g, vid, '../readme.md', at), (v, f) => ops.createFileReference(v, f, vid, '../readme.md', at));
});

test('createCollection (collect)', () => {
    const ids = cards().slice(0, 2), rect = { x: 0, y: 0, width: 400, height: 300 };
    compare(view, g => old.createCollection(g, vid, ids, rect), (v, f) => ops.createCollection(v, f, vid, ids, rect));
});

test('addToCollection (addToCollection)', () => {
    const [a, b, c] = cards(), id = run({ kind: 'collect', view: vid, ids: [a, b] });
    compare(view, g => old.addToCollection(g, vid, id, [c]), (v, f) => ops.addToCollection(v, f, vid, id, [c]));
});

test('uncollect of one member, and of the whole collection (uncollect)', () => {
    const [a, b] = cards(), id = run({ kind: 'collect', view: vid, ids: [a, b] });
    compare(view, g => old.uncollect(g, vid, id, [a]), (v, f) => ops.uncollect(v, f, vid, id, [a]));
    const one = run({ kind: 'collect', view: vid, ids: [cards()[0]] });
    compare(view, g => old.uncollect(g, vid, one), (v, f) => ops.uncollect(v, f, vid, one));
});

test('removeViewElements of a collection removes its members (removeFromView)', () => {
    const id = run({ kind: 'collect', view: vid, ids: cards().slice(0, 2) });
    compare(view, g => old.removeViewElements(g, vid, [id]), (v, f) => ops.removeViewElements(v, f, vid, [id]));
});

test('id helpers: elementIdOf, viewElementTerm', () => {
    const card = children().find(e => e.type === 'node:card')!, edge = children().find(e => e.type === 'edge:relation')!, n = note();
    for (const id of [card.id, edge.id, n, 'missing']) compare(view, g => old.elementIdOf(g, id), (v, f) => ops.elementIdOf(v, f, id), false);
    compare(view, g => old.viewElementTerm(g, rdf.namedNode(view), n)?.value, (v, f) => ops.viewElementTerm(v, f, n)?.value, false);
});

test('statement helpers: newMark, addPlacement, writeBox, removeTree, dropFromView', () => {
    const g0 = rdf.namedNode(view), card = elementTerm(cards()[0])!;
    compare(view, g => old.newMark(g, g0, V.Note, [[V.text, rdf.literal('x')]]).value, (v, f) => ops.newMark(v, f, V.Note, [[V.text, rdf.literal('x')]]).value);
    const other = rdf.namedNode('urn:x:element');
    compare(view, g => old.addPlacement(g, g0, other).value, (v, f) => ops.addPlacement(v, f, other).value);
    const placement = viewQuads(view).find(q => q.predicate.equals(V.element) && q.object.equals(card))!.subject as NamedNode;
    compare(view, g => old.writeBox(g, g0, placement, { x: 1, y: 2, width: 3 }), (v, f) => ops.writeBox(v, f, placement, { x: 1, y: 2, width: 3 }));
    compare(view, g => old.removeTree(g, placement, g0), (v, f) => ops.removeTree(v, f, placement));
    store = new ViewStore(graphOf(result, files).graph);
    compare(view, g => old.dropFromView(g, g0, card), (v, f) => ops.dropFromView(v, f, card));
});

test('result helpers', () => {
    expect(ops.ok(1)).toEqual(old.ok(1));
    expect(ops.fail('x')).toEqual(old.fail('x'));
    expect(ops.noop('x')).toEqual(old.noop('x'));
    expect(ops.gone('view', 'v')).toEqual(old.gone('view', 'v'));
    expect(ops.LIST_PREFIX).toEqual(old.LIST_PREFIX);
});
