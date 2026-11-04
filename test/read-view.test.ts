// Kata 1sx9: the Doc of a view from turtle/query (turtle-lsp binary over stdio) on test/fixtures/shapes, against the readView values of the old
// pipeline (recorded before K11 deleted it: test/fixtures/expected/read-view.json; the old pipeline got the data.ttl value of Animal Farm).
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { Doc } from '../src/catenary/model/doc';
import { iriId } from '../src/catenary/model/ids';
import { modelFilesOf, viewFilesOf } from '../src/model/view-files';
import { manifestOf, type ManifestRecords } from '../src/read/manifest';
import { shapesModelOf, type ShapesModelRecords } from '../src/read/shapes';
import type { ModelPort } from '../src/model/port';
import { diagramOf, type ModelContext, viewDocRead } from '../src/read/diagram';
import { viewDocOf, type ViewDocOptions, viewGraphsOf, viewLabelsOf, type ViewGraph } from '../src/read/view';
import { json, recorded } from './expected';
import { FIXTURE, startServer } from './server';

const R = recorded('read-view');

const contextOf = async (port: ModelPort, views: Map<string, string>, shapes: ShapesModelRecords, manifest: ManifestRecords, viewLabels?: Map<string, ViewGraph>): Promise<ModelContext> =>
    ({ port, modelFiles: shapes.files, shapes, manifest, views, viewLabels: viewLabels ?? await viewGraphsOf(port, views) });

/** The Doc of a view with the answer of its figure prefetch (viewDocRead: viewDocOf over the view statements and that answer). */
const docOf = async (port: ModelPort, views: Map<string, string>, iri: string, shapes: ShapesModelRecords, manifest: ManifestRecords, options: ViewDocOptions = {}, viewLabels?: Map<string, ViewGraph>) =>
    viewDocRead(await contextOf(port, views, shapes, manifest, viewLabels), iri, options);

const file = (name: string) => join(FIXTURE, name);
/** Triples of the six fixture documents (port.test.ts). */
const TRIPLES = 282;
const VIEWS = ['urn:name:Bookshop', 'urn:name:Bookshop%20model'];

describe('viewDocOf on test/fixtures/shapes', () => {
    let server: Awaited<ReturnType<typeof startServer>>, manifest: ManifestRecords, shapes: ShapesModelRecords, views: Map<string, string>, viewLabels: Map<string, ViewGraph>;
    beforeAll(async () => {
        server = await startServer(FIXTURE, TRIPLES);
        const rdfFiles = readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(file);
        const viewFiles = await viewFilesOf(server.port(), rdfFiles.filter(f => f.endsWith('.trig')));
        const modelFiles = modelFilesOf(rdfFiles, viewFiles);
        views = viewFiles.views;
        manifest = await manifestOf(server.port(), modelFiles);
        shapes = await shapesModelOf(server.port(), modelFiles, manifest);
        viewLabels = await viewGraphsOf(server.port(), views);
    }, 20000);
    afterAll(async () => { await server?.stop(); });

    const parts = (doc: Doc) => json({ views: doc.views, instances: doc.instances, relations: doc.relations });

    test.each(VIEWS)('%s: views, instances, relations and warnings equal the recorded readView', async viewIri => {
        const warnings: string[] = [];
        const now = await docOf(server.port(), views, viewIri, shapes, manifest, { warnings }, viewLabels);
        expect(now.shapes).toBe(shapes.index.model);
        expect(Object.keys(now.views).length).toBeGreaterThan(0);
        expect(Object.keys(now.instances).length).toBeGreaterThan(0);
        expect({ ...parts(now) as object, warnings: [...warnings].sort() }).toEqual(R(viewIri));
    });

    test('the elements branch: a card, a placement, an edge (when the view has one) and a box of each view equal the recorded readView', async () => {
        for (const viewIri of VIEWS) {
            const view = (await docOf(server.port(), views, viewIri, shapes, manifest, {}, viewLabels)).views[iriId(viewIri)];
            const cards = view.boxes.filter(b => b.kind === 'card');
            const elements = [cards[0].element, cards[1].id, ...view.edges.slice(0, 1).map(e => e.relation), view.boxes.find(b => b.kind !== 'card')!.id];
            const now = await docOf(server.port(), views, viewIri, shapes, manifest, { elements }, viewLabels);
            expect(now.views[iriId(viewIri)].boxes.length, viewIri).toBeGreaterThan(1);
            expect({ elements, ...parts(now) as object }).toEqual(R(`elements ${viewIri}`));
        }
    });

    test('a graph that is not a view gives the empty Doc', async () => {
        const now = await docOf(server.port(), views, 'urn:name:none', shapes, manifest, {}, viewLabels);
        expect([now.views, now.instances, now.relations]).toEqual([{}, {}, {}]);
    });

    test('viewLabelsOf equals the recorded viewLabels', async () => {
        expect(await viewLabelsOf(server.port(), views, manifest.language, viewLabels)).toEqual(R('viewLabels'));
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
    let dir: string, server: Awaited<ReturnType<typeof startServer>>, files: string[], shapes: ShapesModelRecords, views: Map<string, string>;
    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'catenary-view-'));
        writeFileSync(join(dir, 'data.ttl'), data);
        writeFileSync(join(dir, 'shapes.ttl'), shapesText);
        writeFileSync(join(dir, 'notes.trig'), view);
        writeFileSync(join(dir, 'legacy.trig'), legacy);
        // data 9, shapes 2, notes 17, legacy 14.
        server = await startServer(dir, 42);
        files = [join(dir, 'data.ttl'), join(dir, 'shapes.ttl')];
        views = new Map([[VIEW, join(dir, 'notes.trig')], [LEGACY, join(dir, 'legacy.trig')]]);
        shapes = await shapesModelOf(server.port(), files, {});
    }, 20000);
    afterAll(async () => {
        await server?.stop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    test('the note (a blank node), its arrow and the card show; the view is named by its file: IRI', async () => {
        const doc = await docOf(server.port(), views, VIEW, shapes, {});
        const v = doc.views[iriId(VIEW)];
        expect(v.label).toBe('Notes');
        expect(v.boxes.map(b => b.kind).sort()).toEqual(['card', 'note']);
        expect(v.boxes.find(b => b.kind === 'note')).toMatchObject({ id: iriId('urn:x:p1'), text: 'hello', x: 10, y: 20 });
        expect(v.arrows).toEqual([{ id: iriId('urn:x:p3'), from: iriId('urn:x:p1'), to: iriId('urn:x:p2') }]);
        expect(Object.keys(doc.instances)).toEqual([iriId('urn:x:a')]);
        expect(await viewLabelsOf(server.port(), views)).toEqual({ [iriId(VIEW)]: 'Notes', [iriId(LEGACY)]: 'Legacy' });
    });

    test('cached metadata needs no queries; a read sends no query on another view file and refreshes its own metadata; viewDocOf sends none', async () => {
        const port = server.port(), cached = await viewGraphsOf(port, views);
        const select = vi.spyOn(port, 'select'), construct = vi.spyOn(port, 'construct');
        expect(await viewLabelsOf(port, views, undefined, cached)).toEqual({ [iriId(VIEW)]: 'Notes', [iriId(LEGACY)]: 'Legacy' });
        expect(select).not.toHaveBeenCalled();
        const notesUri = pathToFileURL(join(dir, 'notes.trig')).href;
        const legacyUri = pathToFileURL(join(dir, 'legacy.trig')).href;
        const changed = view.replace('rdfs:label "Notes"', 'rdfs:label "Fresh notes" ; view:description "Fresh description"')
            .replace('<urn:x:p2> a view:Placement', `<urn:x:ref> a view:Placement ; view:element <${LEGACY}> . <urn:x:foreign> a view:Placement ; view:element <urn:x:ln> . <urn:x:p2> a view:Placement`);
        try {
            server.open(notesUri, changed, 'trig');
            server.open(legacyUri, legacy.replace('rdfs:label "Legacy"', 'rdfs:label "Changed elsewhere"'), 'trig');
            const warnings: string[] = [];
            const ctx = await contextOf(port, views, shapes, {}, cached);
            const doc = await viewDocRead(ctx, VIEW, { warnings });
            expect(doc.views[iriId(VIEW)]).toMatchObject({ label: 'Fresh notes', description: 'Fresh description' });
            expect(doc.views[iriId(LEGACY)].label).toBe('Legacy');
            expect(doc.views[iriId(VIEW)].boxes.some(b => b.id === iriId('urn:x:foreign'))).toBe(false);
            expect(warnings.some(w => w.includes('urn:x:ln') && w.includes('no supported card presentation'))).toBe(true);
            expect(construct.mock.calls.length).toBeGreaterThan(0);
            for (const [, scope] of [...select.mock.calls, ...construct.mock.calls]) expect(scope ?? []).not.toContain(join(dir, 'legacy.trig'));
            // The text and the answer of a complete draw: no query, the same Doc.
            const { kept } = await diagramOf(ctx, VIEW);
            const calls = select.mock.calls.length + construct.mock.calls.length;
            expect(viewDocOf(ctx, VIEW, changed, kept!, {})).toEqual(doc);
            expect(select.mock.calls.length + construct.mock.calls.length).toBe(calls);
            expect(cached.get(VIEW)).not.toBeUndefined();
            expect(await viewLabelsOf(port, views, undefined, cached)).toMatchObject({ [iriId(VIEW)]: 'Notes' });
        } finally {
            server.change(notesUri, view);
            server.change(legacyUri, legacy);
            select.mockRestore();
            construct.mockRestore();
        }
    });

    test('a view file in the legacy view namespace reads as the published one; a shape of shapes.ttl keeps its data.ttl statements', async () => {
        expect(shapes.shapeSubjectsByFile.get(join(dir, 'shapes.ttl'))).toEqual(new Set(['<urn:x:X>']));
        expect(shapes.shapeSubjectsByFile.has(join(dir, 'data.ttl'))).toBe(false);
        const doc = await docOf(server.port(), views, LEGACY, shapes, {});
        const v = doc.views[iriId(LEGACY)];
        expect(v.label).toBe('Legacy');
        expect(v.boxes.find(b => b.kind === 'note')).toMatchObject({ id: iriId('urn:x:lnp'), text: 'old' });
        expect(v.boxes.find(b => b.kind === 'card' && b.element === iriId('urn:x:a'))).toMatchObject({ id: iriId('urn:x:lp'), x: 5 });
        expect(doc.instances[iriId('urn:x:X')]).toMatchObject({ label: 'X', types: ['urn:x:T'], fields: { 'urn:x:p': [{ termType: 'Literal', value: 'v' }] } });
    });

    test('a view that places a blank node of a model file warns and omits the card', async () => {
        // A legacy placement stores a request-local skolem label, not an address.
        const uri = pathToFileURL(join(dir, 'blanks.trig')).href;
        const text = (element: string) => `@prefix view: <https://cristianvasquez.github.io/catenary/vocab/view#> .
<${BLANKS}> { <${BLANKS}> a view:View .${element ? ` <urn:x:bp> a view:Placement ; view:view <${BLANKS}> ; view:element <${element}> .` : ''} }`;
        server.open(uri, text(''), 'trig');
        const blankOf = async () => (await server.port().select('SELECT ?b WHERE { <urn:x:a> <urn:x:has> ?b }', [join(dir, 'data.ttl')]))[0].b.value;
        const blank = await blankOf();
        expect(blank).toMatch(/^urn:skolem:blank:/);
        server.change(uri, text(blank));
        expect(await blankOf()).toBe(blank);
        const warnings: string[] = [];
        const doc = await docOf(server.port(), new Map([[BLANKS, join(dir, 'blanks.trig')]]), BLANKS, shapes, {}, { warnings });
        expect(doc.instances[iriId(blank)]).toBeUndefined();
        expect(doc.views[iriId(BLANKS)].boxes).toEqual([]);
        expect(warnings).toContain('placement urn:x:bp: a blank node cannot be placed');
    });
});

test('an unplaced object typed or labelled in another model file is a hidden relation, not an ordinary field', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-cross-file-'));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    const VIEW = 'urn:x:cross-file', V = 'https://cristianvasquez.github.io/catenary/vocab/view#';
    try {
        writeFileSync(join(dir, 'data.ttl'), '<urn:x:a> a <urn:x:T> ; <urn:x:typed> <urn:x:b> ; <urn:x:labelled> <urn:x:c> ; <urn:x:unknown> <urn:x:d> .');
        writeFileSync(join(dir, 'other.ttl'), '<urn:x:b> a <urn:x:T> . <urn:x:c> <http://www.w3.org/2000/01/rdf-schema#label> "C" .');
        writeFileSync(join(dir, 'view.trig'), `<${VIEW}> { <${VIEW}> a <${V}View> . <urn:x:placement> a <${V}Placement> ; <${V}view> <${VIEW}> ; <${V}element> <urn:x:a> . }`);
        server = await startServer(dir, 10);
        const files = ['data.ttl', 'other.ttl'].map(f => join(dir, f));
        const shapes = await shapesModelOf(server.port(), files, {});
        const doc = await docOf(server.port(), new Map([[VIEW, join(dir, 'view.trig')]]), VIEW, shapes, {});
        expect(doc.instances[iriId('urn:x:a')].fields).toEqual({ 'urn:x:unknown': [{ termType: 'NamedNode', value: 'urn:x:d' }] });
    } finally {
        await server?.stop();
        rmSync(dir, { recursive: true, force: true });
    }
}, 20000);
