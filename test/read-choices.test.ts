// Kata dxwx: the pickers from turtle/query (fork binary over stdio) equal model/choices.ts of the old pipeline on test/fixtures/shapes.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { iriId } from '../src/catenary/model/ids';
import type { ModelGraph } from '../src/catenary/rdf/graph';
import { shapesIndexOf } from '../src/catenary/rdf/shapes-read';
import { readView } from '../src/catenary/rdf/view-read';
import * as old from '../src/model/choices';
import { graphOf, graphPrefixes } from '../src/model/graph-input';
import { expandChoices, instanceLabels, instancesNamed, memberOptions } from '../src/read/choices';
import { type ModelContext, modelContextOf } from '../src/read/diagram';
import { scopedDoc } from '../src/read/scope';
import { scopedDoc as oldScopedDoc } from '../src/catenary/rdf/scoped-doc';
import { FIXTURE } from './fixture-graph';
import { startServer } from './server';

/** Triples of the six fixture documents (port.test.ts). */
const TRIPLES = 282;
const VIEWS = ['urn:name:Bookshop', 'urn:name:Bookshop%20model'];
const viewFiles = ['instances', 'model'].map(f => resolve(`test/fixtures/shapes/${f}.trig`));

describe('pickers on test/fixtures/shapes', () => {
    let server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext, graph: ModelGraph;
    beforeAll(async () => {
        server = await startServer(FIXTURE, TRIPLES);
        ctx = (await modelContextOf(server.port(), readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(f => join(FIXTURE, f)))).ctx;
        // The old graph from the live turtle/graph answer of the same server (graph.json is stale against data.ttl).
        graph = graphOf(await server.graph({ literals: true, types: true, maxNodes: 20000, layout: { iterations: 0 } }), viewFiles).graph;
    }, 20000);
    afterAll(async () => { await server?.stop(); });

    /** Every box and edge id of the view, and the elements of its cards. */
    const idsOf = (viewIri: string) => {
        graphPrefixes(graph);
        const view = readView(graph, iriId(viewIri), shapesIndexOf(graph).model).views[iriId(viewIri)];
        return [...new Set([...view.boxes.map(b => b.id), ...view.boxes.flatMap(b => b.kind === 'card' ? [b.element] : []), ...view.edges.flatMap(e => e.id ? [e.id, e.relation] : [e.relation])])];
    };

    test.each(VIEWS)('%s: expandChoices in, out and targets of every box, edge and element equal the old ones', async viewIri => {
        const vid = iriId(viewIri), ids = idsOf(viewIri);
        expect(ids.length).toBeGreaterThan(5);
        let some = 0;
        for (const from of ids) for (const dir of ['in', 'out', 'targets'] as const) {
            const before = old.expandChoices(graph, vid, from, dir);
            if (before) some++;
            expect(await expandChoices(ctx, vid, from, dir), `${from} ${dir}`).toEqual(before);
        }
        expect(some).toBeGreaterThan(0);
    });

    test.each(VIEWS)('%s: scopedDoc with neighbors and with showing equals the old one', async viewIri => {
        const vid = iriId(viewIri);
        graphPrefixes(graph);
        const shapes = shapesIndexOf(graph).model;
        for (const from of idsOf(viewIri).slice(0, 8)) {
            for (const scope of [{ elements: [from], neighbors: true, views: [vid] }, { elements: [from], showing: true, selectionViews: [vid] }]) {
                const before = oldScopedDoc({ g: graph, shapes }, scope), now = await scopedDoc(ctx, scope);
                expect(now.views, from).toEqual(before.views);
                expect(now.instances, from).toEqual(before.instances);
                expect(now.relations, from).toEqual(before.relations);
            }
        }
    });

    test('instanceLabels, memberOptions and instancesNamed equal the old ones', async () => {
        const labels = await instanceLabels(ctx);
        expect(labels.size).toBeGreaterThan(5);
        expect(labels.get('urn:name:Animal%20Farm')).toBe('Animal Farm');
        for (const viewIri of VIEWS) for (const collection of ['none', ...idsOf(viewIri)]) {
            expect(await memberOptions(ctx, iriId(viewIri), collection)).toEqual(old.memberOptions(graph, iriId(viewIri), collection));
        }
        for (const text of ['Animal Farm', 'George Orwell', 'urn:name:Animal%20Farm', 'nothing', ...labels.values()]) {
            expect((await instancesNamed(ctx, text)).sort()).toEqual(old.instancesNamed(graph, text).sort());
        }
    });
});

describe('the insert picker candidates', () => {
    let folder: string, server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext;
    beforeAll(async () => {
        folder = mkdtempSync(join(tmpdir(), 'catenary-dxwx-'));
        // A SKOS concept whose statements are all in the shapes closure (an sh: predicate), and an instance.
        writeFileSync(join(folder, 'vocabulary.ttl'), `@prefix skos: <http://www.w3.org/2004/02/skos/core#> . @prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:x:c> a skos:Concept ; sh:order 1 ; skos:prefLabel "Concept C" .
<urn:x:i> a <urn:x:T> ; <http://www.w3.org/2000/01/rdf-schema#label> "Instance I" .
`);
        server = await startServer(folder, 5);
        ctx = (await modelContextOf(server.port(), [join(folder, 'vocabulary.ttl')])).ctx;
    }, 20000);
    afterAll(async () => { await server?.stop(); rmSync(folder, { recursive: true, force: true }); });

    test('a SKOS subject of the shapes only: not an instance of the model, a candidate of the insert picker with its label', async () => {
        expect([...await instanceLabels(ctx)]).toEqual([['urn:x:i', 'Instance I']]);
        expect([...await instanceLabels(ctx, { vocabulary: true })]).toEqual([['urn:x:c', 'Concept C'], ['urn:x:i', 'Instance I']]);
    });
});
