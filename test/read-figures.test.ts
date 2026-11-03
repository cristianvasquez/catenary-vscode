// Kata af1j: the notation figures from one turtle/query prefetch (fork binary over stdio) equal the old viewFiguresOf on test/fixtures/shapes.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Figure } from '../src/catenary/model/notation';
import { nkey } from '../src/catenary/model/notation-graph';
import type { ViewFigures } from '../src/catenary/model/notation-join';
import type { ModelGraph } from '../src/catenary/rdf/graph';
import { viewFiguresOf as oldViewFiguresOf } from '../src/catenary/rdf/notations';
import { graphOf } from '../src/model/graph-input';
import { modelFilesOf, viewFilesOf } from '../src/model/view-files';
import { roleDepth, viewFiguresOf, type PrefetchedFigures } from '../src/read/figures';
import { manifestOf } from '../src/read/manifest';
import { shapesModelOf } from '../src/read/shapes';
import { readNotations } from '../src/catenary/rdf/notations';
import type { GraphParams } from '../src/node/turtle-api';
import { FIXTURE } from './fixture-graph';
import { startServer } from './server';

const file = (name: string) => join(FIXTURE, name);
/** Triples of the six fixture documents (port.test.ts). */
const TRIPLES = 282;
const VIEWS = ['urn:name:Bookshop%20model', 'urn:name:Bookshop'];

const isFigure = (x: object): x is Figure => 'fs' in x && 'focus' in x && 'placedAs' in x;

/** A view's figures as data: a figure inside another value is its id, a figure shape is its node, the index of the derivation is left out. */
function plain(vf: ViewFigures): unknown {
    const value = (x: unknown, top = false): unknown => {
        if (Array.isArray(x)) return x.map(v => value(v));
        if (x instanceof Map) return [...x].map(([k, v]) => [k, value(v)]);
        if (!x || typeof x !== 'object') return x;
        if (isFigure(x) && !top) return `figure ${x.id}`;
        return Object.fromEntries(Object.entries(x).filter(([k, v]) => k !== 'data' && v !== undefined)
            .map(([k, v]) => [k, k === 'fs' ? nkey((v as Figure['fs']).node) : value(v)]));
    };
    const { derivation, placed, join } = vf;
    return {
        derivation: { figures: derivation.figures.map(f => value(f, true)), warnings: derivation.warnings },
        placed: value(placed),
        join: value(join)
    };
}

/** The params of the recorded turtle/graph answer: the old pipeline reads the same answer from the server under test. */
const graphParams = () => (JSON.parse(readFileSync(file('graph.json'), 'utf8')) as { params: GraphParams }).params;

/** The model files of a folder, the shapes model, and the old graph over the turtle/graph answer of the same server. */
async function inputsOf(server: Awaited<ReturnType<typeof startServer>>, folder: string) {
    const port = server.port();
    const rdfFiles = readdirSync(folder).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(f => join(folder, f));
    const views = await viewFilesOf(port, rdfFiles.filter(f => f.endsWith('.trig')));
    const modelFiles = modelFilesOf(rdfFiles, views);
    const shapes = await shapesModelOf(port, modelFiles, await manifestOf(port, modelFiles));
    const graph = graphOf(await server.graph(graphParams()), [...views.views.values()]).graph;
    return { port, modelFiles, shapes, graph };
}

describe('viewFiguresOf over one prefetch on test/fixtures/shapes', () => {
    let server: Awaited<ReturnType<typeof startServer>>, graph: ModelGraph;
    const now = new Map<string, PrefetchedFigures>();
    beforeAll(async () => {
        server = await startServer(FIXTURE, TRIPLES);
        // The old pipeline over the turtle/graph answer of the same server: the recorded graph.json is older than data.ttl.
        const { port, modelFiles, shapes, graph: g } = await inputsOf(server, FIXTURE);
        graph = g;
        for (const v of VIEWS) now.set(v, await viewFiguresOf(port, v, shapes, modelFiles));
    }, 20000);
    afterAll(async () => { await server?.stop(); });

    test('D, the longest role path of the built-in notations, is 5', () => {
        expect(roleDepth(readNotations())).toBe(5);
    });

    test.each(VIEWS)('%s: figures, placements and join equal the old viewFiguresOf; no read outside the prefetch', view => {
        const old = oldViewFiguresOf(graph, view), got = now.get(view)!;
        expect(old.derivation.figures.length).toBeGreaterThan(0);
        expect(old.placed.size).toBeGreaterThan(0);
        expect(plain(got)).toEqual(plain(old));
        expect(got.misses).toBe(0);
    });
});


describe('viewFiguresOf reads blank nodes through their anchors (temp folder)', () => {
    const EX = 'http://example.org/', VIEW = 'urn:name:People';
    const head = `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix ex: <${EX}> .
@prefix view: <https://cristianvasquez.github.io/catenary/vocab/view#> .
`;
    const files = {
        'shapes.ttl': `${head}ex:PersonShape a sh:NodeShape ; sh:targetClass ex:Person ; sh:property ex:PersonShape-knows .
ex:PersonShape-knows sh:path ex:knows ; sh:name "knows" .
`,
        'data.ttl': `${head}ex:alice a ex:Person ; rdfs:label "Alice" ; ex:knows [ a ex:Person ; rdfs:label "Bob" ; ex:knows [ rdfs:label "Carol" ] ] .
`,
        'people.trig': `${head}<${VIEW}> { <${VIEW}> a view:View . <${VIEW}/p/1> a view:Placement ; view:element ex:alice ; view:view <${VIEW}> . }
`
    };
    let dir: string, server: Awaited<ReturnType<typeof startServer>>, inputs: Awaited<ReturnType<typeof inputsOf>>;
    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'catenary-figures-'));
        for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
        server = await startServer(dir, 16);
        inputs = await inputsOf(server, dir);
    }, 20000);
    afterAll(async () => {
        await server?.stop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    test('a gathered link to a labelled blank-node instance reads its label; equal to the old viewFiguresOf; no miss', async () => {
        const got = await viewFiguresOf(inputs.port, VIEW, inputs.shapes, inputs.modelFiles), old = oldViewFiguresOf(inputs.graph, VIEW);
        const alice = got.join.boxes.find(b => b.figure.focus.value === `${EX}alice`);
        expect(alice?.rows.map(r => r.text)).toContain('knows: Bob');
        expect(plain(got)).toEqual(plain(old));
        expect(got.misses).toBe(0);
    });
});
