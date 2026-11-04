// Copy, cut and paste on the canvas (kata tc43): the clip of a view, its paste into another view, the move of a cut, the Turtle of a paste.
// The views are the fixture view documents on the turtle-lsp binary over stdio; a command edits their text.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { copyFromView } from '../src/catenary/model/commands';
import { placementOfId } from '../src/catenary/model/doc';
import { iriId } from '../src/catenary/model/ids';
import { diagramOf, type ModelContext, modelContextOf } from '../src/read/diagram';
import { parseTurtle } from '../src/vscode/paste-rdf';
import { FIXTURE, startServer } from './server';
import { type ViewDocuments, viewDocuments } from './views';

const view = 'urn:name:Bookshop', model = 'urn:name:Bookshop%20model';
const vid = iriId(view), mid = iriId(model);
const files = { [view]: join(FIXTURE, 'instances.trig'), [model]: join(FIXTURE, 'model.trig') };
let server: Awaited<ReturnType<typeof startServer>>, ctx: ModelContext, docs: ViewDocuments;
beforeAll(async () => {
    server = await startServer(FIXTURE, 282);
    ctx = (await modelContextOf(server.port(), readdirSync(FIXTURE).filter(f => /\.(ttl|trig)$/.test(f)).sort().map(f => join(FIXTURE, f)))).ctx;
    docs = viewDocuments(server, () => ctx, files);
}, 20000);
afterAll(async () => { await server?.stop(); });
beforeEach(() => docs.reset());
const names = async (v: string) => (await diagramOf(ctx, v)).schema.children!.map(e => e.name);
const clipOf = async (iri: string, mode: 'copy' | 'cut') => {
    const doc = (await diagramOf(ctx, mid)).doc;
    return copyFromView(doc, mid, [placementOfId(doc.views[mid], iriId(iri))], mode)!;
};

test('a copy of a node shape card names its IRI; the paste places it in another view', async () => {
    const clip = await clipOf('urn:name:Author%20shape', 'copy');
    expect(clip.boxes.map(b => b.id)).toEqual(['urn:name:Author%20shape']);
    expect(await names(vid)).not.toContain('Author shape');
    expect(await docs.run({ kind: 'pasteIntoView', view: vid, clip, at: { x: 0, y: 0 } }, [view])).toMatchObject({ ok: true });
    expect(await names(vid)).toContain('Author shape');
    expect(await names(mid)).toContain('Author shape');
});

test('the paste of a cut moves the card: one command that edits the two view documents', async () => {
    const clip = await clipOf('urn:name:Book%20shape', 'cut');
    const r = await docs.run({ kind: 'moveBetweenViews', from: clip.source, to: vid, clip, at: { x: 0, y: 0 } }, [model, view]);
    expect(r).toMatchObject({ ok: true });
    expect(await names(vid)).toContain('Book shape');
    expect(await names(mid)).not.toContain('Book shape');
    expect(new Set(r.edits.map(e => e.uri))).toEqual(new Set(Object.values(files).map(f => pathToFileURL(f).href)));
});

test('Turtle text without prefix lines reads the prefixes of the workspace', () => {
    const plain = parseTurtle('<urn:a> a <urn:b> .', {});
    expect(plain?.map(q => q.subject.value)).toEqual(['urn:a']);
    const prefixed = parseTurtle('<urn:a> rdfs:label "a" .', { rdfs: 'http://www.w3.org/2000/01/rdf-schema#', sh: 'http://www.w3.org/ns/shacl#' });
    expect(prefixed?.[0].predicate.value).toBe('http://www.w3.org/2000/01/rdf-schema#label');
    expect(parseTurtle('not turtle', {})).toBeUndefined();
});
