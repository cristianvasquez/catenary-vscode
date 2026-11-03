// Copy, cut and paste on the canvas (kata tc43): the clip of a view, its paste into another view, the move of a cut, the Turtle of a paste.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { copyFromView } from '../src/catenary/model/commands';
import { placementOfId } from '../src/catenary/model/doc';
import { iriId } from '../src/catenary/model/ids';
import { shapesIndexOf } from '../src/catenary/rdf/shapes-read';
import { readView } from '../src/catenary/rdf/view-read';
import { diagramOf } from '../src/model/diagram';
import { graphOf } from '../src/model/graph-input';
import { ViewStore } from '../src/model/store';
import type { GraphResult } from '../src/node/turtle-api';
import { parseTurtle } from '../src/vscode/paste-rdf';
import { fixtureGraph } from './fixture-graph';

const result = fixtureGraph();
const files = ['instances', 'model'].map(f => resolve(`test/fixtures/shapes/${f}.trig`));
const vid = iriId('urn:name:Bookshop'), mid = iriId('urn:name:Bookshop%20model');
let store: ViewStore;
beforeEach(() => { store = new ViewStore(graphOf(result, files).graph); });
const part = (view: string) => readView(store.graph, view, shapesIndexOf(store.graph).model);
const names = (view: string) => diagramOf(store.graph, view).children!.map(e => e.name);
const clipOf = (iri: string, mode: 'copy' | 'cut') => {
    const doc = part(mid);
    return copyFromView(doc, mid, [placementOfId(doc.views[mid], iriId(iri))], mode)!;
};

test('a copy of a node shape card names its IRI; the paste places it in another view', () => {
    const clip = clipOf('urn:name:Author%20shape', 'copy');
    expect(clip.boxes.map(b => b.id)).toEqual(['urn:name:Author%20shape']);
    expect(names(vid)).not.toContain('Author shape');
    expect(store.execute({ kind: 'pasteIntoView', view: vid, clip, at: { x: 0, y: 0 } })).toMatchObject({ ok: true });
    expect(names(vid)).toContain('Author shape');
    expect(names(mid)).toContain('Author shape');
});

test('the paste of a cut moves the card: one patch that changes the two view graphs', () => {
    const clip = clipOf('urn:name:Book%20shape', 'cut');
    expect(store.execute({ kind: 'moveBetweenViews', from: clip.source, to: vid, clip, at: { x: 0, y: 0 } })).toMatchObject({ ok: true });
    expect(names(vid)).toContain('Book shape');
    expect(names(mid)).not.toContain('Book shape');
    expect(new Set(store.last!.map(c => c.quad.graph.value))).toEqual(new Set(['urn:name:Bookshop', 'urn:name:Bookshop%20model']));
});

test('Turtle text without prefix lines reads the prefixes of the workspace', () => {
    const plain = parseTurtle('<urn:a> a <urn:b> .', {});
    expect(plain?.map(q => q.subject.value)).toEqual(['urn:a']);
    const prefixed = parseTurtle('<urn:a> rdfs:label "a" .', { rdfs: 'http://www.w3.org/2000/01/rdf-schema#', sh: 'http://www.w3.org/ns/shacl#' });
    expect(prefixed?.[0].predicate.value).toBe('http://www.w3.org/2000/01/rdf-schema#label');
    expect(parseTurtle('not turtle', {})).toBeUndefined();
});
