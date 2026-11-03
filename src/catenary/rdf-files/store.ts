// Quad store and query binding interfaces; adapted from Catenary packages/rdf-files/src/store.ts.
import type { Quad, Term } from '@rdfjs/types';


export type Bindings = Record<string, Term>;


export interface QuadStore {
    readonly size: number;
    has(q: Quad): boolean;
    add(q: Quad): void;
    delete(q: Quad): void;
    /** Add the quads of RDF text at once (for example application/n-quads). No change events. */
    load(text: string, mediaType: string): void;
    /** Quads that match the pattern. null or undefined: any term. */
    match(s?: Term | null, p?: Term | null, o?: Term | null, g?: Term | null): Quad[];
    /** Result rows of a SPARQL SELECT. */
    select(query: string): Bindings[];
    /** The triples of a SPARQL CONSTRUCT (default graph quads). */
    construct(query: string): Quad[];
}

