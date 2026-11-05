import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { iriId } from '../src/catenary/model/ids';
import { TYPES } from '../src/catenary/model/diagram-schema';
import { diagramOf, modelContextOf, type ModelContext, viewDocRead } from '../src/read/diagram';
import { startServer } from './server';

const VIEW = 'urn:name:People';
const PEOPLE = ['alice', 'carol', 'paris', 'acme', 'eve'];
const iri = (name: string) => `http://ex.org/${name}`;

describe('placed IRIs without SHACL', () => {
    let server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext;
    beforeAll(async () => {
        const dir = resolve('test/fixtures/no-shacl');
        server = await startServer(dir, 53);
        ({ ctx } = await modelContextOf(server.port(), ['data.ttl', 'view.trig'].map(f => resolve(dir, f))));
    }, 20000);
    afterAll(async () => { await server?.stop(); });

    test('all five placed IRIs have instances and cards without unsupported-presentation warnings', async () => {
        const warnings: string[] = [];
        const doc = await viewDocRead(ctx, VIEW, { warnings });
        const ids = PEOPLE.map(name => iriId(iri(name))).sort();
        expect(Object.keys(doc.instances).sort()).toEqual(ids);
        expect(doc.views[iriId(VIEW)].boxes.filter(b => b.kind === 'card').map(b => b.element).sort()).toEqual(ids);
        expect(warnings.filter(w => w.includes('no supported card presentation'))).toEqual([]);
    });

    test('the diagram has five cards; untyped IRIs use their IRI title and no type class line', async () => {
        const { schema, doc } = await diagramOf(ctx, VIEW);
        const cards = schema.children?.filter(e => e.type === TYPES.CARD) ?? [];
        expect(cards.map(c => c.element).sort()).toEqual(PEOPLE.map(name => iriId(iri(name))).sort());
        for (const name of ['paris', 'acme', 'eve']) {
            expect(doc.instances[iriId(iri(name))]).toMatchObject({ label: name, types: [] });
            expect(cards.find(c => c.element === iriId(iri(name)))).toMatchObject({ name, className: 'no type' });
        }
        expect(doc.instances[iriId(iri('acme'))].fields).toEqual({});
        expect(cards.find(c => c.element === iriId(iri('acme')))).toMatchObject({ lines: [] });
    });
});
