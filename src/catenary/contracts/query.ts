// Host query port, namespaces and SPARQL IRI escaping; adapted from Catenary packages/contracts/src/query.ts.

export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

export const XSD = 'http://www.w3.org/2001/XMLSchema#';

export const SH = 'http://www.w3.org/ns/shacl#';

export const OWL = 'http://www.w3.org/2002/07/owl#';


/** An RDF term of a query result. */
export interface QueryTerm { termType: string; value: string }


/** The store of the host, for SPARQL SELECT over the graphs of the files. */
export interface QueryPort {
    select(query: string): readonly Record<string, QueryTerm>[];
    /** `GRAPH <variable> { pattern }` over the graphs of the files (not the validation report). Variable default: `?g`. */
    graph(pattern: string, variable?: string): string;
    /** The display label of each IRI (the label rule of the host). */
    labels(iris: readonly string[]): Map<string, string>;
}


/** An IRI as SPARQL text. Refuses a value that would change the query. */
export function iri(value: string): string {
    if (/[<>"{}|^`\\\s\u0000-\u001f]/.test(value)) throw new Error('Invalid IRI in a query.');
    return `<${value}>`;
}

