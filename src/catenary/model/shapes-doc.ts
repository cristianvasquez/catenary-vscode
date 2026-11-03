// SHACL records, range labels, paths and prefixes; adapted from Catenary packages/model/src/shapes-doc.ts.
import { nameFromURI } from 'canonical-md';
import { ShapeTargets } from '../shacl/common/index';
import { NS, TermJSON, localName } from './terms';


/** A SHACL property path. `unsupported`: zero-or-more and the other repetition paths; shown as text, kept in the file. */
export type PathJSON =
    | { kind: 'iri'; iri: string }
    | { kind: 'inverse'; path: PathJSON }
    | { kind: 'sequence'; items: PathJSON[] }
    | { kind: 'alternative'; items: PathJSON[] }
    | { kind: 'unsupported'; text: string };


export const NODE_KINDS = ['IRI', 'Literal', 'BlankNode', 'BlankNodeOrIRI', 'BlankNodeOrLiteral', 'IRIOrLiteral'] as const;

export type NodeKind = typeof NODE_KINDS[number];


/** What the values of a property shape are. The canvas draws one target for each property shape. */
export type Range =
    | { kind: 'node'; shape: string }          // sh:node, a node shape (id)
    | { kind: 'class'; class: string }         // sh:class
    | { kind: 'datatype'; datatype: string }
    | { kind: 'nodeKind'; nodeKind: NodeKind }
    | { kind: 'in'; values: TermJSON[] }
    | { kind: 'scheme'; schemes: string[] }    // skos:Concept in one of these schemes (sh:node to a shape with skos:inScheme)
    | { kind: 'collection'; collection: string } // a member of a skos:Collection (sh:node to a shape with sh:in of the members)
    | { kind: 'or'; alternatives: SimpleRange[] } // sh:or of shapes that each have one range: a value matches one of them
    | { kind: 'any' };


/** A range that is not an "or" and not "any": an alternative of an "or" range. */
export type SimpleRange = Exclude<Range, { kind: 'or' } | { kind: 'any' }>;


/** The alternatives of a range: its own for "or", else the range itself ("any": none). */
export function alternativesOf(r: Range): SimpleRange[] {
    return r.kind === 'or' ? r.alternatives : r.kind === 'any' ? [] : [r];
}


/** Stable text of a range (ids and comparisons). */
export function rangeKey(r: Range): string {
    switch (r.kind) {
        case 'node': return 'node:' + r.shape;
        case 'class': return 'class:' + r.class;
        case 'datatype': return 'datatype:' + r.datatype;
        case 'nodeKind': return 'nodeKind:' + r.nodeKind;
        case 'in': return 'in:' + r.values.map(v => v.value).join(' ');
        case 'scheme': return 'scheme:' + r.schemes.join(' ');
        case 'collection': return 'collection:' + r.collection;
        case 'or': return 'or:' + r.alternatives.map(rangeKey).join('|');
        case 'any': return 'any';
    }
}


/** A SKOS concept scheme or collection of the shapes files: the target node of a property with a value set. */
export interface ValueSet {
    id: string;
    uri: string;
    kind: 'scheme' | 'collection';
    /** skos:prefLabel (no language or English first), else rdfs:label, else the local name. */
    label: string;
    file: string;
    /** Concepts: in a scheme skos:inScheme (or skos:hasTopConcept); in a collection skos:member. By label. */
    members: { uri: string; label: string; broader?: string[] }[];
}


export type LogicalOperator = 'or' | 'xone' | 'and' | 'not';


export interface NodeShape extends ShapeTargets {
    id: string;
    uri: string;
    label: string;                  // sh:name, else rdfs:label, else the local name
    closed?: boolean;
    /** sh:description, else rdfs:comment (pickLabel). */
    description?: string;
    /** Language tag of the literal that `description` shows; undefined: a plain literal. An edit replaces that literal only. */
    descriptionLanguage?: string;
    /** Shapes file that holds the shape (absolute path, or the graph IRI when unknown). */
    file: string;
    /** Property shapes: sh:property and the members of logical constraints, in id order. */
    properties: string[];
    constraints: string[];
    /** Statements that the editor does not map, as "predicate object" text. They stay in the file. */
    raw: string[];
}


export interface PropertyShape {
    id: string;
    /** IRI of the property shape (undefined: a blank node, before the blank nodes are replaced). */
    uri?: string;
    owner: string;                  // node shape id
    /** Logical constraint that holds it (a list member), else it is an sh:property of the owner. */
    constraint?: string;
    path: PathJSON;
    /** sh:name (pickLabel in the workspace language). */
    name?: string;
    /** Language tag of the literal that `name` shows; undefined: a plain literal. An edit replaces that literal only. */
    nameLanguage?: string;
    /** sh:description (pickLabel in the workspace language). */
    description?: string;
    /** Language tag of the literal that `description` shows; undefined: a plain literal. */
    descriptionLanguage?: string;
    minCount?: number;
    maxCount?: number;
    range: Range;
    /** sh:nodeKind next to another range (for example IRI with sh:class). */
    nodeKind?: NodeKind;
    /** sh:node that is not a node shape of the shapes files (IRI), or an inline shape. */
    nodeRef?: string;
    pattern?: string;
    minLength?: number;
    maxLength?: number;
    languageIn?: string[];
    order?: number;
    raw: string[];
}


export interface LogicalConstraint {
    id: string;
    owner: string;
    operator: LogicalOperator;
    members: string[];
    /** List members that are not property shapes (no sh:path), as text. */
    raw: string[];
}


export interface ShapesModel {
    nodeShapes: Record<string, NodeShape>;
    properties: Record<string, PropertyShape>;
    constraints: Record<string, LogicalConstraint>;
    valueSets: Record<string, ValueSet>;
}


export function emptyShapes(): ShapesModel {
    return { nodeShapes: {}, properties: {}, constraints: {}, valueSets: {} };
}


/** The value set (id) that a range points to, if any. */
export function valueSetOf(shapes: ShapesModel, r: Range): string | undefined {
    const uri = r.kind === 'scheme' && r.schemes.length === 1 ? r.schemes[0] : r.kind === 'collection' ? r.collection : undefined;
    return uri ? Object.values(shapes.valueSets).find(v => v.uri === uri)?.id : undefined;
}


// ------------------------------------------------------------------ prefixes

/**
 * Default prefixes: the prefix table of a new workspace, and of a workspace file without prefix declarations. A workspace file stores
 * its table (sh:declare in the manifest graph); the user edits it with the Prefixes editor.
 */
export const DEFAULT_PREFIXES: Readonly<Record<string, string>> = {
    adms: 'http://www.w3.org/ns/adms#',
    dcat: 'http://www.w3.org/ns/dcat#',
    dct: NS.dct,
    dprod: 'https://ekgf.github.io/dprod/',
    foaf: 'http://xmlns.com/foaf/0.1/',
    locn: 'http://www.w3.org/ns/locn#',
    odrl: 'http://www.w3.org/ns/odrl/2/',
    org: 'http://www.w3.org/ns/org#',
    owl: NS.owl,
    prov: 'http://www.w3.org/ns/prov#',
    rdf: NS.rdf,
    rdfs: NS.rdfs,
    schema: 'https://schema.org/',
    sh: NS.sh,
    skos: NS.skos,
    time: 'http://www.w3.org/2006/time#',
    vann: 'http://purl.org/vocab/vann/',
    vcard: 'http://www.w3.org/2006/vcard/ns#',
    view: NS.view,
    ws: NS.ws,
    xsd: NS.xsd
};


/**
 * The prefix table of the open workspace: compact IRIs in the editor, IRI fields, and the Turtle and TriG writers. One table for each
 * process (the backend has one model; the frontend sets it from each snapshot with `setPrefixes`).
 */
export const PREFIXES: Record<string, string> = { ...DEFAULT_PREFIXES };

/** Replace the prefix table. The object `PREFIXES` stays the same (the writers hold it). */
export function setPrefixes(prefixes: Readonly<Record<string, string>>): void {
    for (const k of Object.keys(PREFIXES)) delete PREFIXES[k];
    Object.assign(PREFIXES, prefixes);
}


/** "prefix:local" of an IRI with a known prefix; else undefined. */
export function compactParts(iri: string): { prefix: string; local: string } | undefined {
    let best: { prefix: string; local: string } | undefined;
    for (const [prefix, ns] of Object.entries(PREFIXES)) {
        if (!iri.startsWith(ns) || iri.length === ns.length) continue;
        const local = iri.slice(ns.length);
        if (!/^[A-Za-z_][\w.-]*$/.test(local)) continue;
        if (!best || ns.length > PREFIXES[best.prefix].length) best = { prefix, local };
    }
    return best;
}


/** Compact IRI: "dcat:theme", else the IRI in angle brackets. */
export function compactIri(iri: string): string {
    if (iri.startsWith('urn:name:')) return nameFromURI({ termType: 'NamedNode', value: iri } as Parameters<typeof nameFromURI>[0]) ?? `<${iri}>`;
    const c = compactParts(iri);
    return c ? `${c.prefix}:${c.local}` : `<${iri}>`;
}


/** Short text of an IRI for labels: "dcat:theme", else the local name. */
export function shortIri(iri: string): string {
    if (iri.startsWith('urn:name:')) return nameFromURI({ termType: 'NamedNode', value: iri } as Parameters<typeof nameFromURI>[0]) ?? localName(iri);
    const c = compactParts(iri);
    return c ? `${c.prefix}:${c.local}` : localName(iri);
}


// ------------------------------------------------------------------ paths

/** Path as text in SPARQL property path syntax: "a/b", "a|b", "^a". IRIs compact. */
export function formatPath(p: PathJSON, iri: (i: string) => string = compactIri): string {
    const inner = (x: PathJSON, parent: 'sequence' | 'alternative' | 'inverse') => {
        const t = formatPath(x, iri);
        const needs = (x.kind === 'alternative' && parent !== 'alternative') || (x.kind === 'sequence' && parent === 'inverse');
        return needs ? `(${t})` : t;
    };
    switch (p.kind) {
        case 'iri': return iri(p.iri);
        case 'inverse': return '^' + inner(p.path, 'inverse');
        case 'sequence': return p.items.map(x => inner(x, 'sequence')).join('/');
        case 'alternative': return p.items.map(x => inner(x, 'alternative')).join('|');
        case 'unsupported': return p.text;
    }
}


// ------------------------------------------------------------------ cardinality

/** "1", "0..1", "1..*", "0..*" (no min and no max), "2..5". */
export function cardinalityText(min?: number, max?: number): string {
    const lo = min ?? 0;
    if (max === undefined) return `${lo}..*`;
    return lo === max ? String(lo) : `${lo}..${max}`;
}


function termText(t: TermJSON): string {
    if (t.termType === 'NamedNode') return shortIri(t.value);
    return t.language ? `"${t.value}"@${t.language}` : t.value;
}


/** Text of a range for a pill or a row: "xsd:string", "IRI", "{a, b, +3}", "scheme: Status", "Agent". */
export function rangeText(shapes: ShapesModel, r: Range, schemeLabel: (iri: string) => string = localName, max = 3): string {
    switch (r.kind) {
        case 'node': return shapes.nodeShapes[r.shape]?.label ?? 'missing shape';
        case 'class': return shortIri(r.class);
        case 'datatype': return shortIri(r.datatype);
        case 'nodeKind': return r.nodeKind;
        case 'in': {
            const shown = r.values.slice(0, r.values.length > max ? max - 1 : max).map(termText);
            return `{${shown.join(', ')}${r.values.length > shown.length ? `, +${r.values.length - shown.length}` : ''}}`;
        }
        case 'scheme': return r.schemes.map(schemeLabel).join(' | ');
        case 'collection': return schemeLabel(r.collection);
        case 'or': return r.alternatives.map(a => rangeText(shapes, a, schemeLabel, max)).join(' | ');
        case 'any': return 'any';
    }
}


/** A value set range (SKOS scheme or collection): always an edge to the node of the value set, never a row. */
export function isValueSetRange(r: Range): boolean {
    return r.kind === 'scheme' || r.kind === 'collection';
}


/** Color of a namespace for edge labels: a stable pick from a small palette. All urn:name IRIs share the namespace "urn:name:". */
function namespaceColor(iri: string): string {
    const c = compactParts(iri);
    const ns = iri.startsWith('urn:name:') ? 'urn:name:' : c ? PREFIXES[c.prefix] : iri.replace(/[^#/]*$/, '');
    let h = 0;
    for (let i = 0; i < ns.length; i++) h = (h * 31 + ns.charCodeAt(i)) >>> 0;
    return NS_COLORS[h % NS_COLORS.length];
}

const NS_COLORS = ['#5ad3c4', '#e070c8', '#e0a050', '#7aa7ff', '#9bd46a', '#f07a7a'];


/** A part of a label. `prefix`: the prefix of the next part (a local name). `hidden`: not drawn (the prefix urn:name:). */
export interface LabelPart { text: string; color?: string; prefix?: boolean; hidden?: boolean }


/** The prefix of canonical-md names. It is a prefix that is not drawn: `<urn:name:reads>` shows "reads". */
export const NAME_PREFIX = 'urn:name:';


/**
 * Label parts of an IRI: the prefix part, then the local name in the color of the namespace. `local`: the text of the local name, when
 * the label is not the local name of the IRI (sh:name). An IRI without a prefix: one part in the color of its namespace.
 */
export function iriParts(iri: string, local?: string): LabelPart[] {
    const color = namespaceColor(iri);
    if (iri.startsWith(NAME_PREFIX)) return [{ text: NAME_PREFIX, prefix: true, hidden: true }, { text: local ?? compactIri(iri), color }];
    const c = compactParts(iri);
    if (c) return [{ text: c.prefix + ':', prefix: true }, { text: local ?? c.local, color }];
    return [{ text: local ?? compactIri(iri), color }];
}


/**
 * Label parts of a path: the parts of each IRI (iriParts), and the operators. The drawn texts joined give formatPath. Built from the path,
 * not from its text: a name can contain an operator character.
 */
export function pathParts(p: PathJSON): LabelPart[] {
    const parts: LabelPart[] = [];
    const add = (x: PathJSON, parent?: 'sequence' | 'alternative' | 'inverse') => {
        const needs = (x.kind === 'alternative' && !!parent && parent !== 'alternative') || (x.kind === 'sequence' && parent === 'inverse');
        if (needs) parts.push({ text: '(' });
        switch (x.kind) {
            case 'iri': parts.push(...iriParts(x.iri)); break;
            case 'inverse': parts.push({ text: '^' }); add(x.path, 'inverse'); break;
            case 'sequence': x.items.forEach((y, i) => { if (i) parts.push({ text: '/' }); add(y, 'sequence'); }); break;
            case 'alternative': x.items.forEach((y, i) => { if (i) parts.push({ text: '|' }); add(y, 'alternative'); }); break;
            case 'unsupported': parts.push({ text: x.text }); break;
        }
        if (needs) parts.push({ text: ')' });
    };
    add(p);
    return parts;
}
