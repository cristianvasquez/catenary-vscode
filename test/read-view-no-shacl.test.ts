import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { iriId } from '../src/catenary/model/ids';
import { TYPES } from '../src/catenary/model/diagram-schema';
import { diagramOf, modelContextOf, type ModelContext, viewDocRead } from '../src/read/diagram';
import { viewDocOf } from '../src/read/view';
import { relationId } from '../src/catenary/rdf/ids';
import { rdf } from '../src/catenary/rdf/terms';
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

    test('a statement-free placed IRI is a relation endpoint and its explicit edge renders', async () => {
        const id = relationId(rdf.namedNode(iri('alice')), rdf.namedNode(iri('worksAt')), rdf.namedNode(iri('acme')));
        const doc = await viewDocRead(ctx, VIEW);
        expect(doc.relations[id]).toMatchObject({ subject: iriId(iri('alice')), predicate: iri('worksAt'), object: iriId(iri('acme')) });
        expect(doc.instances[iriId(iri('alice'))].fields[iri('worksAt')]).toBeUndefined();

        const file = ctx.views.get(VIEW)!, uri = pathToFileURL(file).href;
        const original = readFileSync(file, 'utf8');
        const text = `@prefix view: <https://cristianvasquez.github.io/catenary/vocab/view#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
<${VIEW}> {
  <${VIEW}> a view:View .
  <urn:test:alice> a view:Placement ; view:element <${iri('alice')}> .
  <urn:test:acme> a view:Placement ; view:element <${iri('acme')}> .
  <urn:test:worksAt> a view:Placement ; rdf:reifies <<( <${iri('alice')}> <${iri('worksAt')}> <${iri('acme')}> )>> .
}`;
        try {
            server.open(uri, text, 'trig');
            const drawn = await diagramOf(ctx, VIEW);
            const warnings: string[] = [];
            const explicit = viewDocOf(ctx, VIEW, text, drawn.kept!, { warnings });
            expect(explicit.views[iriId(VIEW)].edges).toContainEqual(expect.objectContaining({ relation: id }));
            expect(drawn.schema.children).toContainEqual(expect.objectContaining({
                type: TYPES.RELATION, id: iriId('urn:test:worksAt'), element: id,
                sourceId: iriId('urn:test:alice'), targetId: iriId('urn:test:acme')
            }));
            expect(warnings.filter(w => w.includes('unknown'))).toEqual([]);
        } finally {
            server.change(uri, original);
        }
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
