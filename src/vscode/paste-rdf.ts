// Turtle text pasted on the canvas places subjects already in the workspace, in one view undo step.
// Unknown subjects are counted in the message; paste never writes statements to model files.
import type { Quad } from '@rdfjs/types';
import { Parser } from 'n3';
import { boxes } from '../catenary/model/doc';
import { iriId } from '../catenary/model/ids';
import { PREFIXES } from '../catenary/model/shapes-doc';
import type { FocusNode } from '../catenary/shacl/common/index';
import type { WorkspaceCore } from '../model/workspace-core';
import type { ModelContext } from '../read/diagram';
import { applyPrefixes } from '../read/manifest';
import { bindings } from '../read/targets';

/** The quads of Turtle text (the `n3` parser); a text without prefix lines reads the prefix table of the workspace (Catenary prepareRdfPaste). */
export function parseTurtle(text: string, prefixes: Record<string, string>): Quad[] | undefined {
    const parse = (turtle: string) => new Parser({ format: 'text/turtle' }).parse(turtle);
    try { return parse(text); } catch { /* try with the prefixes of the workspace */ }
    const header = Object.entries(prefixes).filter(([p]) => text.includes(`${p}:`)).map(([p, ns]) => `@prefix ${p}: <${ns}> .\n`).join('');
    try { return header ? parse(header + text) : undefined; } catch { return undefined; }
}

/** The IRIs among `iris` that are subjects of a statement in the model files (not the view files): one query (and one for blank-node IRIs). */
async function known(ctx: ModelContext, iris: string[]): Promise<Set<string>> {
    const nodes = iris.map((value): FocusNode => ({ termType: 'NamedNode', value }));
    const found = new Set<string>();
    if (ctx.modelFiles.length) for (const { clause, keep } of bindings('s', nodes)) {
        for (const r of await ctx.port.select(`SELECT DISTINCT ?s WHERE { ?s ?p ?o ${clause} }`, ctx.modelFiles)) if (keep(r.s)) found.add(r.s.value);
    }
    return found;
}

/** Paste `text` into the view `viewIri` at `at`; returns the message for the canvas. */
export async function pasteTurtle(model: WorkspaceCore, viewIri: string, text: string, mediaType: string | undefined, at: { x: number; y: number } = { x: 300, y: 300 }): Promise<string> {
    if (mediaType && mediaType !== 'text/turtle' && mediaType !== 'application/n-triples') return `${mediaType} is not supported: paste Turtle text.`;
    const ctx = model.context();
    if (!ctx) return 'The workspace graph is not read yet.';
    applyPrefixes(ctx.manifest);
    const parsed = parseTurtle(text, PREFIXES);
    if (!parsed) return 'The clipboard is not valid Turtle.';
    const subjects = [...new Set(parsed.filter(q => q.subject.termType === 'NamedNode').map(q => q.subject.value))];
    if (!subjects.length) return 'The pasted Turtle has no subject IRIs.';
    const inModel = await known(ctx, subjects);
    const present = subjects.filter(iri => inModel.has(iri));
    const missing = subjects.length - present.length;
    const message = missing ? ` Subjects not in the workspace: ${missing}. They must be added to a model file first.` : '';
    if (!present.length) return `Placed 0.${message}`;
    // The placed elements of the drawn Doc: the view document as the server has it (the open buffer, after the edit of the command).
    const id = iriId(viewIri);
    const count = async () => {
        const view = (await model.diagram(id, {})).doc.views[id];
        const placed = new Set([...boxes(view, 'card').map(b => b.element), ...boxes(view, 'collection').flatMap(b => b.members)]);
        return present.filter(iri => placed.has(iriId(iri))).length;
    };
    const before = await count();
    const r = await model.execute(id, { kind: 'addToView', view: id, ids: present.map(iriId), at });
    if (!r.ok) return `${r.error}${message}`;
    return `Placed ${await count() - before}.${message}`;
}
