// Kata w1pm: shape targets and hidden neighbours from turtle/query (fork binary over stdio) equal the old functions on test/fixtures/shapes.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { boxes, type View } from '../src/catenary/model/doc';
import { iriId } from '../src/catenary/model/ids';
import type { ShapesModel } from '../src/catenary/model/shapes-doc';
import type { ModelGraph } from '../src/catenary/rdf/graph';
import { elementTerm } from '../src/catenary/rdf/ids';
import { hiddenNeighborCounts as oldCounts } from '../src/catenary/rdf/scoped-doc';
import { shapeTargetMatches as oldMatches } from '../src/catenary/rdf/shacl-targets';
import { shapesIndexOf } from '../src/catenary/rdf/shapes-read';
import { rdf } from '../src/catenary/rdf/terms';
import { readView } from '../src/catenary/rdf/view-read';
import type { TargetSelection } from '../src/catenary/shacl/backend/targets';
import { graphOf, graphPrefixes } from '../src/model/graph-input';
import { modelFilesOf, viewFilesOf } from '../src/model/view-files';
import { manifestOf } from '../src/read/manifest';
import { hiddenNeighborCounts } from '../src/read/neighbors';
import { shapesModelOf, type ShapesModelRecords } from '../src/read/shapes';
import { shapeTargetMatches } from '../src/read/targets';
import { FIXTURE, fixtureGraph } from './fixture-graph';
import { startServer } from './server';

const file = (name: string) => join(FIXTURE, name);
/** Triples of the six fixture documents (port.test.ts). */
const TRIPLES = 282;
const VIEWS = ['urn:name:Bookshop', 'urn:name:Bookshop%20model'];

describe('shapeTargetMatches and hiddenNeighborCounts on test/fixtures/shapes', () => {
    let server: Awaited<ReturnType<typeof startServer>>, files: string[], now: ShapesModelRecords, graph: ModelGraph, model: ShapesModel;
    const views = new Map<string, View>();
    beforeAll(async () => {
        server = await startServer(FIXTURE, TRIPLES);
        const rdfFiles = readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(file);
        const modelFiles = modelFilesOf(rdfFiles, await viewFilesOf(server.port(), rdfFiles.filter(f => f.endsWith('.trig'))));
        const manifest = await manifestOf(server.port(), modelFiles);
        // The old store holds no manifest document.
        files = modelFiles.filter(f => f !== manifest.file);
        now = await shapesModelOf(server.port(), modelFiles, manifest);
        graph = graphOf(fixtureGraph(), ['instances.trig', 'model.trig'].map(file)).graph;
        graphPrefixes(graph);
        model = shapesIndexOf(graph).model;
        for (const v of VIEWS) views.set(v, readView(graph, iriId(v), model).views[iriId(v)]);
    }, 20000);
    afterAll(async () => { await server?.stop(); });

    /** The selections that hiddenNeighborCounts makes on a view: the placed node shapes, and the card IRIs. */
    const selectionsOf = (view: View): TargetSelection[] => {
        const placed = new Set(boxes(view, 'card').map(b => b.element));
        const cards = boxes(view, 'card').flatMap(b => { const t = elementTerm(b.element); return t ? [{ termType: 'NamedNode' as const, value: t.value }] : []; });
        return [{ shapes: Object.values(model.nodeShapes).filter(s => placed.has(s.id)).map(s => s.uri) }, { nodes: cards }];
    };

    test('the selections of both views, one node shape and one instance give the old matches', async () => {
        const selections = [...VIEWS.flatMap(v => selectionsOf(views.get(v)!)),
            { shapes: ['urn:name:Book%20shape'] }, { nodes: [{ termType: 'NamedNode' as const, value: 'urn:name:Animal%20Farm' }] }];
        const nonEmpty = selections.filter(s => (s.shapes ?? s.nodes)!.length > 0);
        expect(nonEmpty.length).toBeGreaterThanOrEqual(4);
        let matched = 0;
        for (const selection of selections) {
            const old = oldMatches(graph, selection), result = await shapeTargetMatches(server.port(), files, now, selection);
            expect(result, JSON.stringify(selection)).toEqual(old);
            matched += old.length;
        }
        expect(matched).toBeGreaterThan(0);
    });

    test('the matches of an instance include a node reason (a walk along sh:node)', async () => {
        const result = await shapeTargetMatches(server.port(), files, now, { nodes: [{ termType: 'NamedNode', value: 'urn:name:Tangamandapio' }] });
        expect(result.some(m => m.reasons.some(r => r.kind === 'node'))).toBe(true);
        expect(result).toEqual(oldMatches(graph, { nodes: [{ termType: 'NamedNode', value: 'urn:name:Tangamandapio' }] }));
    });

    /** Rows of the old function on the fixture: 7 on the instances view (one with 'in'), 4 on the model view (three shapes with targets). */
    test.each([[VIEWS[0], 7], [VIEWS[1], 4]] as const)('hiddenNeighborCounts of %s equals the old (%i rows)', async (v, rows) => {
        const view = views.get(v)!;
        const old = oldCounts(graph, model, view), result = await hiddenNeighborCounts(server.port(), files, now, view);
        expect(old.size).toBe(rows);
        expect([...result]).toEqual([...old]);
    });
});

describe('blank-node intermediates (temp folder, old pipeline over turtle/graph of the same server)', () => {
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
    let dir: string, server: Awaited<ReturnType<typeof startServer>>, files: string[], now: ShapesModelRecords, graph: ModelGraph, model: ShapesModel, blank: string;
    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'catenary-targets-'));
        writeFileSync(join(dir, 'shapes.ttl'), shapes);
        writeFileSync(join(dir, 'data.ttl'), data);
        writeFileSync(join(dir, 'view.trig'), viewText);
        server = await startServer(dir, 34);
        files = ['data.ttl', 'shapes.ttl'].map(f => join(dir, f));
        now = await shapesModelOf(server.port(), files, {});
        graph = graphOf(await server.graph({ literals: true, types: true, maxNodes: 20000, layout: { iterations: 0 } }), [join(dir, 'view.trig')]).graph;
        model = shapesIndexOf(graph).model;
        const [row] = await server.port().select(`SELECT ?b WHERE { <${EX}root> <${EX}p> ?b }`, files);
        blank = row.b.value;
    }, 20000);
    afterAll(async () => {
        await server?.stop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    const node = (value: string) => ({ termType: 'NamedNode' as const, value });

    test('the blank node of the port is the skolem IRI of the old store', () => {
        expect(blank).toMatch(/^urn:skolem:blank:/);
        expect(graph.match(rdf.namedNode(blank)).length).toBe(3);
    });

    test.each([
        ['shapes Leaf (walk through the blank node)', 1, () => ({ shapes: [`${EX}Leaf`] })],
        ['shapes Far (compound path)', 1, () => ({ shapes: [`${EX}Far`] })],
        ['shapes Mark (a blank subject)', 1, () => ({ shapes: [`${EX}Mark`] })],
        ['nodes leaf (reverse walk through the blank node)', 2, () => ({ nodes: [node(`${EX}leaf`)] })],
        ['nodes blank', 2, () => ({ nodes: [node(blank)] })],
    ] as [string, number, () => TargetSelection][])('%s equals the old (%i matches)', async (_, count, selection) => {
        const old = oldMatches(graph, selection()), result = await shapeTargetMatches(server.port(), files, now, selection());
        expect(old).toHaveLength(count);
        expect(result).toEqual(old);
    });

    test('hiddenNeighborCounts counts the blank neighbour as the old does', async () => {
        const view = readView(graph, iriId(viewIri), model).views[iriId(viewIri)];
        const old = oldCounts(graph, model, view), result = await hiddenNeighborCounts(server.port(), files, now, view);
        expect(old.get(iriId(`${EX}root`))?.out).toBe(1);
        expect([...result]).toEqual([...old]);
    });
});
