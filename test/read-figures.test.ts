// Kata af1j: the notation figures from one turtle/query prefetch (fork binary over stdio), against the values of the old viewFiguresOf
// (recorded before K11 deleted it: test/fixtures/expected/read-figures.json).
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Figure } from '../src/catenary/model/notation';
import { nkey } from '../src/catenary/model/notation-graph';
import type { ViewFigures } from '../src/catenary/model/notation-join';
import type { ModelPort } from '../src/model/port';
import { modelFilesOf, viewFilesOf } from '../src/model/view-files';
import { viewFiguresOf, type PrefetchedFigures } from '../src/read/figures';
import { manifestOf } from '../src/read/manifest';
import { shapesModelOf } from '../src/read/shapes';
import { FIXTURE, startServer } from './server';
import { json, recorded } from './expected';

const R = recorded('read-figures');

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

/** The model files of a folder and the shapes model. */
async function inputsOf(server: Awaited<ReturnType<typeof startServer>>, folder: string) {
    const port = server.port();
    const rdfFiles = readdirSync(folder).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(f => join(folder, f));
    const views = await viewFilesOf(port, rdfFiles.filter(f => f.endsWith('.trig')));
    const modelFiles = modelFilesOf(rdfFiles, views);
    const shapes = await shapesModelOf(port, modelFiles, await manifestOf(port, modelFiles));
    return { port, modelFiles, shapes, views: views.views };
}

describe('viewFiguresOf over one prefetch on test/fixtures/shapes', () => {
    let server: Awaited<ReturnType<typeof startServer>>;
    const now = new Map<string, PrefetchedFigures>(), sent = new Map<string, string[]>();
    beforeAll(async () => {
        server = await startServer(FIXTURE, TRIPLES);
        const { port, modelFiles, shapes, views } = await inputsOf(server, FIXTURE);
        for (const v of VIEWS) {
            // The port, with every query text that the prefetch sends recorded.
            const texts: string[] = [];
            const recording: ModelPort = {
                select: (q, f) => { texts.push(q); return port.select(q, f); },
                construct: (q, f) => { texts.push(q); return port.construct(q, f); },
                ask: (q, f) => { texts.push(q); return port.ask(q, f); }
            };
            now.set(v, await viewFiguresOf(recording, v, views.get(v)!, shapes, modelFiles));
            sent.set(v, texts);
        }
    }, 20000);
    afterAll(async () => { await server?.stop(); });

    test('urn:name:Bookshop%20model: at most two fixed queries plus three rounds, under 64 KB; no blank-node dump', () => {
        const texts = sent.get(VIEWS[0])!, lengths = texts.map(t => Buffer.byteLength(t));
        expect(texts.length).toBeLessThanOrEqual(2 + 3);
        expect(Math.max(...lengths)).toBeLessThan(64 * 1024);
        // A lone FILTER (isBlank(?s)) reads every blank-node statement; a closure branch filters ?s with the nodes below it.
        expect(texts.filter(t => /isBlank\(\?s\)\s*\)/.test(t))).toEqual([]);
    });

    test.each(VIEWS)('%s: figures, placements and join equal the recorded viewFiguresOf; no read outside the prefetch', view => {
        const got = now.get(view)!;
        expect(got.derivation.figures.length).toBeGreaterThan(0);
        expect(got.placed.size).toBeGreaterThan(0);
        expect(json(plain(got))).toEqual(R(view));
        expect(got.misses).toBe(0);
    });
});


describe('viewFiguresOf reads blank nodes under their owner (temp folder)', () => {
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

    test('an incoming blank-node concept keeps its type and label in the scheme rows', async () => {
        const folder = mkdtempSync(join(tmpdir(), 'catenary-scheme-'));
        let schemeServer: Awaited<ReturnType<typeof startServer>> | undefined;
        try {
            writeFileSync(join(folder, 'data.ttl'), `${head}
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
ex:scheme a skos:ConceptScheme .
[ a skos:Concept ; skos:prefLabel "Example" ; skos:inScheme ex:scheme ] .
`);
            writeFileSync(join(folder, 'scheme.trig'), `${head}
<${VIEW}> { <${VIEW}> a view:View . <${VIEW}/p/1> a view:Placement ; view:element ex:scheme ; view:view <${VIEW}> . }
`);
            schemeServer = await startServer(folder, 8);
            const input = await inputsOf(schemeServer, folder);
            const got = await viewFiguresOf(input.port, VIEW, input.views.get(VIEW)!, input.shapes, input.modelFiles);
            const scheme = got.join.boxes.find(b => b.figure.focus.value === `${EX}scheme`);
            expect(scheme?.rows.map(r => r.text)).toContain('Example');
            expect(got.misses).toBe(0);
        } finally {
            await schemeServer?.stop();
            rmSync(folder, { recursive: true, force: true });
        }
    });

    test('a gathered link to a labelled blank-node instance reads its label; equal to the recorded viewFiguresOf; no miss', async () => {
        const got = await viewFiguresOf(inputs.port, VIEW, inputs.views.get(VIEW)!, inputs.shapes, inputs.modelFiles);
        const alice = got.join.boxes.find(b => b.figure.focus.value === `${EX}alice`);
        expect(alice?.rows.map(r => r.text)).toContain('knows: Bob');
        expect(json(plain(got))).toEqual(R('anchors'));
        expect(got.misses).toBe(0);
    });
});
