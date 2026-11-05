// Kata dxwx: the pickers from turtle/query (turtle-lsp binary over stdio) on test/fixtures/shapes, against the values of model/choices.ts of the
// old pipeline (recorded before K11 deleted it: test/fixtures/expected/read-choices.json).
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { iriId } from '../src/catenary/model/ids';
import { expandChoices, instanceLabels, instancesNamed, memberOptions } from '../src/read/choices';
import { type ModelContext, modelContextOf, viewDocRead } from '../src/read/diagram';
import { shapeTargetMatches } from '../src/read/targets';
import { relationTriple } from '../src/catenary/rdf/ids';
import { neighborChoices } from '../src/catenary/model/prompts';
import type { ModelPort } from '../src/model/port';
import { json, recorded } from './expected';
import { FIXTURE, startServer } from './server';

const R = recorded('read-choices');

/** Triples of the six fixture documents (port.test.ts). */
const TRIPLES = 282;
const VIEWS = ['urn:name:Bookshop', 'urn:name:Bookshop%20model'];

describe('pickers on test/fixtures/shapes', () => {
    let server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext;
    beforeAll(async () => {
        server = await startServer(FIXTURE, TRIPLES);
        ctx = (await modelContextOf(server.port(), readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(f => join(FIXTURE, f)))).ctx;
    }, 20000);
    afterAll(async () => { await server?.stop(); });

    /** Every box and edge id of the view, and the elements of its cards. */
    /** The text of the view file of `viewIri`. */
    const textOf = (viewIri: string) => readFileSync(ctx.views.get(viewIri)!, 'utf8');

    const idsOf = async (viewIri: string) => {
        const view = (await viewDocRead(ctx, viewIri)).views[iriId(viewIri)];
        return [...new Set([...view.boxes.map(b => b.id), ...view.boxes.flatMap(b => b.kind === 'card' ? [b.element] : []), ...view.edges.flatMap(e => e.id ? [e.id, e.relation] : [e.relation])])];
    };

    test.each(VIEWS)('%s: expandChoices in, out and targets of every box, edge and element equal the recorded ones', async viewIri => {
        const vid = iriId(viewIri), ids = await idsOf(viewIri), text = textOf(viewIri);
        expect(ids.length).toBeGreaterThan(5);
        expect(ids).toEqual(R(`ids ${viewIri}`));
        let some = 0;
        for (const from of ids) for (const dir of ['in', 'out', 'targets'] as const) {
            const now = await expandChoices(ctx, vid, text, from, dir);
            if (now) some++;
            expect(json(now ?? null), `${from} ${dir}`).toEqual(R(`expand ${viewIri} ${from} ${dir}`));
        }
        expect(some).toBeGreaterThan(0);
    });

    /** `ctx` with a port that counts its requests. */
    const counting = () => {
        const counted = { n: 0 }, port: ModelPort = {
            select: (q, f) => { counted.n++; return ctx.port.select(q, f); },
            construct: (q, f) => { counted.n++; return ctx.port.construct(q, f); },
            ask: (q, f) => { counted.n++; return ctx.port.ask(q, f); },
        };
        return { counted, ctx: { ...ctx, port } };
    };

    test.each(VIEWS)('%s: expand in and out of an instance card send one request; of a node shape none; targets the walk plus at most one', async viewIri => {
        const vid = iriId(viewIri), text = textOf(viewIri);
        const view = (await viewDocRead(ctx, viewIri));
        const counts: Record<string, number[]> = { instance: [], shape: [], targets: [], walk: [] };
        for (const card of view.views[vid].boxes.flatMap(b => b.kind === 'card' ? [b] : [])) {
            const instance = view.instances[card.element], shape = ctx.shapes.index.model.nodeShapes[card.element];
            if (!instance && !shape) continue;
            for (const dir of ['in', 'out'] as const) {
                const c = counting();
                await expandChoices(c.ctx, vid, text, card.id, dir);
                counts[instance ? 'instance' : 'shape'].push(c.counted.n);
            }
            const c = counting(), w = counting();
            await expandChoices(c.ctx, vid, text, card.id, 'targets');
            await shapeTargetMatches(w.ctx.port, ctx.modelFiles, ctx.shapes, shape ? { shapes: [shape.uri] } : { nodes: [{ termType: 'NamedNode', value: instance.uri }] });
            counts.targets.push(c.counted.n);
            counts.walk.push(w.counted.n);
        }
        console.log(`1nkh ${viewIri}: requests ${JSON.stringify(counts)}`);
        expect(counts.instance.length + counts.shape.length).toBeGreaterThan(0);
        for (const n of counts.instance) expect(n).toBe(1);
        for (const n of counts.shape) expect(n).toBe(0);
        counts.targets.forEach((n, i) => expect(n).toBeLessThanOrEqual(counts.walk[i] + 1));
    });

    test.each(VIEWS)('%s: the neighbours of the one-request picker are among the statements around the card (model documents)', async viewIri => {
        const vid = iriId(viewIri), text = textOf(viewIri);
        const view = (await viewDocRead(ctx, viewIri));
        let some = 0;
        for (const card of view.views[vid].boxes.flatMap(b => b.kind === 'card' && view.instances[b.element] ? [b] : [])) {
            const iri = view.instances[card.element].uri;
            const around = await ctx.port.select(`SELECT ?s ?o ?direction WHERE { { <${iri}> ?p ?o BIND ("out" AS ?direction) } UNION { ?s ?p <${iri}> BIND ("in" AS ?direction) } }`, ctx.modelFiles);
            for (const dir of ['in', 'out'] as const) {
                const ends = new Set(around.filter(r => r.direction.value === dir).map(r => (dir === 'out' ? r.o : r.s).value));
                for (const item of (await expandChoices(ctx, vid, text, card.id, dir))?.items ?? []) for (const id of item.ids) {
                    const t = relationTriple(id)!;
                    expect(ends.has((dir === 'out' ? t.o : t.s).value), `${iri} ${dir} ${id}`).toBe(true);
                    some++;
                }
            }
        }
        expect(some).toBeGreaterThan(0);
    });

    test('every model IRI subject is a picker candidate, excluding shapes-only subjects (decision 6-A): recorded members and names', async () => {
        const labels = await instanceLabels(ctx);
        expect(labels.size).toBeGreaterThan(5);
        expect(labels.get('urn:name:Animal%20Farm')).toBe('Animal Farm');
        for (const subject of ctx.shapes.shapeSubjects) expect(labels.has(subject.slice(1, -1))).toBe(false);
        const vocabulary = await instanceLabels(ctx, { vocabulary: true });
        expect(vocabulary.get('urn:name:Tanganana')).toBe('Tanganana');
        expect(vocabulary.get('urn:name:Tangamandapio')).toBe('Tangamandapio');
        expect(vocabulary.get('urn:name:unnamed%20collection%201')).toBe('Cities');
        for (const viewIri of VIEWS) for (const collection of ['none', ...await idsOf(viewIri)]) {
            expect(await memberOptions(ctx, iriId(viewIri), textOf(viewIri), collection)).toEqual(R(`members ${viewIri} ${collection}`));
        }
        for (const text of ['Animal Farm', 'George Orwell', 'urn:name:Animal%20Farm', 'nothing', ...labels.values()]) {
            expect((await instancesNamed(ctx, text)).sort()).toEqual(R(`named ${text}`));
        }
    });
});

describe('neighbour picker without SHACL', () => {
    const folder = join(FIXTURE, '..', 'no-shacl'), view = 'urn:name:People';
    let server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext;
    const text = () => readFileSync(join(folder, 'view.trig'), 'utf8');
    beforeAll(async () => {
        server = await startServer(folder, 53);
        ctx = (await modelContextOf(server.port(), ['data.ttl', 'view.trig'].map(f => join(folder, f)))).ctx;
    }, 20000);
    afterAll(async () => { await server?.stop(); });

    test('decision 6-A: pickers list every model IRI subject, not object-only IRIs, blank nodes or view subjects, in one query', async () => {
        let requests = 0;
        const port: ModelPort = { ...ctx.port, select: (q, f) => { requests++; return ctx.port.select(q, f); } };
        const labels = await instanceLabels({ ...ctx, port });
        expect([...labels]).toEqual([
            ['http://ex.org/alice', 'Alice'], ['http://ex.org/bob', 'bob'], ['http://ex.org/carol', 'Carol'],
            ['http://ex.org/dan', 'dan'], ['http://ex.org/eve', 'eve'], ['http://ex.org/paris', 'paris'],
        ]);
        expect(requests).toBe(1);
        expect([...await instanceLabels(ctx, { vocabulary: true })]).toEqual([...labels]);
        expect(await memberOptions(ctx, iriId(view), text(), 'none')).toEqual(['Alice', 'Carol', 'bob', 'dan', 'eve', 'paris']);
        expect(await instancesNamed(ctx, 'eve')).toEqual([iriId('http://ex.org/eve')]);
        expect(await instancesNamed(ctx, 'http://ex.org/paris')).toEqual([iriId('http://ex.org/paris')]);
        expect(await instancesNamed(ctx, 'http://ex.org/acme')).toEqual([]);
    });

    test.each([
        ['alice', 'out', ['acme', 'bob', 'carol', 'paris']],
        ['alice', 'in', ['dan', 'eve']],
        ['paris', 'in', ['alice']],
    ] as const)('%s %s lists every IRI neighbour without an instance test', async (from, dir, expected) => {
        const choices = await expandChoices(ctx, iriId(view), text(), iriId(`http://ex.org/${from}`), dir);
        const ends = choices?.items.flatMap(i => i.ids.map(id => {
            const triple = relationTriple(id)!;
            return (dir === 'out' ? triple.o : triple.s).value.replace('http://ex.org/', '');
        })).sort();
        expect(ends).toEqual(expected);
        expect(choices?.title).toContain(`(${expected.length} hidden)`);
    });

    test('caps the picker at 200 while retaining the exact hidden count', async () => {
        const doc = await viewDocRead(ctx, view), vid = iriId(view), self = iriId('http://ex.org/alice');
        doc.relations = {};
        for (let i = 0; i < 612; i++) {
            const uri = `urn:test:neighbor:${i}`, id = iriId(uri);
            doc.instances[id] = { id, uri, label: `Neighbour ${i}`, types: [], fields: {} };
            doc.relations[`relation-${i}`] = { id: `relation-${i}`, subject: self, predicate: 'http://ex.org/knows', object: id };
        }
        const choices = neighborChoices(doc, ctx.shapes.meta, vid, self, 'out');
        expect(choices?.title).toBe('Alice: outgoing (612 hidden, 200 listed)');
        expect(choices?.items).toHaveLength(200);
    });
});

describe('the insert picker candidates', () => {
    let folder: string, server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext;
    beforeAll(async () => {
        folder = mkdtempSync(join(tmpdir(), 'catenary-dxwx-'));
        // A SKOS concept whose statements are all in the shapes closure (an sh: predicate), and an instance.
        writeFileSync(join(folder, 'vocabulary.ttl'), `@prefix skos: <http://www.w3.org/2004/02/skos/core#> . @prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:x:c> a skos:Concept ; sh:order 1 ; skos:prefLabel "Concept C" .
<urn:x:i> a <urn:x:T> ; <http://www.w3.org/2000/01/rdf-schema#label> "Instance I" .
`);
        server = await startServer(folder, 5);
        ctx = (await modelContextOf(server.port(), [join(folder, 'vocabulary.ttl')])).ctx;
    }, 20000);
    afterAll(async () => { await server?.stop(); rmSync(folder, { recursive: true, force: true }); });

    test('a SKOS subject of the shapes only: not an instance of the model, a candidate of the insert picker with its label', async () => {
        expect([...await instanceLabels(ctx)]).toEqual([['urn:x:i', 'Instance I']]);
        expect([...await instanceLabels(ctx, { vocabulary: true })]).toEqual([['urn:x:c', 'Concept C'], ['urn:x:i', 'Instance I']]);
    });
});

describe('a subject of the shapes with data statements', () => {
    let folder: string, server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext;
    const head = `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <http://example.org/> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix view: <https://cristianvasquez.github.io/catenary/vocab/view#> .`;
    const view = 'urn:test:view';
    const text = `${head} <${view}> { <${view}> a view:View . ex:pa a view:Placement ; view:element ex:a ; view:view <${view}> . }`;
    beforeAll(async () => {
        folder = mkdtempSync(join(tmpdir(), 'catenary-1nkh-'));
        writeFileSync(join(folder, 'shapes.ttl'), `${head} ex:X a sh:NodeShape ; sh:targetClass ex:Thing .`);
        writeFileSync(join(folder, 'data.ttl'), `${head} ex:a a ex:Thing ; ex:rel ex:X . ex:X a ex:Thing ; rdfs:label "X data" .`);
        writeFileSync(join(folder, 'view.trig'), text);
        server = await startServer(folder, 10);
        ctx = (await modelContextOf(server.port(), ['data.ttl', 'shapes.ttl', 'view.trig'].map(f => join(folder, f)))).ctx;
    }, 20000);
    afterAll(async () => { await server?.stop(); rmSync(folder, { recursive: true, force: true }); });

    test('is an instance by its data statements: a neighbour of the out picker, with its data label', async () => {
        expect(ctx.shapes.shapeSubjects.has('<http://example.org/X>')).toBe(true);
        const choices = await expandChoices(ctx, iriId(view), text, iriId('http://example.org/a'), 'out');
        expect(choices?.items.map(i => i.label)).toEqual(['X data']);
    });
});
