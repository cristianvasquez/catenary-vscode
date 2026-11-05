// JSON terms, namespaces and IRI helpers; adapted from Catenary packages/model/src/terms.ts.

/**
 * The model resource (subject of dct:conformsTo and the label of the model, in the data file), and the graph name of the data in TriG text
 * (workspace files, test fixtures). Files contain this value: do not change it.
 */
export const UNION_GRAPH = 'urn:name:model';

export const NS = {
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
    owl: 'http://www.w3.org/2002/07/owl#',
    sh: 'http://www.w3.org/ns/shacl#',
    skos: 'http://www.w3.org/2004/02/skos/core#',
    dct: 'http://purl.org/dc/terms/',
    view: 'https://cristianvasquez.github.io/catenary/vocab/view#',
    ws: 'https://cristianvasquez.github.io/catenary/vocab/workspace#'
};


/** The published base of the Catenary vocabularies (view, workspace, notation). */
export const CATENARY_VOCAB = 'https://cristianvasquez.github.io/catenary/vocab/';


/**
 * The namespaces of earlier Catenary files and their published names. A read gives the new IRI for a
 * term in an old namespace; a write uses the new namespace only.
 */
const LEGACY_NAMESPACES: Readonly<Record<string, string>> = Object.fromEntries(
    ['view#', 'workspace#', 'notation#', 'notation/shapes#', 'notation/skos#', 'notation/classes#', 'notation/instances#', 'notation/marks#']
        .map(path => ['osg://vocab/' + path, CATENARY_VOCAB + path]));


/** The IRI with its legacy namespace replaced by the published one (LEGACY_NAMESPACES); another IRI unchanged. */
export function publishedIri(iri: string): string {
    if (!iri.startsWith('osg://vocab/')) return iri;
    for (const [old, now] of Object.entries(LEGACY_NAMESPACES)) if (iri.startsWith(old)) return now + iri.slice(old.length);
    return iri;
}


const XSD_STRING = NS.xsd + 'string';

export const RDF_TYPE = NS.rdf + 'type';

export const RDFS_LABEL = NS.rdfs + 'label';


/** An RDF term as JSON: IRIs and literals only. */
export interface TermJSON {
    termType: 'NamedNode' | 'Literal';
    value: string;
    datatype?: string;   // Literal only. Absent means xsd:string (or rdf:langString with language)
    language?: string;
}


/** The fields of an RDF/JS term that this package reads. */
export interface TermLike {
    termType: string;
    value: string;
    language?: string;
    datatype?: { value: string };
}


export function localName(iri: string): string {
    const m = /[#/:]([^#/:]+)[#/]?$/.exec(iri);
    return m ? decodeURIComponent(m[1]) : iri;
}


/** JSON form of an IRI or literal. Undefined for blank nodes and other terms. */
export function termToJSON(t: TermLike): TermJSON | undefined {
    if (t.termType === 'NamedNode') return { termType: 'NamedNode', value: t.value };
    if (t.termType === 'Literal') {
        const json: TermJSON = { termType: 'Literal', value: t.value };
        if (t.language) json.language = t.language;
        else if (t.datatype && t.datatype.value !== XSD_STRING) json.datatype = t.datatype.value;
        return json;
    }
    return undefined;
}


/** Stable text of a term, for sorting and comparison. */
export function termKey(t: TermJSON): string {
    return t.termType === 'NamedNode' ? `<${t.value}>` : `"${t.value}"@${t.language ?? ''}^^${t.datatype ?? ''}`;
}

