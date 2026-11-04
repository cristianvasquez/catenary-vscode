// Kata w1pm: shape targets and hidden neighbours from turtle/query (fork binary over stdio), against the values of the old functions
// (recorded before K11 deleted them: test/fixtures/expected/read-targets.json).
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { boxes, type View } from '../src/catenary/model/doc';
import { iriId } from '../src/catenary/model/ids';
import type { ShapesModel } from '../src/catenary/model/shapes-doc';
import { elementTerm } from '../src/catenary/rdf/ids';
import type { TargetSelection } from '../src/catenary/shacl/backend/targets';
import { modelFilesOf, viewFilesOf } from '../src/model/view-files';
import { manifestOf } from '../src/read/manifest';
import { hiddenNeighborCounts, viewBadges } from '../src/read/neighbors';
import { shapesModelOf, type ShapesModelRecords } from '../src/read/shapes';
import { shapeTargetMatches } from '../src/read/targets';
import type { ModelPort } from '../src/model/port';
import { diagramOf, type ModelContext, viewDocRead } from '../src/read/diagram';
import type { KeptPrefetch } from '../src/read/figures';
import type { ManifestRecords } from '../src/read/manifest';
import { type ViewDocOptions, type ViewGraph, viewGraphsOf } from '../src/read/view';
import { json, recorded } from './expected';
import { FIXTURE, startServer } from './server';

const R = recorded('read-targets');

/** The Doc of a view with the answer of its figure prefetch (viewDocRead): viewDocOf over the view statements and that answer. */
async function docOf(port: ModelPort, views: Map<string, string>, iri: string, shapes: ShapesModelRecords, manifest: ManifestRecords, options: ViewDocOptions = {}, viewLabels?: Map<string, ViewGraph>) {
    return viewDocRead({ port, modelFiles: shapes.files, shapes, manifest, views, viewLabels: viewLabels ?? await viewGraphsOf(port, views) }, iri, options);
}

/** The hidden counts of `view` (hiddenNeighborCounts over the answer of the draw, with the target badges). */
async function hiddenOf(port: ModelPort, views: Map<string, string>, iri: string, shapes: ShapesModelRecords, manifest: ManifestRecords = {}) {
    const ctx: ModelContext = { port, modelFiles: shapes.files, shapes, manifest, views, viewLabels: await viewGraphsOf(port, views) };
    const drawn = await diagramOf(ctx, iri), view = drawn.doc.views[iriId(iri)];
    return hiddenNeighborCounts(ctx, view, drawn.kept as KeptPrefetch, await viewBadges(ctx, view));
}

const file = (name: string) => join(FIXTURE, name);
/** Triples of the six fixture documents (port.test.ts). */
const TRIPLES = 282;
const VIEWS = ['urn:name:Bookshop', 'urn:name:Bookshop%20model'];

describe('shapeTargetMatches and hiddenNeighborCounts on test/fixtures/shapes', () => {
    let server: Awaited<ReturnType<typeof startServer>>, files: string[], now: ShapesModelRecords, model: ShapesModel;
    let manifest: ManifestRecords, viewFileMap: Map<string, string>;
    const views = new Map<string, View>();
    beforeAll(async () => {
        server = await startServer(FIXTURE, TRIPLES);
        const rdfFiles = readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(file);
        const viewFiles = await viewFilesOf(server.port(), rdfFiles.filter(f => f.endsWith('.trig')));
        const modelFiles = modelFilesOf(rdfFiles, viewFiles);
        manifest = await manifestOf(server.port(), modelFiles);
        viewFileMap = viewFiles.views;
        // The model documents without the manifest document (ModelContext.modelFiles).
        files = modelFiles.filter(f => f !== manifest.file);
        now = await shapesModelOf(server.port(), modelFiles, manifest);
        model = now.index.model;
        for (const v of VIEWS) views.set(v, (await docOf(server.port(), viewFiles.views, v, now, manifest)).views[iriId(v)]);
    }, 20000);
    afterAll(async () => { await server?.stop(); });

    /** The selections that hiddenNeighborCounts makes on a view: the placed node shapes, and the card IRIs. */
    const selectionsOf = (view: View): TargetSelection[] => {
        const placed = new Set(boxes(view, 'card').map(b => b.element));
        const cards = boxes(view, 'card').flatMap(b => { const t = elementTerm(b.element); return t ? [{ termType: 'NamedNode' as const, value: t.value }] : []; });
        return [{ shapes: Object.values(model.nodeShapes).filter(s => placed.has(s.id)).map(s => s.uri) }, { nodes: cards }];
    };

    test('the selections of both views, one node shape and one instance give the recorded matches', async () => {
        const selections = [...VIEWS.flatMap(v => selectionsOf(views.get(v)!)),
            { shapes: ['urn:name:Book%20shape'] }, { nodes: [{ termType: 'NamedNode' as const, value: 'urn:name:Animal%20Farm' }] }];
        const nonEmpty = selections.filter(s => (s.shapes ?? s.nodes)!.length > 0);
        expect(nonEmpty.length).toBeGreaterThanOrEqual(4);
        let matched = 0;
        expect(json(selections)).toEqual(R('selections'));
        for (const [i, selection] of selections.entries()) {
            const result = await shapeTargetMatches(server.port(), files, now, selection);
            expect(json(result), JSON.stringify(selection)).toEqual(R(`selection ${i}`));
            matched += result.length;
        }
        expect(matched).toBeGreaterThan(0);
    });

    test('the matches of an instance include a node reason (a walk along sh:node)', async () => {
        const result = await shapeTargetMatches(server.port(), files, now, { nodes: [{ termType: 'NamedNode', value: 'urn:name:Tangamandapio' }] });
        expect(result.some(m => m.reasons.some(r => r.kind === 'node'))).toBe(true);
        expect(json(result)).toEqual(R('Tangamandapio'));
    });

    /** Rows on the fixture: 7 on the instances view (one with 'in'), 4 on the model view (three shapes with targets). */
    test.each([[VIEWS[0], 7], [VIEWS[1], 4]] as const)('hiddenNeighborCounts of %s equals the recorded old one (%i rows)', async (v, rows) => {
        const result = await hiddenOf(server.port(), viewFileMap, v, now, manifest);
        expect(result.size).toBe(rows);
        expect(json([...result])).toEqual(R(`hidden ${v}`));
    });
});

describe('blank-node intermediates (temp folder)', () => {
    const EX = 'http://example.org/';
    const prefixes = `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix ex: <${EX}> .\n`;
    // Root -ex:p-> Mid -ex:q-> Leaf along sh:node; Far over the compound path (ex:p ex:q) from a blank property shape; Mark: sh:targetSubjectsOf.
    const shapes = `${prefixes}ex:Root a sh:NodeShape ; sh:targetClass ex:R ; sh:property ex:Root-p .
ex:Root-p sh:path ex:p ; sh:node ex:Mid .
ex:Mid a sh:NodeShape ; sh:property ex:Mid-q .
ex:Mid-q sh:path ex:q ; sh:node ex:Leaf .
ex:Leaf a sh:NodeShape .
ex:Comp a sh:NodeShape ; sh:targetClass ex:R ; sh:property [ sh:path ( ex:p ex:q ) ; sh:node ex:Far ] .
ex:Far a sh:NodeShape .
ex:Mark a sh:NodeShape ; sh:targetSubjectsOf ex:mark .
`;
    const data = `${prefixes}ex:root a ex:R ; ex:p [ a ex:Thing ; ex:q ex:leaf ; ex:mark "m" ] .
ex:leaf rdfs:label "leaf" .
`;
    const viewIri = 'urn:name:V';
    const viewText = `@prefix view: <https://cristianvasquez.github.io/catenary/vocab/view#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<${viewIri}> { <${viewIri}> a view:View ; rdfs:label "V" .
  <${viewIri}/p/1> a view:Placement ; view:element <${EX}root> ; view:view <${viewIri}> ; view:x 0 ; view:y 0 ; view:width 450 ; view:height 300 .
  <${viewIri}/p/2> a view:Placement ; view:element <${EX}Root> ; view:view <${viewIri}> ; view:x 600 ; view:y 0 ; view:width 450 ; view:height 300 . }
`;
    let dir: string, server: Awaited<ReturnType<typeof startServer>>, files: string[], now: ShapesModelRecords, blank: string, propertyBlank: string;
    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'catenary-targets-'));
        writeFileSync(join(dir, 'shapes.ttl'), shapes);
        writeFileSync(join(dir, 'data.ttl'), data);
        writeFileSync(join(dir, 'view.trig'), viewText);
        server = await startServer(dir, 34);
        files = ['data.ttl', 'shapes.ttl'].map(f => join(dir, f));
        now = await shapesModelOf(server.port(), files, {});
        const [row] = await server.port().select(`SELECT ?b WHERE { <${EX}root> <${EX}p> ?b }`, files);
        blank = row.b.value;
        const [property] = await server.port().select(`SELECT ?b WHERE { <${EX}Comp> <http://www.w3.org/ns/shacl#property> ?b }`, files);
        propertyBlank = property.b.value;
    }, 20000);
    afterAll(async () => {
        await server?.stop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    const node = (value: string) => ({ termType: 'NamedNode' as const, value });
    /** The recorded value with the IRI of the old blank-node label (`<document>:<n>`, 0:1) replaced by the IRI of the label that the server gives now. */
    const recordedBlank = (name: string) => JSON.parse(JSON.stringify(R(name))
        .replaceAll('urn:skolem:blank:000000-00000001', blank)
        .replaceAll('urn:skolem:blank:000001-00000001', propertyBlank));

    test('the blank node of the port is a skolem IRI', () => {
        expect(blank).toMatch(/^urn:skolem:blank:/);
    });

    test.each([
        ['shapes Leaf (walk through the blank node)', 1, () => ({ shapes: [`${EX}Leaf`] })],
        ['shapes Far (compound path)', 1, () => ({ shapes: [`${EX}Far`] })],
        ['shapes Mark (a blank subject)', 1, () => ({ shapes: [`${EX}Mark`] })],
        ['nodes leaf (reverse walk through the blank node)', 2, () => ({ nodes: [node(`${EX}leaf`)] })],
    ] as [string, number, () => TargetSelection][])('%s equals the recorded old one (%i matches)', async (name, count, selection) => {
        const result = await shapeTargetMatches(server.port(), files, now, selection());
        expect(result).toHaveLength(count);
        expect(json(result)).toEqual(recordedBlank(name));
    });

    test('hiddenNeighborCounts keeps blank neighbours in different files distinct', async () => {
        const folder = mkdtempSync(join(tmpdir(), 'catenary-neighbours-'));
        let otherServer: Awaited<ReturnType<typeof startServer>> | undefined;
        try {
            const modelFiles = ['a.ttl', 'b.ttl'].map(f => join(folder, f));
            for (const file of modelFiles) writeFileSync(file, `${prefixes}ex:root a ex:R ; ex:p [ a ex:Thing ] .`);
            writeFileSync(join(folder, 'view.trig'), viewText);
            otherServer = await startServer(folder, 22);
            const otherShapes = await shapesModelOf(otherServer.port(), modelFiles, {});
            const result = await hiddenOf(otherServer.port(), new Map([[viewIri, join(folder, 'view.trig')]]), viewIri, otherShapes);
            expect(result.get(iriId(`${EX}root`))?.out).toBe(2);
        } finally {
            await otherServer?.stop();
            rmSync(folder, { recursive: true, force: true });
        }
    });

    test('hiddenNeighborCounts counts the blank neighbour as the old one did', async () => {
        const result = await hiddenOf(server.port(), new Map([[viewIri, join(dir, 'view.trig')]]), viewIri, now);
        expect(result.get(iriId(`${EX}root`))?.out).toBe(1);
        expect(json([...result])).toEqual(recordedBlank('hidden blank'));
    });
});
