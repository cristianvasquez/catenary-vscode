// Kata 1sx9: the Doc of a view from turtle/query (fork binary over stdio) equals readView of the old pipeline on test/fixtures/shapes.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
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
        expect(await viewLabelsOf(server.port(), shapes.files, manifest.language)).toEqual(viewLabels(graph));
    });
});

describe('viewDocOf in a temp folder: blank nodes, a file: view IRI, legacy terms, a subject that is a shape in one file only', () => {
    const VIEW = 'file:///views/notes', LEGACY = 'urn:x:legacy', BLANKS = 'urn:x:blanks';
    const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
    const data = `<urn:x:a> a <urn:x:T> ; <${LABEL}> "A" .
<urn:x:X> a <urn:x:T> ; <${LABEL}> "X" ; <urn:x:p> "v" .
<urn:x:a> <urn:x:has> [ a <urn:x:T> ; <${LABEL}> "B" ; <urn:x:p> "inner" ] .
`;
    const shapesText = `<urn:x:X> a <http://www.w3.org/ns/shacl#NodeShape> ; <http://www.w3.org/ns/shacl#targetClass> <urn:x:T> .\n`;
    const view = `@prefix view: <https://cristianvasquez.github.io/catenary/vocab/view#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
<${VIEW}> { <${VIEW}> a view:View ; rdfs:label "Notes" .
  <urn:x:p1> a view:Placement ; view:view <${VIEW}> ; view:element _:n ; view:x 10 ; view:y 20 .
  _:n a view:Note ; view:text "hello" ; view:arrow <urn:x:a> .
  <urn:x:p2> a view:Placement ; view:view <${VIEW}> ; view:element <urn:x:a> ; view:x 300 .
  <urn:x:p3> a view:Placement ; view:view <${VIEW}> ; rdf:reifies <<( _:n view:arrow <urn:x:a> )>> . }
`;
    // The legacy namespace of view: (LEGACY_NAMESPACES of model/terms.ts).
    const legacy = `@prefix view: <osg://vocab/view#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<${LEGACY}> { <${LEGACY}> a view:View ; rdfs:label "Legacy" .
  <urn:x:lp> a view:Placement ; view:view <${LEGACY}> ; view:element <urn:x:a> ; view:x 5 .
  <urn:x:ln> a view:Note ; view:text "old" .
  <urn:x:lnp> a view:Placement ; view:view <${LEGACY}> ; view:element <urn:x:ln> .
  <urn:x:lx> a view:Placement ; view:view <${LEGACY}> ; view:element <urn:x:X> . }
`;
    let dir: string, server: Awaited<ReturnType<typeof startServer>>, files: string[], shapes: ShapesModelRecords;
    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'catenary-view-'));
        writeFileSync(join(dir, 'data.ttl'), data);
        writeFileSync(join(dir, 'shapes.ttl'), shapesText);
        writeFileSync(join(dir, 'notes.trig'), view);
        writeFileSync(join(dir, 'legacy.trig'), legacy);
        // data 9, shapes 2, notes 17, legacy 14.
        server = await startServer(dir, 42);
        files = [join(dir, 'data.ttl'), join(dir, 'shapes.ttl')];
        shapes = await shapesModelOf(server.port(), files, {});
    }, 20000);
    afterAll(async () => {
        await server?.stop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    test('the note (a blank node), its arrow and the card show; the view is named by its file: IRI', async () => {
        const doc = await viewDocOf(server.port(), VIEW, shapes, {});
        const v = doc.views[iriId(VIEW)];
        expect(v.label).toBe('Notes');
        expect(v.boxes.map(b => b.kind).sort()).toEqual(['card', 'note']);
        expect(v.boxes.find(b => b.kind === 'note')).toMatchObject({ id: iriId('urn:x:p1'), text: 'hello', x: 10, y: 20 });
        expect(v.arrows).toEqual([{ id: iriId('urn:x:p3'), from: iriId('urn:x:p1'), to: iriId('urn:x:p2') }]);
        expect(Object.keys(doc.instances)).toEqual([iriId('urn:x:a')]);
        expect(await viewLabelsOf(server.port(), files)).toEqual({ [iriId(VIEW)]: 'Notes', [iriId(LEGACY)]: 'Legacy' });
    });

    test('a view file in the legacy view namespace reads as the published one; a shape of shapes.ttl keeps its data.ttl statements', async () => {
        expect(shapes.shapeSubjectsByFile.get(join(dir, 'shapes.ttl'))).toEqual(new Set(['<urn:x:X>']));
        expect(shapes.shapeSubjectsByFile.has(join(dir, 'data.ttl'))).toBe(false);
        const doc = await viewDocOf(server.port(), LEGACY, shapes, {});
        const v = doc.views[iriId(LEGACY)];
        expect(v.label).toBe('Legacy');
        expect(v.boxes.find(b => b.kind === 'note')).toMatchObject({ id: iriId('urn:x:lnp'), text: 'old' });
        expect(v.boxes.find(b => b.kind === 'card' && b.element === iriId('urn:x:a'))).toMatchObject({ id: iriId('urn:x:lp'), x: 5 });
        expect(doc.instances[iriId('urn:x:X')]).toMatchObject({ label: 'X', types: ['urn:x:T'], fields: { 'urn:x:p': [{ termType: 'Literal', value: 'v' }] } });
    });

    test('a view that places a blank node of a model file gives its instance with its statements', async () => {
        // The skolem label names the document by its number: open the view document first, then read the label, then place it.
        const uri = pathToFileURL(join(dir, 'blanks.trig')).href;
        const text = (element: string) => `@prefix view: <https://cristianvasquez.github.io/catenary/vocab/view#> .
<${BLANKS}> { <${BLANKS}> a view:View .${element ? ` <urn:x:bp> a view:Placement ; view:view <${BLANKS}> ; view:element <${element}> .` : ''} }`;
        server.open(uri, text(''), 'trig');
        const blankOf = async () => (await server.port().select('SELECT ?b WHERE { <urn:x:a> <urn:x:has> ?b }', [join(dir, 'data.ttl')]))[0].b.value;
        const blank = await blankOf();
        expect(blank).toMatch(/^urn:skolem:blank:/);
        server.change(uri, text(blank));
        expect(await blankOf()).toBe(blank);
        const doc = await viewDocOf(server.port(), BLANKS, shapes, {});
        expect(doc.instances[iriId(blank)]).toMatchObject({ uri: blank, label: 'B', types: ['urn:x:T'], fields: { 'urn:x:p': [{ termType: 'Literal', value: 'inner' }] } });
        expect(doc.views[iriId(BLANKS)].boxes).toMatchObject([{ kind: 'card', id: iriId('urn:x:bp'), element: iriId(blank) }]);
    });
});
