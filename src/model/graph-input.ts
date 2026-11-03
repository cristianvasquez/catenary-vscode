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
import { cmp } from '../catenary/rdf-core/graph';
import { fileGraphIri } from '../catenary/rdf/graph-names';
import { readLegacy, shapePart, viewProblem } from '../catenary/rdf/loader';
import { newModelGraph } from '../catenary/rdf/model-graph';
import { rdf } from '../catenary/rdf/terms';
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
 * The model quads go to the store in one N-Quads load: one graph per file, its file URI. */
export function graphOf(result: GraphResult, viewFiles: string[]): { graph: ModelGraph; views: Map<string, string>; skipped: { file: string; reason: string }[] } {
    const viewSet = new Set(viewFiles), fileOf = new Map<string, string>(), read: Quad[] = [];
    quadsOf(result).forEach((q, i) => {
        const uri = result.edges[i].uri;
        const file = uri.startsWith('file:') ? fileURLToPath(uri) : uri;
        if (viewSet.has(file)) return;
        const g = uri.startsWith('file:') ? fileGraphIri(file) : uri;
        fileOf.set(g, file);
        read.push(rdf.quad(term(q.subject) as Quad['subject'], rdf.namedNode(q.predicate), term(q.object) as Quad['object'], rdf.namedNode(g)));
    });
    const store = new OxigraphStore();
    store.load(nquadsOf(readLegacy(read).quads), 'application/n-quads');
    const manifest = [...new Set(store.match(null, P.type, rdf.namedNode(NS.ws + 'Workspace')).map(q => q.graph.value))]
        .filter(g => fileOf.has(g)).sort((a, b) => cmp(fileOf.get(a)!, fileOf.get(b)!))[0];
    let settings: ReturnType<typeof readManifest> | undefined;
    if (manifest) {
        const quads = store.match(null, null, null, rdf.namedNode(manifest));
        settings = readManifest(quads, fileOf.get(manifest)!);
        for (const q of quads) store.delete(q);
        fileOf.delete(manifest);
    }
    const graph = newModelGraph(store);
    prefixTables.set(graph, settings?.prefixes ?? DEFAULT_PREFIXES);
    graphPrefixes(graph);
    graph.language = settings?.language;
    const modelGraphs = [...fileOf.keys()].map(g => rdf.namedNode(g));
    const views = new Map<string, string>(), skipped: { file: string; reason: string }[] = [];
    graph.update(() => {
        graph.setFileGraphs(modelGraphs);
        graph.setShapeSubjects(modelGraphs.flatMap(g => [...shapePart(store.match(null, null, null, g))]));
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
