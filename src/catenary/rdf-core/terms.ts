// RDF factory and string order; adapted from Catenary packages/rdf-core/src/terms.ts.
import rdf from 'rdf-ext';


/** String order: -1, 0, 1. */
export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export { rdf };
