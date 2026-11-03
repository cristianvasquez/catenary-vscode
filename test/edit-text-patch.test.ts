// Kata h3bm: a command patches the text of the view document (tree-sitter, src/edit/text-patch.ts); the whole-file text is the fallback.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Parser } from 'n3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { iriId } from '../src/catenary/model/ids';
import { runCommand } from '../src/edit/executor';
import { tripleKey } from '../src/edit/terms';
import { modelContextOf, type ModelContext } from '../src/read/diagram';
import { startServer } from './server';

const VIEW = 'https://cristianvasquez.github.io/catenary/vocab/view#';
const view = 'urn:name:Patch', blankView = 'urn:name:Blank';
/** The statements of the graph `iri` in a TriG text, read back with n3. */
const keys = (text: string, iri: string) => new Parser({ format: 'application/trig' }).parse(text).filter(q => q.graph.value === iri).map(tripleKey).sort();

const head = [`@prefix view: <${VIEW}> .`, '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .', ''];
const patchText = [...head,
    '# The bookshop: a comment that the patch keeps.',
    `<${view}> {`,
    `    <${view}>   a view:View ;`,
    '        rdfs:label "Patch" .',
    '',
    '    # The card of b.',
    `    <${view}/p/b> a view:Placement ; view:element # a comment between a predicate and its object`,
    `            <http://example.org/b> ; view:view <${view}> ;`,
    '        view:x 0 ; view:y 0 ; view:width 300 ; view:height 150 .',
    '}', ''].join('\n');
const blankText = [...head,
    `<${blankView}> {`,
    `  <${blankView}> a view:View ; rdfs:label "Blank" ; rdfs:seeAlso [ rdfs:label "anonymous" ] .`,
    `  <${blankView}/p/b> a view:Placement ; view:element <http://example.org/b> ; view:view <${blankView}> ; view:x 0 ; view:y 0 ; view:width 300 ; view:height 150 .`,
    '}', ''].join('\n');

describe('the text patch of a view document', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-patch-'));
    let server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext;
    beforeAll(async () => {
        writeFileSync(join(dir, 'data.ttl'), [
            '@prefix ex: <http://example.org/> .', '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
            'ex:b a ex:Thing ; rdfs:label "B" .', ''
        ].join('\n'));
        writeFileSync(join(dir, 'patch.trig'), patchText);
        writeFileSync(join(dir, 'blank.trig'), blankText);
        server = await startServer(dir, 18);
        ctx = (await modelContextOf(server.port(), readdirSync(dir).sort().map(f => join(dir, f)))).ctx;
    }, 20000);
    afterAll(async () => {
        await server?.stop();
        rmSync(dir, { recursive: true });
    });

    test('setBounds: the comments, the layout and the untouched statements stay byte for byte; the text reads back to the new statements', async () => {
        const uri = pathToFileURL(join(dir, 'patch.trig')).href, logs: string[] = [];
        const r = await runCommand(ctx, [{ iri: view, uri, text: patchText }],
            { kind: 'setBounds', view: iriId(view), bounds: [{ id: iriId('http://example.org/b'), x: 120, y: 80 }] }, l => logs.push(l));
        expect(r.ok).toBe(true);
        expect(logs).toEqual([]);
        expect(r.edits.map(e => e.uri)).toEqual([uri]);
        const text = r.edits[0].text, int = (n: number) => `"${n}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
        expect(text).toBe(patchText.replace('view:x 0 ; view:y 0', 'view:x 120 ; view:y 80'));
        const card = `<${view}/p/b>`, expected = keys(patchText, view)
            .map(k => k === `${card} <${VIEW}x> ${int(0)}` ? `${card} <${VIEW}x> ${int(120)}` : k === `${card} <${VIEW}y> ${int(0)}` ? `${card} <${VIEW}y> ${int(80)}` : k).sort();
        expect(keys(text, view)).toEqual(expected);
    });

    test('a text with a blank node falls back to the whole-file text, with one log line', async () => {
        const uri = pathToFileURL(join(dir, 'blank.trig')).href, logs: string[] = [];
        const r = await runCommand(ctx, [{ iri: blankView, uri, text: blankText }],
            { kind: 'setBounds', view: iriId(blankView), bounds: [{ id: iriId('http://example.org/b'), x: 120, y: 80 }] }, l => logs.push(l));
        expect(r.ok).toBe(true);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain('blank node at line 5');
        const text = r.edits[0].text;
        // The whole-file text: the blank node is written as its skolem IRI.
        expect(text).not.toContain('[');
        expect(text).toMatch(/<urn:skolem:blank:[^>]+> <http:\/\/www\.w3\.org\/2000\/01\/rdf-schema#label> "anonymous"/);
        expect(keys(text, blankView).some(k => k.endsWith('"120"^^<http://www.w3.org/2001/XMLSchema#integer>'))).toBe(true);
    });
});
