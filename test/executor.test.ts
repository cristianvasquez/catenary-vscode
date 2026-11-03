// Kata v3y7: runCommand over the fork binary. A command on a model blank node (the isBlank branches of the factsOf prefetch, K9), and a
// paste of a cut that edits two view documents.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { Parser } from 'n3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { copyFromView } from '../src/catenary/model/commands';
import { placementOfId } from '../src/catenary/model/doc';
import { iriId } from '../src/catenary/model/ids';
import { runCommand } from '../src/edit/executor';
import { tripleKey } from '../src/edit/terms';
import { diagramOf, modelContextOf, type ModelContext } from '../src/read/diagram';
import { FIXTURE, startServer } from './server';

const VIEW = 'https://cristianvasquez.github.io/catenary/vocab/view#';
const at = { x: 500, y: 600 };
const keys = (text: string, iri: string) => new Parser({ format: 'application/trig' }).parse(text).filter(q => q.graph.value === iri).map(tripleKey).sort();

describe('a model blank node', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-blank-')), view = 'urn:name:Blank';
    let server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext;
    beforeAll(async () => {
        writeFileSync(join(dir, 'data.ttl'), [
            '@prefix ex: <http://example.org/> .', '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
            '[] a ex:Thing ; rdfs:label "anonymous" ; ex:knows ex:b .', 'ex:b a ex:Thing ; rdfs:label "B" .', ''
        ].join('\n'));
        writeFileSync(join(dir, 'view.trig'), [
            `@prefix view: <${VIEW}> .`, '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
            `<${view}> {`, `  <${view}> a view:View ; rdfs:label "Blank" .`,
            `  <${view}/p/b> a view:Placement ; view:element <http://example.org/b> ; view:view <${view}> ; view:x 0 ; view:y 0 ; view:width 300 ; view:height 150 .`,
            '}', ''
        ].join('\n'));
        writeFileSync(join(dir, 'mixed.trig'), [
            `@prefix view: <${VIEW}> .`, '<urn:name:Mixed> { <urn:name:Mixed> a view:View . }', '<urn:name:Other> { <urn:x:s> <urn:x:p> <urn:x:o> . }', ''
        ].join('\n'));
        server = await startServer(dir, 16);
        ctx = (await modelContextOf(server.port(), readdirSync(dir).sort().map(f => join(dir, f)))).ctx;
    }, 20000);
    afterAll(async () => {
        await server?.stop();
        rmSync(dir, { recursive: true });
    });

    test('addToView of a blank node: the prefetch finds it by its label; the edit places it and the relation to the placed card', async () => {
        const [row] = await server.port().select('SELECT ?s WHERE { ?s <http://www.w3.org/2000/01/rdf-schema#label> "anonymous" }');
        const blank = row.s.value;
        expect(blank).toMatch(/^urn:skolem:blank:/);
        const uri = pathToFileURL(join(dir, 'view.trig')).href;
        const r = await runCommand(ctx, [{ iri: view, uri }], { kind: 'addToView', view: iriId(view), ids: [iriId(blank)], at });
        expect(r).toMatchObject({ ok: true, value: iriId(blank) });
        expect(r.edits.map(e => e.uri)).toEqual([uri]);
        const quads = keys(r.edits[0].text, view);
        expect(quads.some(k => k.endsWith(`<${VIEW}element> <${blank}>`))).toBe(true);
        // The statement between the blank node and the placed card is drawn (placeConnectors): the facts have the blank node's statements.
        expect(quads.some(k => k.includes(`<<( <${blank}> <http://example.org/knows> <http://example.org/b> )>>`))).toBe(true);
    });

    test('a view file with statements outside its view graph is refused: the whole-file text would delete them', async () => {
        const uri = pathToFileURL(join(dir, 'mixed.trig')).href, mixed = 'urn:name:Mixed';
        const r = await runCommand(ctx, [{ iri: mixed, uri }], { kind: 'createNote', view: iriId(mixed), text: 'n', at });
        expect(r).toMatchObject({ ok: false, edits: [] });
        expect((r as { error: string }).error).toContain('has statements outside the view graph <urn:name:Mixed> (in <urn:name:Other>)');
    });

    test('a blank node that the server does not have is not placed: no edit', async () => {
        const missing = 'urn:skolem:blank:999999-00000001', uri = pathToFileURL(join(dir, 'view.trig')).href;
        const r = await runCommand(ctx, [{ iri: view, uri }], { kind: 'addToView', view: iriId(view), ids: [iriId(missing)], at });
        expect(r.ok).toBe(false);
        expect(r.edits).toEqual([]);
    });
});

describe('the fixture views', () => {
    let server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext;
    beforeAll(async () => {
        server = await startServer(FIXTURE, 282);
        ctx = (await modelContextOf(server.port(), readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(f => join(FIXTURE, f)))).ctx;
    }, 20000);
    afterAll(async () => { await server?.stop(); });

    test('a paste of a cut edits the two view documents: the card leaves the source view and arrives in the target view', async () => {
        const view = 'urn:name:Bookshop', model = 'urn:name:Bookshop%20model', mid = iriId(model), shape = 'urn:name:Book%20shape';
        const doc = (await diagramOf(ctx, mid)).doc;
        const clip = copyFromView(doc, mid, [placementOfId(doc.views[mid], iriId(shape))], 'cut')!;
        const uris: Record<string, string> = { [view]: pathToFileURL(join(FIXTURE, 'instances.trig')).href, [model]: pathToFileURL(join(FIXTURE, 'model.trig')).href };
        const r = await runCommand(ctx, [{ iri: view, uri: uris[view] }, { iri: model, uri: uris[model] }],
            { kind: 'moveBetweenViews', from: clip.source, to: iriId(view), clip, at });
        expect(r.ok).toBe(true);
        expect(r.edits.map(e => e.uri).sort()).toEqual([uris[view], uris[model]].sort());
        const element = (iri: string) => keys(r.edits.find(e => e.uri === uris[iri])!.text, iri).some(k => k.endsWith(`<${VIEW}element> <${shape}>`));
        expect(element(view)).toBe(true);
        expect(element(model)).toBe(false);
    });
});
