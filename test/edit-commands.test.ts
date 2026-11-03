// Kata mydh. Oracle: executeCommand of src/edit/commands.ts over ViewQuads + Facts gives the same view quads and result as ViewStore.execute
// on the graph, for every case of store.test.ts and clipboard.test.ts. Then factsOf against the fork binary gives the facts of factsFromGraph.
import type { Quad } from '@rdfjs/types';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { copyFromView, VIEW_CLIP_FORMAT, type ViewClip, type ViewCommand } from '../src/catenary/model/commands';
import { placementOfId } from '../src/catenary/model/doc';
import { iriId } from '../src/catenary/model/ids';
import type { NTerm } from '../src/catenary/model/notation-graph';
import type { ShapeRow } from '../src/catenary/model/shapes-schema';
import { authoringMetamodel } from '../src/catenary/rdf/authoring';
import type { ModelGraph } from '../src/catenary/rdf/graph';
import { viewFiguresOf } from '../src/catenary/rdf/notations';
import { removeTree } from '../src/catenary/rdf/ops';
import { buildVocabulary, shapesTriples, vocabularyQuads } from '../src/catenary/rdf/shapes';
import { shapesIndexOf } from '../src/catenary/rdf/shapes-read';
import { rdf, tripleKey } from '../src/catenary/rdf/terms';
import { readView } from '../src/catenary/rdf/view-read';
import { V, views as viewGraphs } from '../src/catenary/rdf/views';
import { P } from '../src/catenary/rdf/vocabulary';
import { executeCommand, type Views } from '../src/edit/commands';
import type { Facts } from '../src/edit/facts';
import { commandIris, factsOf } from '../src/edit/facts-of';
import { ViewQuads } from '../src/edit/view-quads';
import { diagramOf } from '../src/model/diagram';
import { graphOf, graphPrefixes } from '../src/model/graph-input';
import { ViewStore } from './view-store';
import { modelFilesOf, viewFilesOf } from '../src/model/view-files';
import { manifestOf } from '../src/read/manifest';
import { shapesModelOf } from '../src/read/shapes';
import type { GraphParams } from '../src/node/turtle-api';
import { factsFromGraph } from './edit-facts';
import { FIXTURE, fixtureGraph } from './fixture-graph';
import { startServer } from './server';

// Mark IRIs take random bytes: the same sequence for the old and the new command gives the same IRIs.
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

const elements = (iri = view) => diagramOf(store.graph, iri).children!;
const cards = () => elements().filter(e => e.type === 'node:card');
const card = () => cards()[0].element as string;
const relation = () => elements().find(e => e.type === 'edge:relation')!.element as string;
const birthDateRow = () => elements(model).flatMap(e => e.children ?? [])
    .find(e => e.type === 'label:row' && (e as unknown as ShapeRow).parts.map(p => p.text).join('') === 'ex:birthDate')!;
const keys = (qs: Quad[]) => qs.map(tripleKey).sort();
const viewQuads = (g: ModelGraph, iri: string) => g.match(null, null, null, rdf.namedNode(iri));
function run(c: ViewCommand): unknown {
    const r = store.execute(c);
    expect(r, c.kind).toMatchObject({ ok: true });
    return r.ok ? r.value : undefined;
}
const note = () => run({ kind: 'createNote', view: vid, text: 'note', at }) as string;
const collection = () => run({ kind: 'collect', view: vid, ids: cards().slice(0, 2).map(c => c.element as string) }) as string;
const clip = (): ViewClip => ({ format: VIEW_CLIP_FORMAT, mode: 'copy', source: view, edges: [], boxes: [{
    kind: 'note', id: 'clipboard-note', text: 'pasted note', x: 0, y: 0, width: 300, height: 150
}] });
const clipOf = (iri: string, mode: 'copy' | 'cut') => {
    const doc = readView(store.graph, mid, shapesIndexOf(store.graph).model);
    return copyFromView(doc, mid, [placementOfId(doc.views[mid], iriId(iri))], mode)!;
};

/** The authoring metamodel of the graph, as ViewStore.execute computes it. */
function metaOf(g: ModelGraph) {
    const dataset = rdf.dataset([...shapesTriples(g), ...vocabularyQuads(g).map(q => rdf.quad(q.subject, q.predicate, q.object))]);
    return authoringMetamodel(g, buildVocabulary(dataset, g.language));
}

/**
 * The old viewFiguresOf over a copy of the graph whose view graphs are the present quads of `views`: the figures of a view as the old
 * pipeline reads them inside its transaction.
 */
function oracleFigures(g: ModelGraph, views: Views) {
    const mirror = graphOf(result, files).graph;
    mirror.update(() => {
        for (const q of mirror.quads()) mirror.remove(q);
        for (const q of g.quads()) mirror.add(q.subject, q.predicate, q.object, q.graph);
    });
    return (iri: string, also: NTerm[] = []) => {
        mirror.update(() => {
            for (const [v, quads] of Object.entries(views)) {
                mirror.removeMatches(null, null, null, rdf.namedNode(v));
                for (const q of quads.quads()) mirror.add(q.subject, q.predicate, q.object, rdf.namedNode(v));
            }
        });
        return viewFiguresOf(mirror, iri, also);
    };
}

/**
 * Runs the new executeCommand on the quads of `iris` with the facts of the graph and the old figures, then ViewStore.execute on the graph.
 * The results must be equal; after a success, the view quads of each view must be the same set. A failure changes nothing in the store;
 * the caller drops the views of a failed command. `byIri`: uncollect releases the members in IRI order (K8), the old one in store order: the
 * ids compare as sets and the positions are left out.
 */
function compare(c: ViewCommand, iris = [view, model], byIri = false): { views: Views; value: unknown } {
    const g = store.graph;
    graphPrefixes(g);
    const views: Views = Object.fromEntries(iris.map(i => [i, new ViewQuads(viewQuads(g, i), rdf.namedNode(i))]));
    const before = Object.fromEntries(iris.map(i => [i, keys(viewQuads(g, i))]));
    const facts = factsFromGraph(g), meta = metaOf(g), figures = oracleFigures(g, views);
    random.n = 0;
    const got = executeCommand(views, facts, figures, meta, c);
    random.n = 0;
    const want = store.execute(c);
    const sorted = (r: typeof got) => byIri && r.ok ? { ...r, value: [...r.value as string[]].sort() } : r;
    expect(sorted(got), c.kind).toEqual(sorted(want));
    const placed = (qs: Quad[]) => keys(byIri ? qs.filter(q => !q.predicate.equals(V.x) && !q.predicate.equals(V.y)) : qs);
    for (const i of iris) {
        if (want.ok) expect(placed(views[i].quads()), `${c.kind} ${i}`).toEqual(placed(viewQuads(g, i)));
        else expect(keys(viewQuads(g, i))).toEqual(before[i]);
    }
    if (want.ok && want.changed !== false) expect(iris.some(i => views[i].steps().length > 0), c.kind).toBe(true);
    return { views, value: got.ok ? got.value : undefined };
}

describe('executeCommand equals ViewStore.execute (store.test.ts, clipboard.test.ts)', () => {
    test('addToView', () => {
        const id = card(); run({ kind: 'removeFromView', view: vid, ids: [id] });
        compare({ kind: 'addToView', view, ids: [id], at });
    });
    test('showRelations', () => {
        const id = relation(); run({ kind: 'hideEdges', view: vid, ids: [id], hidden: true });
        compare({ kind: 'showRelations', view: vid, ids: [id], at });
    });
    test('showAsEdge', () => {
        const shape = elements(model).find(e => e.type === 'edge:property' && e.name === 'ex:stocks')!;
        run({ kind: 'removeFromView', view: mid, ids: [shape.id] });
        compare({ kind: 'showAsEdge', view: mid, id: shape.id, at });
    });
    test('showAsEdge of a datatype row places a Pill mark', () => {
        const { views } = compare({ kind: 'showAsEdge', view: mid, id: birthDateRow().id, at });
        expect(views[model].match(null, P.type, V.Pill)).toHaveLength(1);
    });
    test('showAsEdge of a datatype with hasValue targets its placed Pill', () => {
        const row = birthDateRow();
        const property = rdf.namedNode(shapesIndexOf(store.graph).model.properties[row.id].uri!);
        const graph = store.graph.match(property)[0].graph;
        store.graph.update(() => store.graph.add(property, rdf.namedNode('http://www.w3.org/ns/shacl#hasValue'), rdf.literal('2000-01-01'), graph));
        compare({ kind: 'showAsEdge', view: mid, id: row.id, at });
    });
    test.each(['line', 'pill'])('removeFromView of a datatype %s removes its mark and restores the row', end => {
        const row = birthDateRow();
        run({ kind: 'showAsEdge', view: mid, id: row.id, at });
        const edge = elements(model).find(e => e.id === row.id && e.type === 'edge:property')!;
        compare({ kind: 'removeFromView', view: mid, ids: [end === 'line' ? edge.id : edge.targetId as string] });
        expect(store.graph.match(null, P.type, V.Pill)).toHaveLength(0);
    });
    test('setBounds moves a datatype Pill without moving its card', () => {
        const row = birthDateRow();
        run({ kind: 'showAsEdge', view: mid, id: row.id, at });
        compare({ kind: 'setBounds', view: mid, bounds: [{ id: row.id + '_leaf', x: 700, y: 800 }] });
    });
    test('removeFromView', () => compare({ kind: 'removeFromView', view: vid, ids: [card()] }));
    test('setBounds', () => compare({ kind: 'setBounds', view: vid, bounds: [{ id: card(), ...at, width: 600 }] }));
    test('setLayout', () => compare({ kind: 'setLayout', view: vid, bounds: [{ id: card(), ...at }] }));
    test('setEdgeLayout', () => compare({ kind: 'setEdgeLayout', view: vid, relation: relation(), patch: { color: '#ff0000', vertices: [{ x: 12, y: 34 }] } }));
    test('setViewElements', () => compare({ kind: 'setViewElements', view: vid, ids: [card()], patch: { color: '#123456', display: 'simple' } }));
    test('hideEdges', () => compare({ kind: 'hideEdges', view: vid, ids: [relation()], hidden: true }));
    test('createGroup', () => compare({ kind: 'createGroup', view: vid, label: 'frame', around: [card()] }));
    test('createNote', () => compare({ kind: 'createNote', view: vid, text: 'new note', at }));
    test('createArrow', () => compare({ kind: 'createArrow', view: vid, from: note(), to: card() }));
    test('addViewReference', () => {
        for (const e of elements().filter(e => e.type === 'node:view-reference')) run({ kind: 'removeFromView', view: vid, ids: [e.id] });
        compare({ kind: 'addViewReference', view: vid, target: mid, at });
    });
    test('addFileReference', () => compare({ kind: 'addFileReference', view: vid, file: '../readme.md', at }));
    test('collect', () => compare({ kind: 'collect', view: vid, ids: cards().slice(0, 2).map(c => c.element as string) }));
    test('addToCollection', () => { const id = collection(); compare({ kind: 'addToCollection', view: vid, id, ids: [card()] }); });
    test('uncollect: the members in IRI order', () => {
        const { views, value } = compare({ kind: 'uncollect', view: vid, id: collection() }, [view, model], true);
        expect(value).toEqual([...value as string[]].sort());
        expect((value as string[]).length).toBe(2);
        expect(views[view].changes().added.some(q => q.predicate.equals(V.x))).toBe(true);
    });
    test('pasteIntoView', () => compare({ kind: 'pasteIntoView', view: vid, clip: clip(), at }));
    test('moveBetweenViews', () => {
        const id = note(), c = clip(); c.boxes[0].id = id; c.mode = 'cut';
        compare({ kind: 'moveBetweenViews', from: view, to: model, clip: c, at });
    });
    test('setViewElements edits note text', () => {
        compare({ kind: 'setViewElements', view: vid, ids: [note()], patch: { text: 'edited note' }, expectedText: 'note' });
    });
    test('skolem shape placement keeps the skolem IRI in the view graph', () => {
        const iri = 'urn:skolem:blank:doc:1', t = rdf.namedNode(iri), sg = store.graph.shapesGraphs()[0];
        store.graph.update(() => store.graph.add(t, P.type, rdf.namedNode('http://www.w3.org/ns/shacl#NodeShape'), sg));
        const { views } = compare({ kind: 'addToView', view: mid, ids: [iri], at });
        expect(views[model].match(null, V.element, t)).toHaveLength(1);
    });
    test('a failure after an earlier change gives the same error', () => {
        compare({ kind: 'setViewElements', view: vid, ids: [note(), 'missing'], patch: { text: 'changed' } });
    });
    test('a no-op changes nothing', () => {
        const { views } = compare({ kind: 'addToView', view: vid, ids: [card()], at });
        expect(views[view].steps()).toHaveLength(0);
    });
    test('the paste of a copied node shape card into another view (clipboard)', () => {
        compare({ kind: 'pasteIntoView', view: vid, clip: clipOf('urn:name:Author%20shape', 'copy'), at: { x: 0, y: 0 } });
    });
    test('the paste of a cut moves the card: two views change (clipboard)', () => {
        const c = clipOf('urn:name:Book%20shape', 'cut');
        const { views } = compare({ kind: 'moveBetweenViews', from: c.source, to: vid, clip: c, at: { x: 0, y: 0 } });
        expect(views[view].steps().length).toBeGreaterThan(0);
        expect(views[model].steps().length).toBeGreaterThan(0);
    });
    test('setBounds of an element that it places itself moves the bends of a line to it (figures after the add)', () => {
        const line = elements(model).find(e => e.type === 'edge:property' && e.name === 'ex:stocks')! as unknown as { id: string };
        run({ kind: 'setEdgeLayout', view: mid, relation: line.id, patch: { vertices: [{ x: 5, y: 6 }] } });
        const shop = elements(model).find(e => e.element === iriId('urn:name:Bookshop%20shape'))! as unknown as { element: string; position: { x: number; y: number } };
        // The card of Book shape loses its placement; the line placement and its bends stay.
        const book = rdf.namedNode('urn:name:Book%20shape'), g0 = rdf.namedNode(model);
        const placement = store.graph.match(null, V.element, book, g0)[0].subject;
        store.graph.update(() => removeTree(store.graph, placement, g0));
        const before = keys(viewQuads(store.graph, model).filter(q => q.predicate.equals(V.vertices)));
        compare({ kind: 'setBounds', view: mid, bounds: [{ id: shop.element, x: shop.position.x + 40, y: shop.position.y + 30 }, { id: iriId(book.value), x: 40, y: 30 }] }, [model]);
        expect(keys(viewQuads(store.graph, model).filter(q => q.predicate.equals(V.vertices)))).not.toEqual(before);
    });
});

/** The params of the recorded turtle/graph answer: the old pipeline reads the same answer from the server under test. */
const graphParams = () => (JSON.parse(readFileSync(join(FIXTURE, 'graph.json'), 'utf8')) as { params: GraphParams }).params;

describe('factsOf against the fork binary equals factsFromGraph on test/fixtures/shapes', () => {
    let server: Awaited<ReturnType<typeof startServer>>, graph: ModelGraph, ctx: Parameters<typeof factsOf>[0];
    beforeAll(async () => {
        server = await startServer(FIXTURE, 282);
        const port = server.port();
        const rdfFiles = readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(f => join(FIXTURE, f));
        const viewFiles = await viewFilesOf(port, rdfFiles.filter(f => f.endsWith('.trig')));
        const modelFiles = modelFilesOf(rdfFiles, viewFiles), manifest = await manifestOf(port, modelFiles);
        ctx = { port, modelFiles, manifest, shapes: await shapesModelOf(port, modelFiles, manifest) };
        graph = graphOf(await server.graph(graphParams()), [...viewFiles.views.values()]).graph;
    }, 20000);
    afterAll(async () => { await server?.stop(); });

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

    const commands = (): ViewCommand[] => {
        const g = graph, doc = readView(g, mid, shapesIndexOf(g).model), d = diagramOf(g, view).children!, dm = diagramOf(g, model).children!;
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

    test('the 19 command kinds are covered', () => {
        expect(new Set(commands().map(c => c.kind)).size).toBe(19);
    });

    test.each(Array.from({ length: 19 }, (_, i) => i))('command %i: factsOf gives the facts of factsFromGraph for its IRIs', async i => {
        graphPrefixes(graph);
        const c = commands()[i];
        const views: Views = Object.fromEntries(viewGraphs(graph).map(v => [v.value, new ViewQuads(viewQuads(graph, v.value), v)]));
        const iris = commandIris(ctx.shapes, c, views);
        expect(iris.length).toBeGreaterThan(0);
        const doc = ['collect', 'pasteIntoView', 'moveBetweenViews'].includes(c.kind);
        const got = await factsOf(ctx, c, views);
        expect(facts(got, iris, doc), c.kind).toEqual(facts(factsFromGraph(graph), iris, doc));
    });
});
