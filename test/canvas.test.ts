// The reads and the steps that the canvas edits use (kata embt): halo expand choices, gesture answers, placements, store steps.
// The choices come from turtle/query (fork binary over stdio, kata dxwx); the store edits reach the server as the text of the view files.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { placementOfId } from '../src/catenary/model/doc';
import { iriId } from '../src/catenary/model/ids';
import { viewGesture } from '../src/catenary/model/view-ui';
import { hiddenNeighborCounts } from '../src/catenary/rdf/scoped-doc';
import { shapesIndexOf } from '../src/catenary/rdf/shapes-read';
import { readView } from '../src/catenary/rdf/view-read';
import { expandChoices } from '../src/read/choices';
import { type ModelContext, modelContextOf } from '../src/read/diagram';
import { diagramOf } from '../src/model/diagram';
import { graphOf } from '../src/model/graph-input';
import { ViewStore } from './view-store';
import type { GraphResult } from '../src/node/turtle-api';
import { FIXTURE } from './fixture-graph';
import { startServer } from './server';

/** Triples of the six fixture documents (port.test.ts). */
const TRIPLES = 282;
const files = ['instances', 'model'].map(f => resolve(`test/fixtures/shapes/${f}.trig`));
const views = [['urn:name:Bookshop', files[0]], ['urn:name:Bookshop%20model', files[1]]] as const;
const vid = iriId('urn:name:Bookshop'), mid = iriId('urn:name:Bookshop%20model');
let server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext, result: GraphResult;
let store: ViewStore;
beforeAll(async () => {
    server = await startServer(FIXTURE, TRIPLES);
    ctx = (await modelContextOf(server.port(), readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(f => join(FIXTURE, f)))).ctx;
    result = await server.graph({ literals: true, types: true, maxNodes: 20000, layout: { iterations: 0 } });
    for (const [, file] of views) server.open(pathToFileURL(file).href, readFileSync(file, 'utf8'), 'trig');
}, 20000);
afterAll(async () => { await server?.stop(); });
beforeEach(() => {
    store = new ViewStore(graphOf(result, files).graph);
    for (const [, file] of views) server.change(pathToFileURL(file).href, readFileSync(file, 'utf8'));
});
/** The store's view texts to the server, as the editor sends its document: the next query reads them. */
const sync = () => { for (const [iri, file] of views) server.change(pathToFileURL(file).href, store.viewText(iri)); };
const named = (view: string, name: string) => diagramOf(store.graph, view).children!.find(e => e.name === name)!;
const part = (view: string) => readView(store.graph, view, shapesIndexOf(store.graph).model);

test('expand in of an instance card lists its hidden neighbour', async () => {
    const choices = await expandChoices(ctx, vid, named(vid, 'Tangamandapio').element as string, 'in');
    expect(choices?.items.map(i => i.label)).toEqual(['Cities']);
    expect(await expandChoices(ctx, vid, named(vid, 'Tangamandapio').element as string, 'out')).toBeUndefined();
});

test('expand targets of a node shape card lists the instances it checks', async () => {
    const choices = await expandChoices(ctx, mid, named(mid, 'Book shape').element as string, 'targets');
    expect(choices?.items.map(i => i.label).sort()).toEqual(['Alice’s Adventures in Wonderland', 'Animal Farm', 'Nineteen Eighty-Four']);
});

test('showRelations of an expand choice places the neighbour: one step', async () => {
    const from = named(vid, 'Tangamandapio').element as string;
    const ids = (await expandChoices(ctx, vid, from, 'in'))!.items[0].ids;
    expect(store.execute({ kind: 'showRelations', view: vid, ids, at: { x: 0, y: 0 } })).toMatchObject({ ok: true });
    expect(store.last?.length).toBeGreaterThan(0);
    expect(named(vid, 'Cities')).toBeDefined();
    sync();
    expect(await expandChoices(ctx, vid, from, 'in')).toBeUndefined();
});

test.each(['in', 'out'] as const)('restore a deleted relation from its %s end without changing cards', async dir => {
    const before = part(vid).views[vid];
    const relation = Object.values(part(vid).relations).find(r => r.object === named(vid, 'George Orwell').element && before.edges.some(e => e.relation === r.id))!;
    expect(relation).toBeDefined();
    expect(store.execute({ kind: 'removeFromView', view: vid, ids: [before.edges.find(e => e.relation === relation.id)!.id!] })).toMatchObject({ ok: true });
    expect(part(vid).views[vid].edges.filter(e => !e.hidden)).toHaveLength(before.edges.filter(e => !e.hidden).length - 1);
    const from = dir === 'out' ? relation.subject : relation.object;
    const other = dir === 'out' ? relation.object : relation.subject;
    sync();
    const choices = (await expandChoices(ctx, vid, from, dir))!;
    const item = choices.items.find(i => i.ids.includes(relation.id))!;
    expect(item.label).toBe(part(vid).instances[other].label);
    expect(item.description).toMatch(/ \(in the view\)$/);
    expect(choices.title).toContain(`(${choices.items.length} hidden)`);
    const view = part(vid).views[vid];
    const counts = hiddenNeighborCounts(store.graph, shapesIndexOf(store.graph).model, view);
    expect(counts.get(from)?.[dir]).toBe(choices.items.length);
    expect(view.edges.filter(e => !e.hidden)).toHaveLength(before.edges.filter(e => !e.hidden).length - 1);
    expect(store.execute({ kind: 'showRelations', view: vid, ids: item.ids, at: { x: -1000, y: -1000 } })).toMatchObject({ ok: true });
    const after = part(vid).views[vid];
    expect(after.edges.filter(e => !e.hidden)).toHaveLength(view.edges.filter(e => !e.hidden).length + 1);
    expect(after.boxes).toEqual(before.boxes);
    sync();
    expect((await expandChoices(ctx, vid, from, dir))?.items.some(i => i.ids.includes(relation.id)) ?? false).toBe(false);
});

test('arrow gesture: a note can point to a card, a card not to a card', () => {
    const view = part(vid).views[vid];
    const note = view.boxes.find(b => b.kind === 'note')!.id;
    const [a, b] = ['Animal Farm', 'George Orwell'].map(n => named(vid, n).element as string);
    const info = viewGesture(part(vid), view, { kind: 'arrow', source: note, boxes: [a, note] });
    expect(info.problems.boxes).toEqual({ [a]: '', [note]: 'An arrow connects two different elements.' });
    expect(viewGesture(part(vid), view, { kind: 'arrow', source: a, boxes: [b] }).problems.boxes![b]).toBe('An arrow starts or ends at a note.');
});

test('placementOfId gives the card placement of an element; other ids stay', () => {
    const card = named(vid, 'Animal Farm');
    expect(placementOfId(part(vid).views[vid], card.element as string)).toBe(card.id);
    expect(placementOfId(part(vid).views[vid], 'other')).toBe('other');
});

test('the patches of 201 steps undo to the start and redo to the end (the editor keeps each patch)', () => {
    const graph = store.graph, start = graph.quads().length, placement = named(vid, 'Animal Farm').id;
    const text = () => store.viewText('urn:name:Bookshop');
    const before = text(), patches = [];
    for (let i = 1; i <= 201; i++) {
        expect(store.execute({ kind: 'setBounds', view: vid, bounds: [{ id: placement, x: i * 10, y: 0, width: 450, height: 300 }] })).toMatchObject({ ok: true });
        patches.push(store.last!);
    }
    const after = text();
    for (const p of [...patches].reverse()) graph.undo(p);
    expect(text()).toBe(before);
    expect(graph.quads().length).toBe(start);
    for (const p of patches) graph.redo(p);
    expect(text()).toBe(after);
});
