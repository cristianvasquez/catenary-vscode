// The reads and the steps that the canvas edits use (kata embt): halo expand choices, gesture answers, placements, view commands.
// The choices come from turtle/query (fork binary over stdio, kata dxwx); a command edits the text of the view document, which reaches the server.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import type { ViewCommand } from '../src/catenary/model/commands';
import { placementOfId } from '../src/catenary/model/doc';
import { iriId } from '../src/catenary/model/ids';
import { viewGesture } from '../src/catenary/model/view-ui';
import { expandChoices } from '../src/read/choices';
import { diagramOf, type ModelContext, modelContextOf } from '../src/read/diagram';
import { hiddenNeighborCounts } from '../src/read/neighbors';
import { FIXTURE, startServer } from './server';
import { type ViewDocuments, viewDocuments } from './views';

/** Triples of the six fixture documents (port.test.ts). */
const TRIPLES = 282;
const view = 'urn:name:Bookshop', vid = iriId(view), mid = iriId('urn:name:Bookshop%20model');
let server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext, docs: ViewDocuments;
beforeAll(async () => {
    server = await startServer(FIXTURE, TRIPLES);
    ctx = (await modelContextOf(server.port(), readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(f => join(FIXTURE, f)))).ctx;
    docs = viewDocuments(server, () => ctx, { [view]: join(FIXTURE, 'instances.trig'), 'urn:name:Bookshop%20model': join(FIXTURE, 'model.trig') });
}, 20000);
afterAll(async () => { await server?.stop(); });
beforeEach(() => docs.reset());
const named = async (v: string, name: string) => (await diagramOf(ctx, v)).schema.children!.find(e => e.name === name)!;
const part = async (v: string) => (await diagramOf(ctx, v)).doc;
const execute = (c: ViewCommand) => docs.run(c, [view]);

test('expand in of an instance card lists its hidden neighbour', async () => {
    const from = (await named(vid, 'Tangamandapio')).element as string;
    const choices = await expandChoices(ctx, vid, docs.text(view), from, 'in');
    expect(choices?.items.map(i => i.label)).toEqual(['Cities']);
    expect(await expandChoices(ctx, vid, docs.text(view), from, 'out')).toBeUndefined();
});

test('expand targets of a node shape card lists the instances it checks', async () => {
    const choices = await expandChoices(ctx, mid, docs.text('urn:name:Bookshop%20model'), (await named(mid, 'Book shape')).element as string, 'targets');
    expect(choices?.items.map(i => i.label).sort()).toEqual(['Alice’s Adventures in Wonderland', 'Animal Farm', 'Nineteen Eighty-Four']);
});

test('showRelations of an expand choice places the neighbour: one edit', async () => {
    const from = (await named(vid, 'Tangamandapio')).element as string;
    const ids = (await expandChoices(ctx, vid, docs.text(view), from, 'in'))!.items[0].ids;
    const r = await execute({ kind: 'showRelations', view: vid, ids, at: { x: 0, y: 0 } });
    expect(r).toMatchObject({ ok: true });
    expect(r.edits).toHaveLength(1);
    expect(await named(vid, 'Cities')).toBeDefined();
    expect(await expandChoices(ctx, vid, docs.text(view), from, 'in')).toBeUndefined();
});

test.each(['in', 'out'] as const)('restore a deleted relation from its %s end without changing cards', async dir => {
    const doc = await part(vid), before = doc.views[vid], orwell = (await named(vid, 'George Orwell')).element;
    const relation = Object.values(doc.relations).find(r => r.object === orwell && before.edges.some(e => e.relation === r.id))!;
    expect(relation).toBeDefined();
    expect(await execute({ kind: 'removeFromView', view: vid, ids: [before.edges.find(e => e.relation === relation.id)!.id!] })).toMatchObject({ ok: true });
    expect((await part(vid)).views[vid].edges.filter(e => !e.hidden)).toHaveLength(before.edges.filter(e => !e.hidden).length - 1);
    const from = dir === 'out' ? relation.subject : relation.object;
    const other = dir === 'out' ? relation.object : relation.subject;
    const choices = (await expandChoices(ctx, vid, docs.text(view), from, dir))!;
    const item = choices.items.find(i => i.ids.includes(relation.id))!;
    const removed = await part(vid);
    expect(item.label).toBe(removed.instances[other].label);
    expect(item.description).toMatch(/ \(in the view\)$/);
    expect(choices.title).toContain(`(${choices.items.length} hidden)`);
    const v = removed.views[vid];
    const counts = await hiddenNeighborCounts(ctx.port, ctx.modelFiles, ctx.shapes, v);
    expect(counts.get(from)?.[dir]).toBe(choices.items.length);
    expect(await execute({ kind: 'showRelations', view: vid, ids: item.ids, at: { x: -1000, y: -1000 } })).toMatchObject({ ok: true });
    const after = (await part(vid)).views[vid];
    expect(after.edges.filter(e => !e.hidden)).toHaveLength(v.edges.filter(e => !e.hidden).length + 1);
    expect(after.boxes).toEqual(before.boxes);
    expect((await expandChoices(ctx, vid, docs.text(view), from, dir))?.items.some(i => i.ids.includes(relation.id)) ?? false).toBe(false);
});

test('arrow gesture: a note can point to a card, a card not to a card', async () => {
    const doc = await part(vid), v = doc.views[vid];
    const note = v.boxes.find(b => b.kind === 'note')!.id;
    const [a, b] = await Promise.all(['Animal Farm', 'George Orwell'].map(async n => (await named(vid, n)).element as string));
    const info = viewGesture(doc, v, { kind: 'arrow', source: note, boxes: [a, note] });
    expect(info.problems.boxes).toEqual({ [a]: '', [note]: 'An arrow connects two different elements.' });
    expect(viewGesture(doc, v, { kind: 'arrow', source: a, boxes: [b] }).problems.boxes![b]).toBe('An arrow starts or ends at a note.');
});

test('placementOfId gives the card placement of an element; other ids stay', async () => {
    const card = await named(vid, 'Animal Farm'), v = (await part(vid)).views[vid];
    expect(placementOfId(v, card.element as string)).toBe(card.id);
    expect(placementOfId(v, 'other')).toBe('other');
});
