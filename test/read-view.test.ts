// Kata 1sx9: the Doc of a view from turtle/query (fork binary over stdio) equals readView of the old pipeline on test/fixtures/shapes.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Doc } from '../src/catenary/model/doc';
import { iriId } from '../src/catenary/model/ids';
import type { ModelGraph } from '../src/catenary/rdf/graph';
import { shapesIndexOf } from '../src/catenary/rdf/shapes-read';
import { readView, viewLabels } from '../src/catenary/rdf/view-read';
import { graphOf, graphPrefixes } from '../src/model/graph-input';
import { modelFilesOf, viewFilesOf } from '../src/model/view-files';
import { manifestOf, type ManifestRecords } from '../src/read/manifest';
import { shapesModelOf, type ShapesModelRecords } from '../src/read/shapes';
import { viewDocOf, viewLabelsOf } from '../src/read/view';
import { FIXTURE, fixtureGraph } from './fixture-graph';
import { startServer } from './server';

const file = (name: string) => join(FIXTURE, name);
/** Triples of the six fixture documents (port.test.ts). */
const TRIPLES = 282;
const VIEWS = ['urn:name:Bookshop', 'urn:name:Bookshop%20model'];

describe('viewDocOf on test/fixtures/shapes', () => {
    let server: Awaited<ReturnType<typeof startServer>>, manifest: ManifestRecords, shapes: ShapesModelRecords, graph: ModelGraph;
    beforeAll(async () => {
        server = await startServer(FIXTURE, TRIPLES);
        const rdfFiles = readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(file);
        const modelFiles = modelFilesOf(rdfFiles, await viewFilesOf(server.port(), rdfFiles.filter(f => f.endsWith('.trig'))));
        manifest = await manifestOf(server.port(), modelFiles);
        shapes = await shapesModelOf(server.port(), modelFiles, manifest);
        graph = graphOf(fixtureGraph(), ['instances.trig', 'model.trig'].map(file)).graph;
        graphPrefixes(graph);
    }, 20000);
    afterAll(async () => { await server?.stop(); });

    /**
     * readView on the recorded graph.json. One known difference with the fixture files: graph.json was recorded before data.ttl changed
     * `ex:publicationYear 1945` of Animal Farm to "nineteen forty-five" (241ab36, the SHACL error of the sample). The oracle gets the file value.
     */
    const old = (viewIri: string, warnings: string[], elements?: string[]) => {
        const doc = readView(graph, iriId(viewIri), shapesIndexOf(graph).model, warnings, elements);
        const fields = doc.instances[iriId('urn:name:Animal%20Farm')]?.fields;
        const year = 'http://www.example.org/publicationYear';
        if (fields?.[year]) {
            expect(fields[year]).toEqual([{ termType: 'Literal', value: '1945', datatype: 'http://www.w3.org/2001/XMLSchema#integer' }]);
            fields[year] = [{ termType: 'Literal', value: 'nineteen forty-five' }];
        }
        return doc;
    };
    const same = (now: Doc, before: Doc) => {
        expect(now.shapes).toBe(shapes.index.model);
        expect(now.views).toEqual(before.views);
        expect(now.instances).toEqual(before.instances);
        expect(now.relations).toEqual(before.relations);
    };

    test.each(VIEWS)('%s: views, instances and relations equal readView', async viewIri => {
        const warnings: string[] = [], oldWarnings: string[] = [];
        const now = await viewDocOf(server.port(), viewIri, shapes, manifest, { warnings });
        const before = old(viewIri, oldWarnings);
        expect(Object.keys(before.views).length).toBeGreaterThan(0);
        expect(Object.keys(before.instances).length).toBeGreaterThan(0);
        same(now, before);
        expect([...warnings].sort()).toEqual([...oldWarnings].sort());
    });

    test('the elements branch: a card, a placement, an edge (when the view has one) and a box of each view equal readView with the same elements', async () => {
        for (const viewIri of VIEWS) {
            const view = old(viewIri, []).views[iriId(viewIri)];
            const cards = view.boxes.filter(b => b.kind === 'card');
            const elements = [cards[0].element, cards[1].id, ...view.edges.slice(0, 1).map(e => e.relation), view.boxes.find(b => b.kind !== 'card')!.id];
            const before = old(viewIri, [], elements);
            expect(before.views[iriId(viewIri)].boxes.length, viewIri).toBeGreaterThan(1);
            same(await viewDocOf(server.port(), viewIri, shapes, manifest, { elements }), before);
        }
    });

    test('a graph that is not a view gives the empty Doc', async () => {
        const now = await viewDocOf(server.port(), 'urn:name:none', shapes, manifest);
        expect([now.views, now.instances, now.relations]).toEqual([{}, {}, {}]);
    });

    test('viewLabelsOf equals viewLabels', async () => {
        expect(await viewLabelsOf(server.port(), manifest.language)).toEqual(viewLabels(graph));
    });
});
