// Kata 8twe: the diagram of each fixture view from turtle/query (fork binary over stdio), against the expected schemas and against
// diagramOf of the old pipeline. The read builders of the old pipeline keep their tests on the recorded graph.json until K11.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { graphOf } from '../src/model/graph-input';
import { diagramOf as oldDiagramOf } from '../src/model/diagram';
import { diagramOf, type ModelContext, modelContextOf } from '../src/read/diagram';
import type { ElementSchema } from '../src/catenary/model/diagram-schema';
import type { ModelGraph } from '../src/catenary/rdf/graph';
import { iriId } from '../src/catenary/model/ids';
import { NS } from '../src/catenary/model/terms';
import { rdf } from '../src/catenary/rdf/terms';
import { readView, viewLabels } from '../src/catenary/rdf/view-read';
import { shapesIndexOf } from '../src/catenary/rdf/shapes-read';
import { hiddenNeighborCounts, scopedDoc } from '../src/catenary/rdf/scoped-doc';
import { homesAmong, inModelAmong, instancesAmong, labels } from '../src/catenary/rdf/quad-read';
import { dataGraphIri } from '../src/catenary/rdf/graph-names';
import { FIXTURE, fixtureGraph } from './fixture-graph';
import { startServer } from './server';

const result = fixtureGraph();
const viewFiles = ['instances', 'model'].map(f => resolve(`test/fixtures/shapes/${f}.trig`));
const modelIri = 'urn:name:Bookshop%20model', instancesIri = 'urn:name:Bookshop';
/** Triples of the six fixture documents (port.test.ts). */
const TRIPLES = 282;
const id = (local: string) => iriId(`urn:name:${local}`);
let server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext;
let graph: ModelGraph, model: ElementSchema[], instances: ElementSchema[];
const named = (elements: ElementSchema[], name: string): ElementSchema => {
    const element = elements.find(e => e.name === name);
    expect(element, name).toBeDefined();
    return element!;
};

beforeAll(async () => {
    server = await startServer(FIXTURE, TRIPLES);
    ctx = (await modelContextOf(server.port(), readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(f => join(FIXTURE, f)))).ctx;
    model = (await diagramOf(ctx, modelIri)).schema.children!;
    instances = (await diagramOf(ctx, instancesIri)).schema.children!;
    graph = graphOf(result, viewFiles).graph;
}, 20000);
afterAll(async () => { await server?.stop(); });

describe('the old pipeline as oracle', () => {
    test.each([modelIri, instancesIri])('%s: the schema is byte-identical to diagramOf of the old pipeline on the same files', async iri => {
        // The old graph from the live turtle/graph answer of the same server, not from graph.json (recorded before data.ttl changed).
        const live = graphOf(await server.graph({ literals: true, types: true, maxNodes: 20000, layout: { iterations: 0 } }), viewFiles).graph;
        const before = JSON.stringify(oldDiagramOf(live, iri));
        expect(JSON.stringify((await diagramOf(ctx, iri)).schema)).toBe(before);
    });
});

describe('Bookshop model', () => {
    test('Shop shape card retains its id, label and Bookshop target', () => {
        expect(named(model, 'Shop shape')).toMatchObject({
            type: 'node:shape', id: id('Bookshop%20model/p/7139963bee9d'),
            element: id('Bookshop%20shape'), subtitle: 'Bookshop', children: []
        });
    });

    test.each([
        ['ex:city', '1', 'Shop shape', 'Cities', 'Bookshop%20shape-city'],
        ['ex:stocks', '0..*', 'Shop shape', 'Book shape', 'Bookshop%20shape-stocks'],
        ['ex:author', '1..*', 'Book shape', 'Author shape', 'Book%20shape-author']
    ])('%s has the required multiplicity and endpoints', (name, card, source, target, local) => {
        expect(named(model, name)).toMatchObject({
            type: 'edge:property', id: id(local), name, card,
            sourceId: named(model, source).id, targetId: named(model, target).id
        });
    });

    test('Cities is a collection with exactly two labelled member rows', () => {
        expect(named(model, 'Cities')).toMatchObject({
            type: 'node:valueset', id: id('Bookshop%20model/p/a12a3911c890'), kind: 'collection',
            members: [
                { uri: 'urn:name:Tangamandapio', label: 'Tangamandapio', instance: id('Tangamandapio') },
                { uri: 'urn:name:Tanganana', label: 'Tanganana', instance: id('Tanganana') }
            ]
        });
    });

    test('shape attribute rows keep paths, datatypes and counts', () => {
        for (const [shape, property, path, range] of [
            ['Book shape', 'Book%20shape-publicationYear', 'publicationYear', 'xsd:integer'],
            ['Author shape', 'Author%20shape-birthDate', 'birthDate', 'xsd:date']
        ]) {
            const rows = named(model, shape).children!;
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ type: 'label:row', id: id(property), range, card: '1' });
            expect((rows[0].parts as { text: string }[]).map(p => p.text).join('')).toBe(`ex:${path}`);
        }
    });
});

describe('Bookshop instances', () => {
    test('seven cards retain their model ids, classes, labels and row texts', () => {
        const expected = [
            ['Alice’s Adventures in Wonderland', 'Alice%E2%80%99s%20Adventures%20in%20Wonderland', 'Book', ['publication year: 1865']],
            // data.ttl: "nineteen forty-five" (the SHACL error of the sample); graph.json still has 1945.
            ['Animal Farm', 'Animal%20Farm', 'Book', ['publication year: nineteen forty-five']],
            ['Nineteen Eighty-Four', 'Nineteen%20Eighty-Four', 'Book', ['publication year: 1949']],
            ['George Orwell', 'George%20Orwell', 'Author', ['birth date: 1903-06-25']],
            ['Lewis Carroll', 'Lewis%20Carroll', 'Author', ['birth date: 1832-01-27']],
            ['Tangamandapio', 'Tangamandapio', 'Concept', []],
            ['Little corner Bookshop', 'Wonderland%20Books%20(fictional)', 'Bookshop', []]
        ] as const;
        expect(instances.filter(e => e.type === 'node:card')).toHaveLength(expected.length);
        for (const [name, local, className, lines] of expected) {
            expect(named(instances, name)).toMatchObject({ type: 'node:card', element: id(local), className, lines });
        }
    });

    test('the seven placed relations have their fixture endpoints and labels', () => {
        const expected = [
            ['e18fafd4ac6d', 'Alice’s Adventures in Wonderland', 'ex:author', 'Lewis Carroll'],
            ['0900cf55c240', 'Animal Farm', 'ex:author', 'George Orwell'],
            ['ea2df5ac1c56', 'Nineteen Eighty-Four', 'ex:author', 'George Orwell'],
            ['74343fb0885b', 'Little corner Bookshop', 'ex:city', 'Tangamandapio'],
            ['360b79389761', 'Little corner Bookshop', 'ex:stocks', 'Alice’s Adventures in Wonderland'],
            ['04c647e16602', 'Little corner Bookshop', 'ex:stocks', 'Animal Farm'],
            ['d4266577fdac', 'Little corner Bookshop', 'ex:stocks', 'Nineteen Eighty-Four']
        ];
        const edges = instances.filter(e => e.type === 'edge:relation');
        expect(edges).toHaveLength(expected.length);
        for (const [placement, source, name, target] of expected) {
            expect(edges.find(e => e.id === id(`Bookshop/p/${placement}`))).toMatchObject({
                name, sourceId: named(instances, source).id, targetId: named(instances, target).id, hidden: false
            });
        }
    });

    test('notes, view references and arrows remain in both diagrams', () => {
        for (const [elements, target] of [[model, instancesIri], [instances, modelIri]] as const) {
            const note = elements.find(e => e.type === 'node:note')!;
            const reference = elements.find(e => e.type === 'node:view-reference')!;
            expect(note.text).toContain('follow the link');
            expect(reference.targetViewId).toBe(iriId(target));
            expect(elements.find(e => e.type === 'edge:arrow')).toMatchObject({ sourceId: note.id, targetId: reference.id });
        }
    });
});

describe('read builders', () => {
    test('registers shapes and data separately, and reads both view labels', () => {
        expect(graph.shapesGraphs().length).toBeGreaterThan(0);
        expect(graph.match(rdf.namedNode('urn:name:Bookshop%20shape')).every(q => graph.isShapesGraph(q.graph))).toBe(true);
        expect(graph.match(rdf.namedNode('urn:name:Animal%20Farm')).some(q => graph.isDataGraph(q.graph))).toBe(true);
        expect(viewLabels(graph)).toEqual({ [iriId(modelIri)]: 'Bookshop model', [iriId(instancesIri)]: 'Bookshop' });
        expect(scopedDoc({ g: graph, shapes: shapesIndexOf(graph).model }, { views: [iriId(instancesIri)] }).instances[id('Animal%20Farm')].label).toBe('Animal Farm');
    });

    test('quad helpers exclude views from instances and retain SKOS homes and label fallbacks', () => {
        const animal = 'urn:name:Animal%20Farm', city = 'urn:name:Tangamandapio';
        expect(inModelAmong(graph, [animal, modelIri])).toEqual(new Set([animal]));
        expect(instancesAmong(graph, [animal, city, modelIri])).toEqual(new Set([animal, city]));
        expect(homesAmong(graph, [animal]).get(animal)).toBe(graph.union.value);
        expect(labels(graph, [animal, city, 'urn:name:Absent']).get(animal)).toBe('Animal Farm');
        expect(labels(graph, [city, 'urn:name:Absent'])).toEqual(new Map([[city, 'Tangamandapio'], ['urn:name:Absent', 'Absent']]));
    });

    test('hidden-neighbour read includes a data change', () => {
        const g = graphOf(result, viewFiles).graph, shapes = shapesIndexOf(g).model;
        const view = readView(g, iriId(instancesIri), shapes).views[iriId(instancesIri)];
        const hidden = rdf.namedNode('urn:test:hidden'), animal = rdf.namedNode('urn:name:Animal%20Farm');
        g.update(() => {
            g.add(hidden, rdf.namedNode(NS.rdf + 'type'), rdf.namedNode('urn:example:bookshop:Book'), rdf.namedNode(dataGraphIri(`${FIXTURE}/data.ttl`)));
            g.add(hidden, rdf.namedNode('http://www.example.org/author'), animal, rdf.namedNode(dataGraphIri(`${FIXTURE}/data.ttl`)));
        });
        const full = hiddenNeighborCounts(g, shapes, view);
        expect(full.get(id('Animal%20Farm'))).toMatchObject({ in: 1, out: 0 });
    });

    test('accepts a view id without changing placements', async () => {
        const shown = (await diagramOf(ctx, iriId(modelIri))).schema;
        expect(shown.children!.filter(e => e.type === 'node:shape').map(e => e.id)).toEqual(model.filter(e => e.type === 'node:shape').map(e => e.id));
        expect((await diagramOf(ctx, 'urn:test:missing')).schema).toEqual({ type: 'graph', id: 'root', children: [] });
    });
});
