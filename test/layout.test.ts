import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { iriId } from '../src/catenary/model/ids';
import { graphOf } from '../src/model/graph-input';
import { instancesNamed, memberOptions } from '../src/model/choices';
import { ViewStore } from './view-store';
import { layoutView } from '../src/node/glsp/layout';
import type { GraphResult } from '../src/node/turtle-api';
import { readView } from '../src/catenary/rdf/view-read';
import { shapesIndexOf } from '../src/catenary/rdf/shapes-read';
import { fixtureGraph } from './fixture-graph';

const result = fixtureGraph();
const files = ['instances', 'model'].map(f => resolve(`test/fixtures/shapes/${f}.trig`));
const vid = iriId('urn:name:Bookshop');

test.each(['layered', 'force'] as const)('Apply Layout %s: new boxes for the cards, one store step that undoes', async algorithm => {
    const store = new ViewStore(graphOf(result, files).graph);
    const part = readView(store.graph, vid, shapesIndexOf(store.graph).model);
    const { bounds } = await layoutView(part, vid, algorithm);
    const before = part.views[vid].boxes;
    expect(bounds.length).toBe(before.length);
    expect(bounds.some(b => { const o = before.find(x => x.id === b.id)!; return o.x !== b.x || o.y !== b.y; })).toBe(true);
    const text = store.viewText('urn:name:Bookshop');
    expect(store.execute({ kind: 'setLayout', view: vid, bounds })).toMatchObject({ ok: true });
    expect(store.viewText('urn:name:Bookshop')).not.toBe(text);
    store.graph.undo(store.last!);
    expect(store.viewText('urn:name:Bookshop')).toBe(text);
});

test('"+ member": the options leave out the members; a label gives one instance', () => {
    const store = new ViewStore(graphOf(result, files).graph);
    const ids = instancesNamed(store.graph, 'Animal Farm');
    expect(ids).toHaveLength(1);
    const options = memberOptions(store.graph, vid, 'none');
    expect(options).toContain('Animal Farm');
    const id = (store.execute({ kind: 'collect', view: vid, ids }) as { value: string }).value;
    expect(memberOptions(store.graph, vid, id)).not.toContain('Animal Farm');
    expect(memberOptions(store.graph, vid, id)).toContain('George Orwell');
});
