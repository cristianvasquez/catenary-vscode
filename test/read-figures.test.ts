// Kata af1j: the notation figures from one turtle/query prefetch (fork binary over stdio) equal the old viewFiguresOf on test/fixtures/shapes.
import { readFileSync, readdirSync } from 'node:fs';
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

describe('viewFiguresOf over one prefetch on test/fixtures/shapes', () => {
    let server: Awaited<ReturnType<typeof startServer>>, graph: ModelGraph;
    const now = new Map<string, PrefetchedFigures>();
    beforeAll(async () => {
        server = await startServer(FIXTURE, TRIPLES);
        const port = server.port();
        const rdfFiles = readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(file);
        const modelFiles = modelFilesOf(rdfFiles, await viewFilesOf(port, rdfFiles.filter(f => f.endsWith('.trig'))));
        const shapes = await shapesModelOf(port, modelFiles, await manifestOf(port, modelFiles));
        for (const v of VIEWS) now.set(v, await viewFiguresOf(port, v, shapes, modelFiles));
        // The old pipeline over the turtle/graph answer of the same server: the recorded graph.json is older than data.ttl.
        const { params } = JSON.parse(readFileSync(file('graph.json'), 'utf8')) as { params: GraphParams };
        graph = graphOf(await server.graph(params), ['instances.trig', 'model.trig'].map(file)).graph;
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

