// One view command: document quads, scoped model facts and reusable figure prefetch, then executeCommand in memory.
// The caller applies the text edits and keeps the returned prefetch for its model generation.
import type { Quad } from '@rdfjs/types';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Parser } from 'n3';
import type { ViewCommand } from '../catenary/model/commands';
import { nkey, type NTerm } from '../catenary/model/notation-graph';
import { NS } from '../catenary/model/terms';
import { fail, type Result } from './ops';
import type { ModelContext } from '../read/diagram';
import { prefetchFigures, type KeptPrefetch } from '../read/figures';
import { applyPrefixes } from '../read/manifest';
import { executeCommand, type Views } from './commands';
import { commandIris, factsOf } from './facts-of';
import { elementTerm, P, rdf, tripleKey } from './terms';
import { PREFIXES } from '../catenary/model/shapes-doc';
import { patchTurtle } from './text-patch';
import { ViewQuads, viewText } from './view-quads';

/** A view that a command can edit: its IRI, the URI of its document and, when known, the text of that document. */
export interface ViewInput { iri: string; uri: string; text?: string }

/** The new full text of one view document. */
export interface ViewEdit { uri: string; text: string }

/** The result of the command and the edits of its view documents (none after a failure or a no-op). */
export type CommandRun = Result<unknown> & { edits: ViewEdit[]; kept?: Map<string, KeptPrefetch> };

/** The view quads from the supplied document text, or the server when no text was supplied. */
async function viewQuadsOf(ctx: ModelContext, iri: string, file: string, text?: string): Promise<ViewQuads> {
    const g = rdf.namedNode(iri);
    if (text !== undefined) return new ViewQuads(new Parser({ format: 'application/trig', baseIRI: pathToFileURL(file).href }).parse(text), g);
    const rows = await ctx.port.select('SELECT ?s ?p ?o WHERE { ?s ?p ?o }', [file]);
    return new ViewQuads(rows.map(r => rdf.quad(r.s as never, r.p as never, r.o as never, g)), g);
}

/**
 * Why the canvas cannot edit the view file `file` of the view `iri`: it has statements outside the view graph (another graph, or the
 * default graph of the document), which the whole-file text of the view would delete. Undefined: the file holds the view graph only.
 * `text`: the open buffer; otherwise read the file asynchronously. Parse as TriG with n3.
 */
export async function viewFileProblem(file: string, iri: string, text?: string): Promise<string | undefined> {
    let quads: Quad[];
    try {
        quads = new Parser({ format: 'application/trig', baseIRI: pathToFileURL(file).href }).parse(text ?? await readFile(file, 'utf8'));
    } catch (e) {
        return `${file} does not parse as TriG: ${(e as Error).message}`;
    }
    const other = [...new Set(quads.filter(q => q.graph.termType !== 'NamedNode' || q.graph.value !== iri).map(q => q.graph.value))];
    return other.length ? `${file} has statements outside the view graph <${iri}> (in ${other.map(g => `<${g}>`).join(', ')}): a view file holds the view graph only.` : undefined;
}

/**
 * Run `command` on `views`. The figures reader of a view is synchronous over one prefetch made before the command (K4), with the terms
 * that the command names read as placed terms. executeCommand changes the view quads in place and has no rollback: a failed command
 * gives no edit and its quads are dropped. A view whose statements did not change, or whose new text equals `text`, gives no edit. A view
 * file with statements outside its view graph is refused (viewFileProblem). `log` gets the reason when the text patch of a view fails.
 */
export async function runCommand(ctx: ModelContext, views: ViewInput[], command: ViewCommand, log: (line: string) => void = line => console.warn(line), kept?: Map<string, KeptPrefetch>): Promise<CommandRun> {
    const placed = command.kind === 'addToView' ? command.ids
        : command.kind === 'addViewReference' ? [command.target]
        : command.kind === 'pasteIntoView' || command.kind === 'moveBetweenViews'
            ? [...command.clip.boxes.flatMap(b => b.kind === 'card' ? [b.id, b.element] : b.kind === 'reference' && b.target ? [b.target] : []),
                ...command.clip.edges.flatMap(e => [e.subject, e.object])]
            : [];
    const blank = placed.map(id => elementTerm(id)?.value ?? id).find(iri => iri.startsWith('urn:skolem:blank:'));
    if (blank) return { ...fail(`${blank} is a blank node: a view places IRIs only`), edits: [] };
    for (const v of views) {
        const problem = await viewFileProblem(fileURLToPath(v.uri), v.iri, v.text);
        if (problem) return { ...fail(problem), edits: [] };
    }
    const quads: Views = Object.fromEntries(await Promise.all(views.map(async v => [v.iri, await viewQuadsOf(ctx, v.iri, fileURLToPath(v.uri), v.text)] as const)));
    const reach: NTerm[] = commandIris(ctx.shapes, command, quads).map(value => ({ termType: 'NamedNode', value }));
    const prefetched = await Promise.all(views.map(async v => {
            const file = fileURLToPath(v.uri);
            // The prefetch requests the whole view file once. Serve that read from the same document quads as the command;
            // all other figure reads still go through the model port and its coverage checks.
            const port = {
                select: ctx.port.select.bind(ctx.port),
                ask: ctx.port.ask.bind(ctx.port),
                construct: (query: string, files?: string[]) => files?.length === 1 && files[0] === file
                    && query === 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }'
                    ? Promise.resolve(quads[v.iri].quads()) : ctx.port.construct(query, files)
            };
            let previous = kept?.get(v.iri);
            if (previous) {
                // View-owned marks and placements are complete in the document, including newly created ones.
                const local = quads[v.iri].match(null, P.type).filter(q => q.object.value.startsWith(NS.view))
                    .map(q => nkey({ termType: 'NamedNode', value: q.subject.value }));
                previous = { ...previous, covered: { ...previous.covered,
                    outAll: new Set([...previous.covered.outAll, ...local]),
                    inAll: new Set([...previous.covered.inAll, ...local]) } };
            }
            return [v.iri, await prefetchFigures(port, v.iri, file, ctx.shapes, ctx.modelFiles, reach, previous)] as const;
        }));
    // Connector restoration (for example uncollect) uses relations already read by the figure prefetch, not a second model query.
    const relations = prefetched.flatMap(([, reader]) => reader.kept.quads.flatMap(q => q.subject.termType === 'NamedNode' && q.object.termType === 'NamedNode'
        ? [rdf.quad(rdf.namedNode(q.subject.value), rdf.namedNode(q.predicate), rdf.namedNode(q.object.value))] : []));
    const facts = await factsOf(ctx, command, quads, relations, prefetched.length === 1 ? prefetched[0][1].kept : undefined);
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
    return { ...r, edits, kept: new Map(prefetched.map(([iri, reader]) => [iri, { ...reader.kept, records: kept?.get(iri)?.records }])) };
}

/**
 * The new text of the view document `v` after the changes `added` and `removed` of `q`: the text of `v` patched (patchTurtle) when it
 * reads back to the statements of `q`, else the whole-file text (viewText) and one log line with the reason. No text in `v`: the whole-file text.
 */
async function viewTextOf(v: ViewInput, q: ViewQuads, added: Quad[], removed: Quad[], log: (line: string) => void): Promise<string> {
    if (v.text === undefined) return viewText(q);
    const after = q.quads(), gone = new Set(added.map(tripleKey));
    const before = [...after.filter(x => !gone.has(tripleKey(x))), ...removed];
    const r = await patchTurtle(v.text, fileURLToPath(v.uri), before, after, PREFIXES, q.graph);
    const reason = r.ok ? readBackProblem(r.text, v.uri, q) : r.reason;
    if (r.ok && !reason) return r.text;
    log(`${v.uri}: the text patch failed (${reason}): the whole view file is written`);
    return viewText(q);
}

/** Why the patched `text` is not the view `q`: it does not parse, or its statements (read with n3) differ. Undefined: they are equal. */
function readBackProblem(text: string, uri: string, q: ViewQuads): string | undefined {
    let read: Quad[];
    try {
        read = new Parser({ format: 'application/trig', baseIRI: uri }).parse(text);
    } catch (e) {
        return `the patched text does not parse: ${(e as Error).message}`;
    }
    const keys = (quads: Quad[]) => [...new Set(quads.map(tripleKey))].sort().join('\n');
    if (read.some(x => !x.graph.equals(q.graph))) return `the patched text has statements outside the graph <${q.graph.value}>`;
    return keys(read) === keys(q.quads()) ? undefined : 'the patched text reads back to other statements';
}
