// Kata mydh. executeCommand of src/edit/commands.ts through runCommand (turtle/query, fork binary over stdio) gives the view changes and the
// results that ViewStore.execute of the old pipeline gave, for every case of the old store.test.ts and clipboard.test.ts; factsOf gives the
// facts of the old graph. The old values were recorded before K11 deleted the old pipeline: test/fixtures/expected/edit-commands.json.
import type { Quad } from '@rdfjs/types';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { copyFromView, VIEW_CLIP_FORMAT, type ViewClip, type ViewCommand } from '../src/catenary/model/commands';
import { placementOfId } from '../src/catenary/model/doc';
import { idIri, iriId } from '../src/catenary/model/ids';
import type { ShapeRow } from '../src/catenary/model/shapes-schema';
import type { Views } from '../src/edit/commands';
import { runCommand, type CommandRun } from '../src/edit/executor';
import type { Facts } from '../src/edit/facts';
import { commandIris, factsOf, viewSubjects } from '../src/edit/facts-of';
import { removeTree } from '../src/edit/ops';
import { P, rdf, tripleKey, V } from '../src/edit/terms';
import { viewText } from '../src/edit/view-quads';
import { diagramOf, type ModelContext, modelContextOf } from '../src/read/diagram';
import { prefetchFigures, type KeptPrefetch } from '../src/read/figures';
import { changeOf, recorded } from './expected';
import { FIXTURE, startServer } from './server';
import { type ViewDocuments, viewDocuments } from './views';

// Mark IRIs take random bytes: each test starts the same sequence, as the recording did.
const random = vi.hoisted(() => ({ n: 0 }));
vi.mock('crypto', async importOriginal => {
    const actual = await importOriginal<typeof import('crypto')>();
    const randomBytes = (size: number) => { const n = random.n++; return Buffer.from(Array.from({ length: size }, (_, i) => (n * 37 + i * 11) & 255)); };
    return { ...actual, default: { ...actual, randomBytes }, randomBytes };
});

const R = recorded('edit-commands');
const cases = new Map<string, number>();
const view = 'urn:name:Bookshop', model = 'urn:name:Bookshop%20model';
const vid = iriId(view), mid = iriId(model);
const at = { x: 1200, y: 1300 };
const SHAPES = join(FIXTURE, 'shapes.ttl'), shapesText = readFileSync(SHAPES, 'utf8');
const documents = () => readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(f => join(FIXTURE, f));
let server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext, docs: ViewDocuments, shapesChanged = false;
beforeAll(async () => {
    server = await startServer(FIXTURE, 282);
    ctx = (await modelContextOf(server.port(), documents())).ctx;
    docs = viewDocuments(server, () => ctx, { [view]: join(FIXTURE, 'instances.trig'), [model]: join(FIXTURE, 'model.trig') });
    server.open(pathToFileURL(SHAPES).href, shapesText);
}, 20000);
afterAll(async () => { await server?.stop(); });
beforeEach(async () => {
    docs.reset();
    if (shapesChanged) {
        server.change(pathToFileURL(SHAPES).href, shapesText);
        ctx = (await modelContextOf(server.port(), documents())).ctx;
        shapesChanged = false;
    }
    random.n = 0;
});

/** A change of the shapes file (open buffer): the model context is read again. */
async function addToShapes(text: string) {
    server.change(pathToFileURL(SHAPES).href, `${shapesText}\n${text}\n`);
    shapesChanged = true;
    ctx = (await modelContextOf(server.port(), documents())).ctx;
}

const elements = async (iri = view) => (await diagramOf(ctx, iri)).schema.children!;
const cards = async () => (await elements()).filter(e => e.type === 'node:card');
const card = async () => (await cards())[0].element as string;
const relation = async () => (await elements()).find(e => e.type === 'edge:relation')!.element as string;
const birthDateRow = async () => (await elements(model)).flatMap(e => e.children ?? [])
    .find(e => e.type === 'label:row' && (e as unknown as ShapeRow).parts.map(p => p.text).join('') === 'ex:birthDate')!;
const iriOf = (v: string) => v.includes(':') ? v : idIri(v)!;
/** The views that a command edits: its view; for a paste of a cut, the source and the target. */
const viewsOf = (c: ViewCommand) => c.kind === 'moveBetweenViews' ? [iriOf(c.from), iriOf(c.to)] : [iriOf(c.view)];
async function run(c: ViewCommand): Promise<unknown> {
    const r = await docs.run(c, viewsOf(c));
    expect(r, c.kind).toMatchObject({ ok: true });
    return r.ok ? r.value : undefined;
}
const note = async () => await run({ kind: 'createNote', view: vid, text: 'note', at }) as string;
const collection = async () => await run({ kind: 'collect', view: vid, ids: (await cards()).slice(0, 2).map(c => c.element as string) }) as string;
const clip = (): ViewClip => ({ format: VIEW_CLIP_FORMAT, mode: 'copy', source: view, edges: [], boxes: [{
    kind: 'note', id: 'clipboard-note', text: 'pasted note', x: 0, y: 0, width: 300, height: 150
}] });
const clipOf = async (iri: string, mode: 'copy' | 'cut') => {
    const doc = (await diagramOf(ctx, mid)).doc;
    return copyFromView(doc, mid, [placementOfId(doc.views[mid], iriId(iri))], mode)!;
};
const keys = (qs: Quad[]) => qs.map(tripleKey).sort();
const isX = (k: string) => [V.x, V.y].some(t => k.split(' ')[1] === `<${t.value}>`);

/**
 * Runs `c` through runCommand on its views and compares the result and the change of each of `iris` with the recorded ViewStore.execute
 * (keys of the statements added and removed). `byIri`: uncollect releases the members in IRI order (K8), the old one in store order: the ids
 * compare as sets and the positions are left out. Gives the run and the keys of each view after it.
 */
async function compare(c: ViewCommand, iris = [view, model], byIri = false): Promise<{ run: CommandRun; after: Record<string, string[]> }> {
    const before = Object.fromEntries(await Promise.all(iris.map(async i => [i, await docs.keys(i)] as const)));
    random.n = 0;
    const r = await docs.run(c, viewsOf(c));
    const after = Object.fromEntries(await Promise.all(iris.map(async i => [i, await docs.keys(i)] as const)));
    const { edits, kept: _kept, ...result } = r;
    const sorted = byIri && result.ok ? { ...result, value: [...result.value as string[]].sort() } : result;
    const placed = (ks: string[]) => byIri ? ks.filter(k => !isX(k)) : ks;
    const name = expect.getState().currentTestName!.split(" > ").at(-1)!, n = cases.get(name) ?? 0;
    cases.set(name, n + 1);
    const want = R(`${name} ${n}`) as { command: unknown; want: unknown; views: Record<string, ReturnType<typeof changeOf>> };
    expect(JSON.parse(JSON.stringify(c)), 'command').toEqual(want.command);
    expect(JSON.parse(JSON.stringify(sorted)), c.kind).toEqual(want.want);
    for (const i of iris) expect(changeOf(placed(before[i]), placed(after[i])), `${c.kind} ${i}`).toEqual(want.views[i]);
    if (!r.ok) expect(edits).toEqual([]);
    return { run: r, after };
}

test('after a full draw a view-only command sends no request, a model command at most the reads of its new IRIs (kata 5p5s)', async () => {
    const fresh = ['urn:name:FreshBook', 'urn:name:FreshBook2', 'urn:name:FreshBook3'];
    await addToShapes(fresh.map(f => `<${f}> a <urn:name:Book> .`).join('\n'));
    const select = vi.fn(ctx.port.select.bind(ctx.port)), construct = vi.fn(ctx.port.construct.bind(ctx.port)), ask = vi.fn(ctx.port.ask.bind(ctx.port));
    const counting = { ...ctx, port: { select, construct, ask } };
    const kept = new Map<string, KeptPrefetch>();
    for (const v of [view, model]) {
        const drawn = await diagramOf(counting, v);
        expect(drawn.kept).toBeDefined();
        kept.set(v, drawn.kept!);
    }
    const ids = (await diagramOf(ctx, view)).schema.children!.filter(e => e.type === 'node:card').slice(0, 2).map(e => e.element as string);
    expect(ids).toHaveLength(2);
    const stocks = (await diagramOf(ctx, model)).schema.children!.find(e => e.type === 'edge:property' && e.name === 'ex:stocks')!.id;
    const card = (iri: string, x: number) => ({ kind: 'card' as const, id: iri, element: iri, x, y: 0, width: 300, height: 150 });
    const paste: ViewClip = { format: VIEW_CLIP_FORMAT, mode: 'copy', source: model, edges: [], boxes: [card(fresh[1], 0), card(fresh[2], 400)] };
    const counts: Record<string, number> = {};
    const commands: [ViewCommand, number][] = [
        [{ kind: 'collect', view: vid, ids }, 0],
        [{ kind: 'setBounds', view: vid, bounds: [{ id: ids[0], ...at }] }, 0],
        [{ kind: 'createNote', view: vid, text: 'no model read', at }, 0],
        [{ kind: 'addToView', view: vid, ids: [iriId(fresh[0])], at }, 2],
        [{ kind: 'pasteIntoView', view: vid, clip: paste, at }, 2],
        [{ kind: 'removeFromView', view: mid, ids: [stocks] }, 0],
        [{ kind: 'showAsEdge', view: mid, id: stocks, at }, 1]
    ];
    for (const [command, most] of commands) {
        select.mockClear(); construct.mockClear(); ask.mockClear();
        const v = iriOf((command as { view: string }).view);
        const r = await runCommand(counting, [{ iri: v, uri: pathToFileURL(join(FIXTURE, v === view ? 'instances.trig' : 'model.trig')).href, text: docs.text(v) }], command, undefined, kept);
        counts[command.kind] = select.mock.calls.length + construct.mock.calls.length + ask.mock.calls.length;
        expect(r.ok, command.kind).toBe(true);
        expect(r.edits.length, command.kind).toBe(1);
        expect(counts[command.kind], command.kind).toBeLessThanOrEqual(most);
        for (const [k, state] of r.kept!) kept.set(k, state);
        for (const edit of r.edits) docs.set(v, edit.text);
    }
    for (const f of fresh) expect((await docs.keys(view)).some(k => k.endsWith(` <${V.element.value}> <${f}>`)), f).toBe(true);
    console.info('command request counts', counts);
});

describe('executeCommand through runCommand equals the recorded ViewStore.execute (store.test.ts, clipboard.test.ts)', () => {
    test('addToView', async () => {
        const id = await card(); await run({ kind: 'removeFromView', view: vid, ids: [id] });
        await compare({ kind: 'addToView', view, ids: [id], at });
    });
    test('showRelations', async () => {
        const id = await relation(); await run({ kind: 'hideEdges', view: vid, ids: [id], hidden: true });
        await compare({ kind: 'showRelations', view: vid, ids: [id], at });
    });
    test('showAsEdge', async () => {
        const shape = (await elements(model)).find(e => e.type === 'edge:property' && e.name === 'ex:stocks')!;
        await run({ kind: 'removeFromView', view: mid, ids: [shape.id] });
        await compare({ kind: 'showAsEdge', view: mid, id: shape.id, at });
    });
    const pills = (keys: string[]) => keys.filter(k => k.endsWith(` <${P.type.value}> <${V.Pill.value}>`));
    test('showAsEdge of a datatype row places a Pill mark', async () => {
        const { after } = await compare({ kind: 'showAsEdge', view: mid, id: (await birthDateRow()).id, at });
        expect(pills(after[model])).toHaveLength(1);
    });
    test('showAsEdge of a datatype with hasValue targets its placed Pill', async () => {
        const row = await birthDateRow();
        await addToShapes(`<${ctx.shapes.index.model.properties[row.id].uri}> <http://www.w3.org/ns/shacl#hasValue> "2000-01-01" .`);
        await compare({ kind: 'showAsEdge', view: mid, id: row.id, at });
    });
    test.each(['line', 'pill'])('removeFromView of a datatype %s removes its mark and restores the row', async end => {
        const row = await birthDateRow();
        await run({ kind: 'showAsEdge', view: mid, id: row.id, at });
        const edge = (await elements(model)).find(e => e.id === row.id && e.type === 'edge:property')!;
        const { after } = await compare({ kind: 'removeFromView', view: mid, ids: [end === 'line' ? edge.id : edge.targetId as string] });
        expect(pills(after[model])).toHaveLength(0);
    });
    test('setBounds moves a datatype Pill without moving its card', async () => {
        const row = await birthDateRow();
        await run({ kind: 'showAsEdge', view: mid, id: row.id, at });
        await compare({ kind: 'setBounds', view: mid, bounds: [{ id: row.id + '_leaf', x: 700, y: 800 }] });
    });
    test('removeFromView', async () => { await compare({ kind: 'removeFromView', view: vid, ids: [await card()] }); });
    test('setBounds', async () => { await compare({ kind: 'setBounds', view: vid, bounds: [{ id: await card(), ...at, width: 600 }] }); });
    test('setLayout', async () => { await compare({ kind: 'setLayout', view: vid, bounds: [{ id: await card(), ...at }] }); });
    test('setEdgeLayout', async () => { await compare({ kind: 'setEdgeLayout', view: vid, relation: await relation(), patch: { color: '#ff0000', vertices: [{ x: 12, y: 34 }] } }); });
    test('setViewElements', async () => { await compare({ kind: 'setViewElements', view: vid, ids: [await card()], patch: { color: '#123456', display: 'simple' } }); });
    test('hideEdges', async () => { await compare({ kind: 'hideEdges', view: vid, ids: [await relation()], hidden: true }); });
    test('createGroup', async () => { await compare({ kind: 'createGroup', view: vid, label: 'frame', around: [await card()] }); });
    test('createNote', async () => { await compare({ kind: 'createNote', view: vid, text: 'new note', at }); });
    test('createArrow', async () => { await compare({ kind: 'createArrow', view: vid, from: await note(), to: await card() }); });
    test('addViewReference', async () => {
        for (const e of (await elements()).filter(e => e.type === 'node:view-reference')) await run({ kind: 'removeFromView', view: vid, ids: [e.id] });
        await compare({ kind: 'addViewReference', view: vid, target: mid, at });
    });
    test('addFileReference', async () => { await compare({ kind: 'addFileReference', view: vid, file: '../readme.md', at }); });
    test('collect', async () => { await compare({ kind: 'collect', view: vid, ids: (await cards()).slice(0, 2).map(c => c.element as string) }); });
    test('addToCollection', async () => { const id = await collection(); await compare({ kind: 'addToCollection', view: vid, id, ids: [await card()] }); });
    test('uncollect: the members in IRI order', async () => {
        const { run: r, after } = await compare({ kind: 'uncollect', view: vid, id: await collection() }, [view, model], true);
        const value = (r as { value: string[] }).value;
        expect(value).toEqual([...value].sort());
        expect(value.length).toBe(2);
        expect(after[view].some(isX)).toBe(true);
    });
    test('pasteIntoView', async () => { await compare({ kind: 'pasteIntoView', view: vid, clip: clip(), at }); });
    test('moveBetweenViews', async () => {
        const id = await note(), c = clip(); c.boxes[0].id = id; c.mode = 'cut';
        await compare({ kind: 'moveBetweenViews', from: view, to: model, clip: c, at });
    });
    test('setViewElements edits note text', async () => {
        await compare({ kind: 'setViewElements', view: vid, ids: [await note()], patch: { text: 'edited note' }, expectedText: 'note' });
    });
    test('a placed blank-node shape is refused', async () => {
        await addToShapes('[] a <http://www.w3.org/ns/shacl#NodeShape> ; <http://www.w3.org/2000/01/rdf-schema#label> "anonymous shape" .');
        const [row] = await server.port().select('SELECT ?s WHERE { ?s <http://www.w3.org/2000/01/rdf-schema#label> "anonymous shape" }', [SHAPES]);
        const iri = row.s.value;
        expect(iri).toMatch(/^urn:skolem:blank:/);
        expect(await docs.run({ kind: 'addToView', view: mid, ids: [iri], at }, [model])).toMatchObject({
            ok: false, error: expect.stringContaining(iri), edits: []
        });
        expect((await docs.keys(model)).filter(k => k.endsWith(` <${V.element.value}> <${iri}>`))).toHaveLength(0);
    });
    test('a failure after an earlier change gives the same error', async () => {
        await compare({ kind: 'setViewElements', view: vid, ids: [await note(), 'missing'], patch: { text: 'changed' } });
    });
    test('a no-op changes nothing', async () => {
        const { run: r } = await compare({ kind: 'addToView', view: vid, ids: [await card()], at });
        expect(r.edits).toHaveLength(0);
    });
    test('the paste of a copied node shape card into another view (clipboard)', async () => {
        await compare({ kind: 'pasteIntoView', view: vid, clip: await clipOf('urn:name:Author%20shape', 'copy'), at: { x: 0, y: 0 } });
    });
    test('the paste of a cut moves the card: two views change (clipboard)', async () => {
        const c = await clipOf('urn:name:Book%20shape', 'cut');
        const { run: r } = await compare({ kind: 'moveBetweenViews', from: c.source, to: vid, clip: c, at: { x: 0, y: 0 } });
        expect(r.edits).toHaveLength(2);
    });
    test('setBounds of an element that it places itself moves the bends of a line to it (figures after the add)', async () => {
        const line = (await elements(model)).find(e => e.type === 'edge:property' && e.name === 'ex:stocks')! as unknown as { id: string };
        await run({ kind: 'setEdgeLayout', view: mid, relation: line.id, patch: { vertices: [{ x: 5, y: 6 }] } });
        const shop = (await elements(model)).find(e => e.element === iriId('urn:name:Bookshop%20shape'))! as unknown as { element: string; position: { x: number; y: number } };
        // The card of Book shape loses its placement; the line placement and its bends stay.
        const book = rdf.namedNode('urn:name:Book%20shape'), quads = await docs.quads(model);
        const facts = await factsOf(ctx, { kind: 'removeFromView', view: mid, ids: [iriId(book.value)] }, { [model]: quads });
        removeTree(quads, facts, quads.match(null, V.element, book)[0].subject);
        docs.set(model, viewText(quads));
        const bends = async () => (await docs.keys(model)).filter(k => k.split(' ')[1] === `<${V.vertices.value}>`);
        const before = await bends();
        await compare({ kind: 'setBounds', view: mid, bounds: [{ id: shop.element, x: shop.position.x + 40, y: shop.position.y + 30 }, { id: iriId(book.value), x: 40, y: 30 }] }, [model]);
        expect(await bends()).not.toEqual(before);
    });
});

describe('factsOf against the fork binary equals the recorded facts of the old graph on test/fixtures/shapes', () => {
    /** The facts that a command uses, for each IRI that the prefetch asks about. */
    function facts(f: Facts, iris: string[], doc: boolean) {
        return {
            language: f.language,
            among: keys(f.statementsAmong(iris)),
            vocabulary: doc ? keys(f.vocabularyStatements()) : [],
            each: iris.map(i => ({
                i, instance: f.isInstance(i), label: f.label(i), view: f.isView(i), viewLabel: f.isView(i) ? f.viewLabel(i) : '',
                card: f.shapesCard(iriId(i))?.value, statements: keys(f.statementsOf([i])),
                has: f.statementsOf([i]).filter(q => q.object.termType === 'NamedNode').map(q => f.has(q.subject.value, q.predicate.value, q.object.value)),
                shapes: keys(f.shapesMatch(i, null))
            }))
        };
    }

    const commands = async (): Promise<ViewCommand[]> => {
        const doc = (await diagramOf(ctx, mid)).doc, d = await elements(view), dm = await elements(model);
        const ids = d.filter(e => e.type === 'node:card').map(e => e.element as string), rel = d.find(e => e.type === 'edge:relation')!.element as string;
        const line = dm.find(e => e.type === 'edge:property')!.id, cut = copyFromView(doc, mid, [placementOfId(doc.views[mid], iriId('urn:name:Book%20shape'))], 'cut')!;
        return [
            { kind: 'addToView', view, ids: [ids[0]], at }, { kind: 'showRelations', view: vid, ids: [rel], at }, { kind: 'showAsEdge', view: mid, id: line, at },
            { kind: 'removeFromView', view: vid, ids: [ids[0]] }, { kind: 'setBounds', view: vid, bounds: [{ id: ids[0], ...at }] },
            { kind: 'setLayout', view: vid, bounds: [{ id: ids[1], ...at }] }, { kind: 'setEdgeLayout', view: vid, relation: rel, patch: { color: '#ff0000' } },
            { kind: 'hideEdges', view: vid, ids: [rel], hidden: true }, { kind: 'setViewElements', view: vid, ids: [ids[0]], patch: { color: '#123456' } },
            { kind: 'createGroup', view: vid, label: 'frame', around: [ids[0]] }, { kind: 'createNote', view: vid, text: 'n', at },
            { kind: 'addViewReference', view: vid, target: mid, at }, { kind: 'addFileReference', view: vid, file: '../readme.md', at },
            { kind: 'createArrow', view: vid, from: ids[0], to: ids[1] }, { kind: 'collect', view: vid, ids: ids.slice(0, 2) },
            { kind: 'addToCollection', view: vid, id: 'n-none', ids: [ids[2]] }, { kind: 'uncollect', view: vid, id: 'n-none' },
            { kind: 'pasteIntoView', view: vid, clip: copyFromView(doc, mid, [placementOfId(doc.views[mid], iriId('urn:name:Author%20shape'))], 'copy')!, at },
            { kind: 'moveBetweenViews', from: cut.source, to: vid, clip: cut, at }
        ];
    };

    test('a statement of a shape subject in a shapes document and in a model document is a model statement (roborev 2344)', async () => {
        const DATA = join(FIXTURE, 'data.ttl'), dataText = readFileSync(DATA, 'utf8'), iri = 'urn:name:Author%20shape';
        const label = `<${iri}> <http://www.w3.org/2000/01/rdf-schema#label> "Duplicated" .`;
        server.open(pathToFileURL(DATA).href, dataText);
        server.change(pathToFileURL(DATA).href, `${dataText}\n<${iri}> a <urn:example:bookshop:Author> .\n${label}\n`);
        try {
            await addToShapes(label);
            const views: Views = { [view]: await docs.quads(view) };
            const command: ViewCommand = { kind: 'addToView', view: vid, ids: [iriId(iri)], at };
            const answer = (await prefetchFigures(ctx.port, view, join(FIXTURE, 'instances.trig'), ctx.shapes, ctx.modelFiles, [], undefined, [iri])).kept;
            for (const answers of [new Map(), new Map([[view, answer]])]) {
                const f = await factsOf(ctx, command, views, answers);
                expect(f.isInstance(iri)).toBe(true);
                expect(f.label(iri)).toBe('Duplicated');
            }
        } finally {
            server.change(pathToFileURL(DATA).href, dataText);
        }
    });

    test('the 19 command kinds are covered', async () => {
        expect(new Set((await commands()).map(c => c.kind)).size).toBe(19);
    });

    test.each(Array.from({ length: 19 }, (_, i) => i))('command %i: model facts match the recording, or view-only facts need no query', async i => {
        const c = (await commands())[i];
        const views: Views = Object.fromEntries(await Promise.all([view, model].map(async v => [v, await docs.quads(v)] as const)));
        const iris = commandIris(ctx.shapes, c, views);
        const doc = ['pasteIntoView', 'moveBetweenViews'].includes(c.kind);
        const select = vi.fn(ctx.port.select.bind(ctx.port));
        const got = await factsOf({ ...ctx, port: { ...ctx.port, select } }, c, views);
        if (!['addToView', 'pasteIntoView', 'moveBetweenViews', 'showAsEdge', 'showRelations'].includes(c.kind)) {
            expect(iris).toEqual([]);
            expect(select).not.toHaveBeenCalled();
            expect(got.isView(view)).toBe(true);
            expect(got.viewLabel(view)).toBe('Bookshop');
            return;
        }
        expect(iris.length).toBeGreaterThan(0);
        const want = R(`facts ${i}`) as { command: unknown; iris: string[]; facts: unknown };
        expect(JSON.parse(JSON.stringify(c))).toEqual(want.command);
        // The IRIs come in the order of the view statements: the server and the old store give them in another order.
        expect([...iris].sort()).toEqual([...want.iris].sort());
        expect(JSON.parse(JSON.stringify(facts(got, want.iris, doc))), c.kind).toEqual(want.facts);
        // Without kept answers: one query for the named IRIs, one for the shape subjects in the documents where they are not shapes.
        expect(select.mock.calls.length).toBe(iris.some(x => ctx.shapes.shapeSubjects.has(`<${x}>`)) ? 2 : 1);
    });

    test.each(Array.from({ length: 19 }, (_, i) => i))('command %i: the facts from the kept answers of the views match the recording without a query', async i => {
        const c = (await commands())[i];
        const views: Views = Object.fromEntries(await Promise.all([view, model].map(async v => [v, await docs.quads(v)] as const)));
        const iris = commandIris(ctx.shapes, c, views), noModel = viewSubjects(ctx, views, iris);
        const files: Record<string, string> = { [view]: join(FIXTURE, 'instances.trig'), [model]: join(FIXTURE, 'model.trig') };
        const answers = new Map(await Promise.all([view, model].map(async (v, n) =>
            [v, (await prefetchFigures(ctx.port, v, files[v], ctx.shapes, ctx.modelFiles, [], undefined, n ? [] : iris.filter(x => !noModel.has(x)))).kept] as const)));
        const select = vi.fn(ctx.port.select.bind(ctx.port));
        const got = await factsOf({ ...ctx, port: { ...ctx.port, select } }, c, views, answers);
        // A shape subject is read by document kind: one query (the fixture has one shapes document).
        expect(select.mock.calls.length).toBe(iris.some(x => ctx.shapes.shapeSubjects.has(`<${x}>`)) ? 1 : 0);
        if (!iris.length) return;
        const want = R(`facts ${i}`) as { iris: string[]; facts: unknown };
        expect(JSON.parse(JSON.stringify(facts(got, want.iris, ['pasteIntoView', 'moveBetweenViews'].includes(c.kind)))), c.kind).toEqual(want.facts);
    });
});
