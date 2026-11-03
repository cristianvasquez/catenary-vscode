// Type declarations for the canonical-md name/IRI conversion functions used by the model readers.
declare module 'canonical-md' {
    import type { NamedNode, Term } from '@rdfjs/types';
    export function nameFromURI(term: Term): string | null;
    export function nameToURI(name: string): NamedNode;
}
