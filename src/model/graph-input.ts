// Combine turtle-lsp model quads with parsed view files, normalize terms and restore workspace prefixes.
import type { Quad, Term } from '@rdfjs/types';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NS } from '../catenary/model/terms';
import { DEFAULT_PREFIXES, setPrefixes } from '../catenary/model/shapes-doc';
import { skolemize } from '../catenary/rdf-core/skolem';
import { OxigraphStore, parseRdfSync } from '../catenary/rdf-files/oxigraph-store';
import { readManifest } from '../catenary/rdf/files';
import type { ModelGraph } from '../catenary/rdf/graph';
import { dataGraphIri, shapesGraphIri } from '../catenary/rdf/graph-names';
import { readLegacy, shapePart, viewProblem } from '../catenary/rdf/loader';
import { newModelGraph } from '../catenary/rdf/model-graph';
import { rdf, termKey } from '../catenary/rdf/terms';
import { P } from '../catenary/rdf/vocabulary';
import { quadsOf, type NTerm } from '../node/quads';
import type { GraphResult } from '../node/turtle-api';
import { nquadsOf, toEngine } from './nquads';

const prefixTables = new WeakMap<ModelGraph, Record<string, string>>();

/** Restore this graph's prefix table before Catenary's synchronous derivation. */
export function graphPrefixes(graph: ModelGraph): void {
    setPrefixes(prefixTables.get(graph) ?? DEFAULT_PREFIXES);
}

/** As turtle-store setModel: LSP blank-node ids become engine IRIs. */
function term(t: NTerm): Term {
    if (t.termType === 'Triple') return rdf.quad(term(t.subject) as Quad['subject'], rdf.namedNode(t.predicate.value), term(t.object) as Quad['object']);
    if (t.termType === 'Literal') return rdf.literal(t.value, t.language || (t.datatype ? rdf.namedNode(t.datatype) : undefined));
    return rdf.namedNode(t.termType === 'BlankNode' ? toEngine(t.value) : t.value);
}

export { toEngine };

/** The normalized view graph IRI; invalid or empty view files are rejected. */
export function viewIriOf(text: string): string {
    const { quads } = readLegacy(parseRdfSync(text, 'application/trig'));
    const problem = quads.length ? viewProblem(quads) : 'the file has no statements';
    if (problem) throw new Error(problem);
    return quads[0].graph.value;
}

/** A view file: a `.trig` file with a view:View. A `.trig` file without one is a model file. */
export function isViewFile(file: string, text: string | undefined): boolean {
    if (!file.endsWith('.trig') || !text) return false;
    try {
        return parseRdfSync(text, 'application/trig').some(q => q.predicate.value === NS.rdf + 'type' && q.object.value === NS.view + 'View');
    } catch {
        return false;
    }
}

/** Model documents from turtle/graph, plus view-file paths read as TriG. No model file is parsed here.
 * The model quads go to the store in one N-Quads load: per file, the data graph (its file URI) and the shapes graph (`#shapes`). */
export function graphOf(result: GraphResult, viewFiles: string[]): { graph: ModelGraph; views: Map<string, string>; skipped: { file: string; reason: string }[] } {
    const files = new Map<string, Quad[]>(), viewSet = new Set(viewFiles), fileUri = new Map<string, boolean>();
    quadsOf(result).forEach((q, i) => {
        const uri = result.edges[i].uri;
        const file = uri.startsWith('file:') ? fileURLToPath(uri) : uri;
        if (viewSet.has(file)) return;
        fileUri.set(file, uri.startsWith('file:'));
        const quad = rdf.quad(term(q.subject) as Quad['subject'], rdf.namedNode(q.predicate), term(q.object) as Quad['object']);
        (files.get(file) ?? files.set(file, []).get(file)!).push(quad);
    });
    const manifest = [...files].filter(([, quads]) => quads.some(q => q.predicate.equals(P.type) && q.object.value === NS.ws + 'Workspace'))
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)[0];
    if (manifest) files.delete(manifest[0]);
    const settings = manifest ? readManifest(manifest[1], manifest[0]) : undefined;
    // A document that is not a file keeps its URI as the data graph name.
    const dataGraph = (file: string) => fileUri.get(file) ? dataGraphIri(file) : file;
    const shapesGraph = (file: string) => fileUri.get(file) ? shapesGraphIri(file) : file + '#shapes';
    const placed: Quad[] = [];
    for (const [file, read] of files) {
        const { quads } = readLegacy(read);
        const shapes = shapePart(quads), sg = rdf.namedNode(shapesGraph(file)), dg = rdf.namedNode(dataGraph(file));
        for (const q of quads) placed.push(rdf.quad(q.subject, q.predicate, q.object, shapes.has(termKey(q.subject)) ? sg : dg));
    }
    const store = new OxigraphStore();
    store.load(nquadsOf(placed), 'application/n-quads');
    const graph = newModelGraph(store);
    prefixTables.set(graph, settings?.prefixes ?? DEFAULT_PREFIXES);
    graphPrefixes(graph);
    graph.language = settings?.language;
    const modelFiles = [...files.keys()].sort();
    const views = new Map<string, string>(), skipped: { file: string; reason: string }[] = [];
    graph.update(() => {
        graph.setDataGraphs(modelFiles.map(f => rdf.namedNode(dataGraph(f))));
        graph.setShapesGraphs(modelFiles.map(f => rdf.namedNode(shapesGraph(f))));
        for (const file of viewFiles) {
            try {
                const text = readFileSync(file, 'utf8'), view = viewIriOf(text);
                if (views.has(view)) throw new Error(`duplicate view ${view}`);
                const { quads } = readLegacy(parseRdfSync(text, 'application/trig'));
                views.set(view, file);
                for (const q of skolemize(quads).quads) graph.add(q.subject, q.predicate, q.object, q.graph);
            } catch (e) {
                skipped.push({ file, reason: e instanceof Error ? e.message : String(e) });
            }
        }
    });
    return { graph, views, skipped };
}
