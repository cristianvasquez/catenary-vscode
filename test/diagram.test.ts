// Kata 8twe: the diagram of each fixture view from turtle/query (fork binary over stdio), against the expected schemas and against the
// schemas of diagramOf of the old pipeline (recorded before K11 deleted it: test/fixtures/expected/diagram.json).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { diagramOf, drawFromText, completeDrawing, keepGeometry, type ModelContext, modelContextOf } from '../src/read/diagram';
import type { ElementSchema } from '../src/catenary/model/diagram-schema';
import { iriId } from '../src/catenary/model/ids';
import { hiddenNeighborCounts } from '../src/read/neighbors';
import { scopedDoc } from '../src/read/scope';
import { viewLabelsOf } from '../src/read/view';
import { recorded } from './expected';
import { FIXTURE, startServer } from './server';

const R = recorded('diagram');

const modelIri = 'urn:name:Bookshop%20model', instancesIri = 'urn:name:Bookshop';
/** Triples of the six fixture documents (port.test.ts). */
const TRIPLES = 282;
const id = (local: string) => iriId(`urn:name:${local}`);
let server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext;
let model: ElementSchema[], instances: ElementSchema[];
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
}, 20000);
afterAll(async () => { await server?.stop(); });

describe('the recorded schemas of the old pipeline', () => {
    test.each([modelIri, instancesIri])('%s: the schema is byte-identical to the recorded diagramOf of the old pipeline on the same files', async iri => {
        expect(JSON.stringify((await diagramOf(ctx, iri)).schema)).toBe(R(iri));
    });

    test('the context reads its documents only: a view file of another folder is not drawn', async () => {
        const others = readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f) && f !== 'instances.trig').sort().map(f => join(FIXTURE, f));
        const { ctx: without } = await modelContextOf(server.port(), others);
        expect((await diagramOf(without, instancesIri)).schema).toEqual({ type: 'graph', id: 'root', children: [] });
        // The model view keeps its shapes; its reference to the instances view (and the arrow to it) is gone with that view.
        const shapes = (elements: ElementSchema[]) => elements.filter(e => e.type === 'node:shape').map(e => e.id);
        expect(shapes((await diagramOf(without, modelIri)).schema.children!)).toEqual(shapes(model));
    });
});

describe('two-phase drawing', () => {
    test.each([modelIri, instancesIri])('%s: phase 1 sends zero requests and completion equals the recorded schema', async iri => {
        const full = await diagramOf(ctx, iri);
        let requests = 0;
        const port = {
            select: (...args: Parameters<ModelContext['port']['select']>) => { requests++; return ctx.port.select(...args); },
            construct: (...args: Parameters<ModelContext['port']['construct']>) => { requests++; return ctx.port.construct(...args); },
            ask: (...args: Parameters<ModelContext['port']['ask']>) => { requests++; return ctx.port.ask(...args); }
        };
        const text = readFileSync(ctx.views.get(iri)!, 'utf8');
        const first = drawFromText({ ...ctx, port }, iri, text, full.kept);
        expect(requests).toBe(0);
        const geometry = (schema: ElementSchema) => schema.children!.map(e => ({ id: e.id, position: e.position, size: e.size, vertices: e.vertices }));
        expect(geometry(first.drawn.schema)).toEqual(geometry(full.schema));
        const final = await completeDrawing({ ...ctx, port }, iri, first.drawn, first.misses);
        expect(JSON.stringify(final.schema)).toBe(R(iri));
        expect(keepGeometry(final.schema, first.drawn.schema)).toEqual(final.schema);
    });

    test('completion copies layout by id, not by element order', () => {
        const base: ElementSchema = { type: 'graph', id: 'root', children: [{ type: 'node:card', id: 'a', position: { x: 9, y: 8 }, size: { width: 700, height: 400 } }, { type: 'edge:relation', id: 'b', vertices: [{ x: 11, y: 12 }] }] };
        const final: ElementSchema = { type: 'graph', id: 'root', children: [{ type: 'edge:relation', id: 'b', vertices: [] }, { type: 'node:card', id: 'a', name: 'updated', position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }] };
        expect(keepGeometry(final, base).children).toEqual([{ ...final.children![0], vertices: base.children![1].vertices }, { ...final.children![1], position: base.children![0].position, size: base.children![0].size }]);
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
            // data.ttl: "nineteen forty-five" (the SHACL error of the sample).
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
    test('reads both view labels and the label of an instance of a view', async () => {
        expect(await viewLabelsOf(ctx.port, ctx.views, ctx.manifest.language, ctx.viewLabels)).toEqual({ [iriId(modelIri)]: 'Bookshop model', [iriId(instancesIri)]: 'Bookshop' });
        expect((await scopedDoc(ctx, { views: [iriId(instancesIri)] })).instances[id('Animal%20Farm')].label).toBe('Animal Farm');
    });

    test('hidden-neighbour read includes a data change (the open buffer of data.ttl)', async () => {
        const uri = pathToFileURL(join(FIXTURE, 'data.ttl')).href, text = readFileSync(join(FIXTURE, 'data.ttl'), 'utf8');
        const view = (await diagramOf(ctx, iriId(instancesIri))).doc.views[iriId(instancesIri)];
        const before = await hiddenNeighborCounts(ctx.port, ctx.modelFiles, ctx.shapes, view);
        expect(before.get(id('Animal%20Farm'))).toMatchObject({ in: 0 });
        server.open(uri, text);
        server.change(uri, `${text}\n<urn:test:hidden> a <urn:example:bookshop:Book> ; <http://www.example.org/author> <urn:name:Animal%20Farm> .\n`);
        try {
            expect((await hiddenNeighborCounts(ctx.port, ctx.modelFiles, ctx.shapes, view)).get(id('Animal%20Farm'))).toMatchObject({ in: 1, out: 0 });
        } finally {
            server.change(uri, text);
        }
    });

    test('accepts a view id without changing placements', async () => {
        const shown = (await diagramOf(ctx, iriId(modelIri))).schema;
        expect(shown.children!.filter(e => e.type === 'node:shape').map(e => e.id)).toEqual(model.filter(e => e.type === 'node:shape').map(e => e.id));
        expect((await diagramOf(ctx, 'urn:test:missing')).schema).toEqual({ type: 'graph', id: 'root', children: [] });
    });
});
