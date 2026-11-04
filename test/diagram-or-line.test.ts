import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { iriId } from '../src/catenary/model/ids';
import { completeDrawing, diagramOf, drawFromText, modelContextOf, type Drawn } from '../src/read/diagram';
import { expandChoices } from '../src/read/choices';
import { startServer } from './server';
import { viewDocuments } from './views';

const head = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <http://example.org/> .
@prefix view: <https://cristianvasquez.github.io/catenary/vocab/view#> .`;

test('an incoming add connects through an inline sh:or range', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-or-line-'));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
        const shapes = join(dir, 'shapes.ttl'), file = join(dir, 'view.trig');
        writeFileSync(shapes, `${head}
ex:Task a sh:NodeShape ; sh:property [ sh:path ex:reads ; sh:or ( [ sh:class ex:B ] [ sh:class ex:C ] ) ] .
ex:Service a sh:NodeShape ; sh:targetClass ex:B .`);
        const view = 'urn:test:view';
        const text = (both: boolean) => `${head}<${view}> { <${view}> a view:View .
ex:b a view:Placement ; view:element ex:Service ; view:view <${view}> .
${both ? `ex:a a view:Placement ; view:element ex:Task ; view:view <${view}> .` : ''} }`;
        writeFileSync(file, text(false));
        server = await startServer(dir, 16);
        const ctx = (await modelContextOf(server.port(), [shapes, file])).ctx;
        const docs = viewDocuments(server, () => ctx, { [view]: file });
        const connects = (d: Drawn) => {
            const cards = d.schema.children ?? [];
            const task = cards.find(e => e.element === iriId('http://example.org/Task'));
            const service = cards.find(e => e.element === iriId('http://example.org/Service'));
            return cards.some(e => e.type.startsWith('edge:') && e.sourceId === task?.id && e.targetId === service?.id);
        };
        const before = await diagramOf(ctx, view);
        const choices = await expandChoices(ctx, iriId(view), docs.text(view), iriId('http://example.org/Service'), 'in');
        expect(choices?.items).toHaveLength(1);
        expect(choices?.items[0].ids).toEqual([iriId('http://example.org/Task')]);
        expect(await docs.run({ kind: 'addToView', view, ids: [iriId('http://example.org/Task')], at: { x: 0, y: 0 } })).toMatchObject({ ok: true });
        const kept = await diagramOf(ctx, view, { kept: before.kept });
        const fresh = await diagramOf(ctx, view);
        const first = drawFromText(ctx, view, docs.text(view), before.kept);
        const second = await completeDrawing(ctx, view, first.drawn, first.misses);
        expect(connects(kept)).toBe(true);
        expect(connects(first.drawn)).toBe(true);
        expect(connects(fresh)).toBe(true);
        expect(connects(second)).toBe(true);
        docs.set(view, text(true));
        const full = await diagramOf(ctx, view);
        expect(connects(full)).toBe(true);
        const task = full.schema.children!.find(e => e.element === iriId('http://example.org/Task'))!;
        expect(task.children![0].range).toContain(' | ');
        // Taking the range out explicitly must still use the list box, not a direct end candidate.
        const property = Object.values(full.doc.shapes.properties)[0];
        expect(await docs.run({ kind: 'showAsEdge', view, id: property.id, at: { x: 100, y: 100 } })).toMatchObject({ ok: true });
        const extracted = await diagramOf(ctx, view);
        expect(connects(extracted)).toBe(false);
        expect(extracted.schema.children!.some(e => e.type === 'node:one-of')).toBe(true);
    } finally {
        await server?.stop();
        rmSync(dir, { recursive: true, force: true });
    }
}, 20000);
