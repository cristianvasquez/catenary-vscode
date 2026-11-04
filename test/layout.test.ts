import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { iriId } from '../src/catenary/model/ids';
import { layoutView } from '../src/node/glsp/layout';
import { instancesNamed, memberOptions } from '../src/read/choices';
import { diagramOf, type ModelContext, modelContextOf } from '../src/read/diagram';
import { FIXTURE, startServer } from './server';
import { type ViewDocuments, viewDocuments } from './views';

/** Triples of the six fixture documents (port.test.ts). */
const TRIPLES = 282;
const view = 'urn:name:Bookshop', vid = iriId(view);

describe('the instances view on the turtle-lsp binary over stdio', () => {
    let server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext, docs: ViewDocuments;
    beforeAll(async () => {
        server = await startServer(FIXTURE, TRIPLES);
        ctx = (await modelContextOf(server.port(), readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(f => join(FIXTURE, f)))).ctx;
        docs = viewDocuments(server, () => ctx, { [view]: join(FIXTURE, 'instances.trig') });
    }, 20000);
    afterAll(async () => { await server?.stop(); });
    beforeEach(() => docs.reset());

    test.each(['layered', 'force'] as const)('Apply Layout %s: new boxes for the cards, one edit of the view document', async algorithm => {
        const part = (await diagramOf(ctx, vid)).doc;
        const { bounds } = await layoutView(part, vid, algorithm);
        const before = part.views[vid].boxes;
        expect(bounds.length).toBe(before.length);
        expect(bounds.some(b => { const o = before.find(x => x.id === b.id)!; return o.x !== b.x || o.y !== b.y; })).toBe(true);
        const text = docs.text(view);
        const r = await docs.run({ kind: 'setLayout', view: vid, bounds });
        expect(r).toMatchObject({ ok: true });
        expect(r.edits).toHaveLength(1);
        expect(docs.text(view)).not.toBe(text);
    });

    test('"+ member": the options leave out the members; a label gives one instance (kata dxwx)', async () => {
        const ids = await instancesNamed(ctx, 'Animal Farm');
        expect(ids).toHaveLength(1);
        const options = await memberOptions(ctx, vid, docs.text(view), 'none');
        expect(options).toContain('Animal Farm');
        const r = await docs.run({ kind: 'collect', view: vid, ids });
        expect(r).toMatchObject({ ok: true });
        const id = (r as { value: string }).value;
        expect(await memberOptions(ctx, vid, docs.text(view), id)).not.toContain('Animal Farm');
        expect(await memberOptions(ctx, vid, docs.text(view), id)).toContain('George Orwell');
    });
});
