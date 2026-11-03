import type { Quad } from '@rdfjs/types';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import type { ViewCommand, ViewClip } from '../src/catenary/model/commands';
import { VIEW_CLIP_FORMAT } from '../src/catenary/model/commands';
import { iriId } from '../src/catenary/model/ids';
import type { ShapeRow } from '../src/catenary/model/shapes-schema';
import { parseRdfSync } from '../src/catenary/rdf-files/oxigraph-store';
import { shapesIndexOf } from '../src/catenary/rdf/shapes-read';
import { rdf, termKey } from '../src/catenary/rdf/terms';
import { V } from '../src/catenary/rdf/views';
import { P } from '../src/catenary/rdf/vocabulary';
import { diagramOf } from '../src/model/diagram';
import { graphOf } from '../src/model/graph-input';
import { ViewStore } from '../src/model/store';
import type { GraphResult } from '../src/node/turtle-api';
import { fixtureGraph } from './fixture-graph';

const result = fixtureGraph();
const files = ['instances', 'model'].map(f => resolve(`test/fixtures/shapes/${f}.trig`));
const view = 'urn:name:Bookshop', model = 'urn:name:Bookshop%20model';
const vid = iriId(view), mid = iriId(model);
const at = { x: 1200, y: 1300 };
let store: ViewStore;
beforeEach(() => { store = new ViewStore(graphOf(result, files).graph); });
const elements = () => diagramOf(store.graph, view).children!;
const cards = () => elements().filter(e => e.type === 'node:card');
const card = () => cards()[0].element as string;
const relation = () => elements().find(e => e.type === 'edge:relation')!.element as string;
const quads = () => store.graph.quads();
const birthDateRow = () => diagramOf(store.graph, model).children!.flatMap(e => e.children ?? [])
    .find(e => e.type === 'label:row' && (e as unknown as ShapeRow).parts.map(p => p.text).join('') === 'ex:birthDate')!;
const canonical = (qs: Quad[]) => qs.map(q => `${termKey(q.subject)} ${termKey(q.predicate)} ${termKey(q.object)} ${termKey(q.graph)}`).sort();
const snapshot = () => canonical(quads());
const text = () => store.viewIris().map(v => [v, store.viewText(v)]);
function run(c: ViewCommand): unknown {
    const r = store.execute(c);
    expect(r, c.kind).toMatchObject({ ok: true });
    return r.ok ? r.value : undefined;
}
function cycle(c: ViewCommand, check: (value: unknown) => void = () => {}) {
    const before = snapshot(), beforeText = text();
    const value = run(c);
    expect(snapshot(), c.kind).not.toEqual(before);
    const patch = store.last!;
    expect(patch.length).toBeGreaterThan(0);
    check(value);
    const after = snapshot(), afterText = text();
    store.graph.undo(patch);
    expect(snapshot()).toEqual(before);
    expect(text()).toEqual(beforeText);
    store.graph.redo(patch);
    expect(snapshot()).toEqual(after);
    expect(text()).toEqual(afterText);
}
const note = () => run({ kind: 'createNote', view: vid, text: 'note', at }) as string;
const collection = () => run({ kind: 'collect', view: vid, ids: cards().slice(0, 2).map(c => c.element as string) }) as string;
const clip = (): ViewClip => ({ format: VIEW_CLIP_FORMAT, mode: 'copy', source: view, edges: [], boxes: [{
    kind: 'note', id: 'clipboard-note', text: 'pasted note', x: 0, y: 0, width: 300, height: 150
}] });

test('addToView', () => {
    const id = card(); run({ kind: 'removeFromView', view: vid, ids: [id] });
    cycle({ kind: 'addToView', view, ids: [id], at }, () => expect(cards().some(c => c.element === id)).toBe(true));
});
test('showRelations', () => {
    const id = relation(); run({ kind: 'hideEdges', view: vid, ids: [id], hidden: true });
    cycle({ kind: 'showRelations', view: vid, ids: [id], at }, () => expect(elements().some(e => e.element === id)).toBe(true));
});
test('showAsEdge', () => {
    const shape = diagramOf(store.graph, model).children!.find(e => e.type === 'edge:property' && e.name === 'ex:stocks')!;
    run({ kind: 'removeFromView', view: mid, ids: [shape.id] });
    cycle({ kind: 'showAsEdge', view: mid, id: shape.id, at }, () => expect(diagramOf(store.graph, model).children!.some(e => e.id === shape.id && e.type === 'edge:property')).toBe(true));
});
test('showAsEdge of a datatype row places a Pill mark', () => {
    const row = birthDateRow();
    expect(row).toBeDefined();
    cycle({ kind: 'showAsEdge', view: mid, id: row.id, at }, () => {
        const children = diagramOf(store.graph, model).children!;
        const edge = children.find(e => e.id === row.id && e.type === 'edge:property')!;
        expect(edge).toMatchObject({ canPutBack: true, member: false, targetId: row.id + '_leaf' });
        expect(children.find(e => e.id === edge.targetId)).toMatchObject({ type: 'node:leaf', text: 'xsd:date', position: at });
        const mark = store.graph.match(null, P.type, V.Pill)[0].subject;
        expect(store.graph.match(mark, V.of)[0].object.value).toBe(shapesIndexOf(store.graph).model.properties[row.id].uri);
        expect(store.graph.match(null, V.element, mark)).toHaveLength(1);
        expect(birthDateRow()).toBeUndefined();
    });
});
test('showAsEdge of a datatype with hasValue targets its placed Pill', () => {
    const row = birthDateRow();
    const property = rdf.namedNode(shapesIndexOf(store.graph).model.properties[row.id].uri!);
    const graph = store.graph.match(property)[0].graph;
    store.graph.update(() => store.graph.add(property, rdf.namedNode('http://www.w3.org/ns/shacl#hasValue'), rdf.literal('2000-01-01'), graph));
    cycle({ kind: 'showAsEdge', view: mid, id: row.id, at }, () => {
        const children = diagramOf(store.graph, model).children!;
        expect(children.find(e => e.id === row.id)).toMatchObject({ type: 'edge:property', targetId: row.id + '_leaf' });
        expect(children.find(e => e.id === row.id + '_leaf')).toMatchObject({ type: 'node:leaf', text: 'xsd:date', position: at });
        expect(birthDateRow()).toBeUndefined();
    });
});
test.each(['line', 'pill'])('removeFromView of a datatype %s removes its mark and restores the row', end => {
    const row = birthDateRow();
    expect(row).toBeDefined();
    run({ kind: 'showAsEdge', view: mid, id: row.id, at });
    const children = diagramOf(store.graph, model).children!;
    const edge = children.find(e => e.id === row.id && e.type === 'edge:property')!;
    expect(edge).toBeDefined();
    expect(children.find(e => e.id === edge.targetId)).toMatchObject({ type: 'node:leaf', position: at });
    const mark = store.graph.match(null, P.type, V.Pill)[0].subject;
    cycle({ kind: 'removeFromView', view: mid, ids: [end === 'line' ? edge.id : edge.targetId as string] }, () => {
        expect(store.graph.match(mark)).toHaveLength(0);
        expect(store.graph.match(null, V.element, mark)).toHaveLength(0);
        expect(diagramOf(store.graph, model).children!.some(e => e.id === edge.id || e.id === edge.targetId)).toBe(false);
        expect(birthDateRow()).toEqual(row);
    });
});
test('setBounds moves a datatype Pill without moving its card', () => {
    const row = birthDateRow();
    run({ kind: 'showAsEdge', view: mid, id: row.id, at });
    const before = diagramOf(store.graph, model).children!.filter(e => e.type === 'node:shape');
    cycle({ kind: 'setBounds', view: mid, bounds: [{ id: row.id + '_leaf', x: 700, y: 800 }] }, () => {
        const children = diagramOf(store.graph, model).children!;
        expect(children.find(e => e.id === row.id + '_leaf')).toMatchObject({ position: { x: 700, y: 800 } });
        expect(children.filter(e => e.type === 'node:shape')).toEqual(before);
    });
});
test('removeFromView', () => {
    const id = card(); cycle({ kind: 'removeFromView', view: vid, ids: [id] }, () => expect(cards().some(c => c.element === id)).toBe(false));
});
test('setBounds', () => cycle({ kind: 'setBounds', view: vid, bounds: [{ id: card(), ...at, width: 600 }] }));
test('setLayout', () => cycle({ kind: 'setLayout', view: vid, bounds: [{ id: card(), ...at }] }));
test('setEdgeLayout', () => cycle({ kind: 'setEdgeLayout', view: vid, relation: relation(), patch: { color: '#ff0000', vertices: [{ x: 12, y: 34 }] } }));
test('setViewElements', () => cycle({ kind: 'setViewElements', view: vid, ids: [card()], patch: { color: '#123456', display: 'simple' } }));
test('hideEdges', () => {
    const id = relation(); cycle({ kind: 'hideEdges', view: vid, ids: [id], hidden: true }, () => expect(elements().some(e => e.element === id)).toBe(false));
});
test('createGroup', () => cycle({ kind: 'createGroup', view: vid, label: 'frame', around: [card()] }));
test('createNote', () => cycle({ kind: 'createNote', view: vid, text: 'new note', at }));
test('createArrow', () => cycle({ kind: 'createArrow', view: vid, from: note(), to: card() }));
test('addViewReference', () => {
    // Remove the fixture reference if present.
    for (const e of elements().filter(e => e.type === 'node:view-reference')) run({ kind: 'removeFromView', view: vid, ids: [e.id] });
    cycle({ kind: 'addViewReference', view: vid, target: mid, at });
});
test('addFileReference', () => cycle({ kind: 'addFileReference', view: vid, file: '../readme.md', at }));
test('collect', () => cycle({ kind: 'collect', view: vid, ids: cards().slice(0, 2).map(c => c.element as string) }));
test('addToCollection', () => {
    const id = collection(); cycle({ kind: 'addToCollection', view: vid, id, ids: [card()] });
});
test('uncollect', () => cycle({ kind: 'uncollect', view: vid, id: collection() }));
test('pasteIntoView', () => cycle({ kind: 'pasteIntoView', view: vid, clip: clip(), at }));
test('moveBetweenViews', () => {
    const id = note(), c = clip(); c.boxes[0].id = id; c.mode = 'cut';
    cycle({ kind: 'moveBetweenViews', from: view, to: model, clip: c, at });
});
test('setViewElements edits note text', () => {
    cycle({ kind: 'setViewElements', view: vid, ids: [note()], patch: { text: 'edited note' }, expectedText: 'note' });
});
test('fixture view text round-trips the same named quads including triple terms', () => {
    expect(canonical(parseRdfSync(store.viewText(view), 'application/trig'))).toEqual(canonical(store.graph.match(null, null, null, rdf.namedNode(view))));
    expect(store.viewText(view)).toContain('@prefix');
});
test('skolem shape placement keeps the skolem IRI in the view graph', () => {
    const iri = 'urn:skolem:blank:doc:1', t = rdf.namedNode(iri), sg = store.graph.shapesGraphs()[0];
    store.graph.update(() => store.graph.add(t, P.type, rdf.namedNode('http://www.w3.org/ns/shacl#NodeShape'), sg));
    expect(shapesIndexOf(store.graph).nodeShape.has(iriId(iri))).toBe(true);
    cycle({ kind: 'addToView', view: mid, ids: [iri], at }, () => expect(store.graph.match(null, V.element, t, rdf.namedNode(model))).toHaveLength(1));
});
test('failure after an earlier change rolls back the whole command', () => {
    const id = note(), before = snapshot();
    expect(store.execute({ kind: 'setViewElements', view: vid, ids: [id, 'missing'], patch: { text: 'changed' } }).ok).toBe(false);
    expect(snapshot()).toEqual(before);
});
test('no-op records no patch', () => {
    expect(store.execute({ kind: 'addToView', view: vid, ids: [card()], at })).toMatchObject({ ok: true, changed: false });
    expect(store.last).toBeUndefined();
});
