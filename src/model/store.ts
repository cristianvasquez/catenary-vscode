// Execute view-only transactions, replay undo patches and serialize one view graph without writing model files.
import type { ViewCommand } from '../catenary/model/commands';
import { iriId } from '../catenary/model/ids';
import type { Patch } from '../catenary/rdf-core/graph';
import { authoringMetamodel } from '../catenary/rdf/authoring';
import { executeCommand, mapCommandIds } from '../catenary/rdf/commands';
import type { ModelGraph } from '../catenary/rdf/graph';
import { type Result } from '../catenary/rdf/ops';
import { buildVocabulary, shapesTriples, vocabularyQuads } from '../catenary/rdf/shapes';
import { shapesIndexOf } from '../catenary/rdf/shapes-read';
import { rdf, termKey } from '../catenary/rdf/terms';
import { views } from '../catenary/rdf/views';
import { ViewQuads, viewText } from '../edit/view-quads';
import { graphPrefixes } from './graph-input';

/** View-only transactions. The graph owns rollback and cache invalidation, including history replay. */
export class ViewStore {
    /** The patch of the last recorded step; a command that changes nothing records none. The editor undoes this patch (no history limit). */
    last?: Patch;

    /** `graph`: the workspace graph; a reload sets the new one (the view quads stay, src/node/workspace-model.ts). */
    constructor(public graph: ModelGraph) {}

    execute(command: ViewCommand): Result<unknown> {
        graphPrefixes(this.graph);
        const index = shapesIndexOf(this.graph);
        const resolved = mapCommandIds(command, x => typeof x === 'string' && x.includes(':')
            ? index.byTerm.get(termKey(rdf.namedNode(x))) ?? iriId(x) : x);
        const { result, patch } = this.graph.transact(g => {
            const dataset = rdf.dataset([...shapesTriples(g), ...vocabularyQuads(g).map(q => rdf.quad(q.subject, q.predicate, q.object))]);
            const meta = authoringMetamodel(g, buildVocabulary(dataset, g.language));
            return executeCommand(g, meta, resolved);
        });
        if (result.ok && patch.length) {
            this.last = patch;
        }
        return result;
    }

    viewIris(): string[] { return views(this.graph).map(v => v.value); }

    /** Deterministic TriG, retaining the named graph and RDF 1.2 triple terms. No file I/O. */
    viewText(viewIri: string): string {
        graphPrefixes(this.graph);
        const view = rdf.namedNode(viewIri);
        return viewText(new ViewQuads(this.graph.match(null, null, null, view), view));
    }
}
