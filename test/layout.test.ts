import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { iriId } from '../src/catenary/model/ids';
import { graphOf } from '../src/model/graph-input';
import { instancesNamed, memberOptions } from '../src/read/choices';
import { type ModelContext, modelContextOf } from '../src/read/diagram';
import { ViewStore } from './view-store';
import { layoutView } from '../src/node/glsp/layout';
import type { GraphResult } from '../src/node/turtle-api';
import { readView } from '../src/catenary/rdf/view-read';
import { shapesIndexOf } from '../src/catenary/rdf/shapes-read';
import { FIXTURE, fixtureGraph } from './fixture-graph';
import { startServer } from './server';

const result = fixtureGraph();
const files = ['instances', 'model'].map(f => resolve(`test/fixtures/shapes/${f}.trig`));
const vid = iriId('urn:name:Bookshop');

test.each(['layered', 'force'] as const)('Apply Layout %s: new boxes for the cards, one store step that undoes', async algorithm => {
    const store = new ViewStore(graphOf(result, files).graph);
    const part = readView(store.graph, vid, shapesIndexOf(store.graph).model);
    const { bounds } = await layoutView(part, vid, algorithm);
    const before = part.views[vid].boxes;
    expect(bounds.length).toBe(before.length);
    expect(bounds.some(b => { const o = before.find(x => x.id === b.id)!; return o.x !== b.x || o.y !== b.y; })).toBe(true);
    const text = store.viewText('urn:name:Bookshop');
    expect(store.execute({ kind: 'setLayout', view: vid, bounds })).toMatchObject({ ok: true });
    expect(store.viewText('urn:name:Bookshop')).not.toBe(text);
    store.graph.undo(store.last!);
    expect(store.viewText('urn:name:Bookshop')).toBe(text);
});

describe('"+ member" from turtle/query (fork binary over stdio, kata dxwx)', () => {
    /** Triples of the six fixture documents (port.test.ts). */
    const TRIPLES = 282;
    let server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext;
    beforeAll(async () => {
        server = await startServer(FIXTURE, TRIPLES);
        ctx = (await modelContextOf(server.port(), readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(f => join(FIXTURE, f)))).ctx;
    }, 20000);
    afterAll(async () => { await server?.stop(); });

    test('the options leave out the members; a label gives one instance', async () => {
        const store = new ViewStore(graphOf(result, files).graph);
        const ids = await instancesNamed(ctx, 'Animal Farm');
        expect(ids).toHaveLength(1);
        const options = await memberOptions(ctx, vid, 'none');
        expect(options).toContain('Animal Farm');
        const id = (store.execute({ kind: 'collect', view: vid, ids }) as { value: string }).value;
        // The store's view text to the server, as the editor sends its document.
        server.open(pathToFileURL(files[0]).href, store.viewText('urn:name:Bookshop'), 'trig');
        expect(await memberOptions(ctx, vid, id)).not.toContain('Animal Farm');
        expect(await memberOptions(ctx, vid, id)).toContain('George Orwell');
    });
});
