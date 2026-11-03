// One view command over turtle/query: the view quads from the server (the open buffer wins), the facts prefetch, the figures prefetch,
// executeCommand in memory, then the new text of each view that changed: the text patched by tree-sitter (comments, layout and unchanged
// statements stay byte for byte), else the whole-file text. Nothing is kept between commands; the caller applies the edits.
import type { Quad } from '@rdfjs/types';
import { fileURLToPath } from 'node:url';
import type { ViewCommand } from '../catenary/model/commands';
import type { NTerm } from '../catenary/model/notation-graph';
import type { ModelPort } from '../model/port';
import { fail, type Result } from './ops';
import type { ModelContext } from '../read/diagram';
import { prefetchFigures } from '../read/figures';
import { applyPrefixes } from '../read/manifest';
import { executeCommand, type Views } from './commands';
import { commandIris, factsOf } from './facts-of';
import { rdf, tripleKey } from './terms';
import { PREFIXES } from '../catenary/model/shapes-doc';
import { patchTurtle } from './text-patch';
import { ViewQuads, viewText } from './view-quads';

/** A view that a command can edit: its IRI, the URI of its document and, when known, the text of that document. */
export interface ViewInput { iri: string; uri: string; text?: string }

/** The new full text of one view document. */
export interface ViewEdit { uri: string; text: string }

/** The result of the command and the edits of its view documents (none after a failure or a no-op). */
export type CommandRun = Result<unknown> & { edits: ViewEdit[] };

/** The quads of the view graph `iri` as the server has them now. */
async function viewQuadsOf(ctx: ModelContext, iri: string): Promise<ViewQuads> {
    const g = rdf.namedNode(iri);
    const rows = await ctx.port.select(`SELECT ?s ?p ?o WHERE { GRAPH <${iri}> { ?s ?p ?o } }`);
    return new ViewQuads(rows.map(r => rdf.quad(r.s as never, r.p as never, r.o as never, g)), g);
}

/**
 * Why the canvas cannot edit the view file `file` of the view `iri`: it has statements outside the view graph (another graph, or the
 * default graph of the document), which the whole-file text of the view would delete. Undefined: the file holds the view graph only.
 */
export async function viewFileProblem(port: ModelPort, file: string, iri: string): Promise<string | undefined> {
    const rows = await port.select('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }', [file]);
    const other = rows.map(r => r.g?.value).filter(g => g !== iri);
    return other.length ? `${file} has statements outside the view graph <${iri}> (in ${other.map(g => `<${g}>`).join(', ')}): a view file holds the view graph only.` : undefined;
}

/**
 * Run `command` on `views`. The figures reader of a view is synchronous over one prefetch made before the command (K4), with the terms
 * that the command names read as placed terms. executeCommand changes the view quads in place and has no rollback: a failed command
 * gives no edit and its quads are dropped. A view whose statements did not change, or whose new text equals `text`, gives no edit. A view
 * file with statements outside its view graph is refused (viewFileProblem). `log` gets the reason when the text patch of a view fails.
 */
export async function runCommand(ctx: ModelContext, views: ViewInput[], command: ViewCommand, log: (line: string) => void = line => console.warn(line)): Promise<CommandRun> {
    for (const v of views) {
        const problem = await viewFileProblem(ctx.port, fileURLToPath(v.uri), v.iri);
        if (problem) return { ...fail(problem), edits: [] };
    }
    const quads: Views = Object.fromEntries(await Promise.all(views.map(async v => [v.iri, await viewQuadsOf(ctx, v.iri)] as const)));
    const reach: NTerm[] = commandIris(ctx.shapes, command, quads).map(value => ({ termType: 'NamedNode', value }));
    const [facts, prefetched] = await Promise.all([
        factsOf(ctx, command, quads),
        Promise.all(views.map(async v => [v.iri, await prefetchFigures(ctx.port, v.iri, ctx.shapes, ctx.modelFiles, reach)] as const))
    ]);
    const readers = new Map(prefetched);
    const figures = (iri: string, also?: NTerm[]) => {
        const reader = readers.get(iri), view = quads[iri];
        if (!reader || !view) throw new Error(`The command reads the figures of ${iri}, a view that it does not edit.`);
        return reader.figures(view.quads(), also);
    };
    // After the queries: the texts (labels, prefixed names) use the prefix table of this folder.
    applyPrefixes(ctx.manifest);
    const r = executeCommand(quads, facts, figures, ctx.shapes.meta, command);
    if (!r.ok) return { ...r, edits: [] };
    const edits = (await Promise.all(views.map(async v => {
        const q = quads[v.iri], { added, removed } = q.changes();
        if (!added.length && !removed.length) return [];
        const text = await viewTextOf(v, q, added, removed, log);
        return text === v.text ? [] : [{ uri: v.uri, text }];
    }))).flat();
    return { ...r, edits };
}

/**
 * The new text of the view document `v` after the changes `added` and `removed` of `q`: the text of `v` patched (patchTurtle), else
 * the whole-file text (viewText) and one log line with the reason. No text in `v`: the whole-file text.
 */
async function viewTextOf(v: ViewInput, q: ViewQuads, added: Quad[], removed: Quad[], log: (line: string) => void): Promise<string> {
    if (v.text === undefined) return viewText(q);
    const after = q.quads(), gone = new Set(added.map(tripleKey));
    const before = [...after.filter(x => !gone.has(tripleKey(x))), ...removed];
    const r = await patchTurtle(v.text, fileURLToPath(v.uri), before, after, PREFIXES, q.graph);
    if (r.ok) return r.text;
    log(`${v.uri}: the text patch failed (${r.reason}): the whole view file is written`);
    return viewText(q);
}
