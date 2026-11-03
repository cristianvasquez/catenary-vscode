// Turtle text pasted on the canvas places subjects already in the workspace, in one view undo step.
// Unknown subjects are counted in the message; paste never writes statements to model files.
import type { Quad } from '@rdfjs/types';
import { iriId } from '../catenary/model/ids';
import { PREFIXES } from '../catenary/model/shapes-doc';
import { parseRdfSync } from '../catenary/rdf-files/oxigraph-store';
import type { ModelGraph } from '../catenary/rdf/graph';
import { rdf } from '../catenary/rdf/terms';
import { V } from '../catenary/rdf/views';
import { graphPrefixes } from '../model/graph-input';
import type { WorkspaceCore } from '../model/workspace-core';

/** The quads of Turtle text; a text without prefix lines reads the prefix table of the workspace (Catenary prepareRdfPaste). */
export function parseTurtle(text: string, prefixes: Record<string, string>): Quad[] | undefined {
    try { return parseRdfSync(text, 'text/turtle'); } catch { /* try with the prefixes of the workspace */ }
    const header = Object.entries(prefixes).filter(([p]) => text.includes(`${p}:`)).map(([p, ns]) => `@prefix ${p}: <${ns}> .\n`).join('');
    try { return header ? parseRdfSync(header + text, 'text/turtle') : undefined; } catch { return undefined; }
}

/** True when the model files (not the view files) have statements about `iri`. */
const known = (graph: ModelGraph, iri: string) => graph.match(rdf.namedNode(iri)).some(q => graph.isDataGraph(q.graph) || graph.isShapesGraph(q.graph));

/** Paste `text` into the view `viewIri` at `at`; returns the message for the canvas. */
export async function pasteTurtle(model: WorkspaceCore, viewIri: string, text: string, mediaType: string | undefined, at: { x: number; y: number } = { x: 300, y: 300 }): Promise<string> {
    if (mediaType && mediaType !== 'text/turtle' && mediaType !== 'application/n-triples') return `${mediaType} is not supported: paste Turtle text.`;
    const graph = model.graph;
    if (!graph) return 'The workspace graph is not read yet.';
    graphPrefixes(graph);
    const parsed = parseTurtle(text, PREFIXES);
    if (!parsed) return 'The clipboard is not valid Turtle.';
    const subjects = [...new Set(parsed.filter(q => q.subject.termType === 'NamedNode').map(q => q.subject.value))];
    if (!subjects.length) return 'The pasted Turtle has no subject IRIs.';
    const present = subjects.filter(iri => known(graph, iri));
    const missing = subjects.length - present.length;
    const message = missing ? ` Subjects not in the workspace: ${missing}. They must be added to a model file first.` : '';
    if (!present.length) return `Placed 0.${message}`;
    const view = rdf.namedNode(viewIri);
    const count = () => present.filter(iri => model.graph!.match(null, V.element, rdf.namedNode(iri), view).length).length;
    const before = count();
    const r = model.execute(iriId(viewIri), { kind: 'addToView', view: iriId(viewIri), ids: present.map(iriId), at });
    if (!r.ok) return `${r.error}${message}`;
    return `Placed ${count() - before}.${message}`;
}
