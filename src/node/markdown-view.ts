// Metadata only: reuse the view-file parser and legacy normalization of the canvas.
import { parseRdfSync } from '../catenary/rdf-files/oxigraph-store';
import { readLegacy } from '../catenary/rdf/loader';
import { viewIriOf } from '../model/graph-input';

export interface View { iri: string; name?: string }

export function readView(text: string): View {
    const { quads } = readLegacy(parseRdfSync(text, 'application/trig'));
    const iri = viewIriOf(text);
    const name = quads.find(q => q.subject.value === iri && q.graph.value === iri
        && q.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#label')?.object.value;
    return { iri, name };
}
