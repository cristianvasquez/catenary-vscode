// RDF factory and JSON term types for the graph engine; adapted from Catenary packages/rdf-core/src/terms.ts.
import rdf from 'rdf-ext';


/** An RDF term as JSON: IRIs and literals only. The Catenary model package has the same type (TermJSON) for the browser. */
export interface TermJSON {
    termType: 'NamedNode' | 'Literal';
    value: string;
    /** Literal only. Absent means xsd:string (or rdf:langString with a language). */
    datatype?: string;
    language?: string;
}


export function jsonToTerm(t: TermJSON) {
    if (t.termType === 'NamedNode') return rdf.namedNode(t.value);
    if (t.language) return rdf.literal(t.value, t.language);
    return rdf.literal(t.value, t.datatype ? rdf.namedNode(t.datatype) : undefined);
}
export { rdf };
