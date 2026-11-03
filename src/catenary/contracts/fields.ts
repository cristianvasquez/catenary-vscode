// Field rules and provider contract; adapted from Catenary packages/contracts/src/fields.ts.


/** A value of a closed list (sh:in). A literal without a datatype is an xsd:string (or an rdf:langString with a language). */
export interface FieldValue {
    termType: 'NamedNode' | 'Literal';
    value: string;
    datatype?: string;
    language?: string;
}


export interface FieldRule {
    /** The class of the subject. A field of rdfs:label: the form edits the label. */
    domain: string;
    predicate: string;
    /** Written label of the predicate. None: the host names it from its IRI. */
    name?: string;
    description?: string;
    /** The datatype of the literals. None: any literal (or any IRI with `iri`). */
    datatype?: string;
    /** The values are IRIs, not literals (sh:nodeKind sh:IRI). */
    iri?: boolean;
    /** The allowed values (sh:in). */
    in?: FieldValue[];
    minCount?: number;
    maxCount?: number;
    order?: number;
}
