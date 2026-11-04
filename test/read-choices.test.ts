// Kata dxwx: the pickers from turtle/query (fork binary over stdio) on test/fixtures/shapes, against the values of model/choices.ts of the
// old pipeline (recorded before K11 deleted it: test/fixtures/expected/read-choices.json).
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { iriId } from '../src/catenary/model/ids';
import { expandChoices, instanceLabels, instancesNamed, memberOptions } from '../src/read/choices';
import { type ModelContext, modelContextOf } from '../src/read/diagram';
import { scopedDoc } from '../src/read/scope';
import { viewDocOf } from '../src/read/view';
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
    const idsOf = async (viewIri: string) => {
        const view = (await viewDocOf(ctx.port, ctx.views, viewIri, ctx.shapes, ctx.manifest, { viewLabels: ctx.viewLabels })).views[iriId(viewIri)];
        return [...new Set([...view.boxes.map(b => b.id), ...view.boxes.flatMap(b => b.kind === 'card' ? [b.element] : []), ...view.edges.flatMap(e => e.id ? [e.id, e.relation] : [e.relation])])];
    };

    test.each(VIEWS)('%s: expandChoices in, out and targets of every box, edge and element equal the recorded ones', async viewIri => {
        const vid = iriId(viewIri), ids = await idsOf(viewIri);
        expect(ids.length).toBeGreaterThan(5);
        expect(ids).toEqual(R(`ids ${viewIri}`));
        let some = 0;
        for (const from of ids) for (const dir of ['in', 'out', 'targets'] as const) {
            const now = await expandChoices(ctx, vid, from, dir);
            if (now) some++;
            expect(json(now ?? null), `${from} ${dir}`).toEqual(R(`expand ${viewIri} ${from} ${dir}`));
        }
        expect(some).toBeGreaterThan(0);
    });

    test.each(VIEWS)('%s: scopedDoc with neighbors and with showing equals the recorded one', async viewIri => {
        const vid = iriId(viewIri);
        for (const from of (await idsOf(viewIri)).slice(0, 8)) {
            for (const scope of [{ elements: [from], neighbors: true, views: [vid] }, { elements: [from], showing: true, selectionViews: [vid] }]) {
                const now = await scopedDoc(ctx, scope);
                expect(json({ views: now.views, instances: now.instances, relations: now.relations }), from)
                    .toEqual(R(`scoped ${viewIri} ${from} ${'neighbors' in scope ? 'neighbors' : 'showing'}`));
            }
        }
    });

    test('instanceLabels, memberOptions and instancesNamed equal the recorded ones', async () => {
        const labels = await instanceLabels(ctx);
        expect(labels.size).toBeGreaterThan(5);
        expect(labels.get('urn:name:Animal%20Farm')).toBe('Animal Farm');
        for (const viewIri of VIEWS) for (const collection of ['none', ...await idsOf(viewIri)]) {
            expect(await memberOptions(ctx, iriId(viewIri), collection)).toEqual(R(`members ${viewIri} ${collection}`));
        }
        for (const text of ['Animal Farm', 'George Orwell', 'urn:name:Animal%20Farm', 'nothing', ...labels.values()]) {
            expect((await instancesNamed(ctx, text)).sort()).toEqual(R(`named ${text}`));
        }
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
