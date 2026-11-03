// Relation rules and provider contract; adapted from Catenary packages/contracts/src/links.ts.


export interface LinkRule {
    /** The class of the subject. */
    domain: string;
    predicate: string;
    /** The class of the object. None: an instance of any class. */
    target?: string;
    /** Classes whose instances also count as an instance of `target` (RDFS: its written subclasses). */
    targetSubclasses?: string[];
    /** Written label of the predicate. None: the host names it from its IRI. */
    name?: string;
    description?: string;
    minCount?: number;
    maxCount?: number;
    order?: number;
    /**
     * The object is a concept of a scheme or a member of a collection (`target` skos:Concept): its IRI and the allowed objects.
     * No `values`: the concepts of scheme `iri` (the host knows the SKOS vocabulary).
     */
    valueSet?: { iri: string; values?: string[] };
}
