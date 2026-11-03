// Convert turtle/graph nodes and edges to workspace quads, one per edge; named graphs and triple terms are absent from that API.
import type { GraphNode, GraphResult } from "./turtle-api"

// Structural term types include blank nodes as returned by turtle-lsp.

interface TermJSON {
  termType: "NamedNode" | "BlankNode" | "Literal"
  value: string
  /** Literal only. Absent means xsd:string (or rdf:langString with language). */
  datatype?: string
  language?: string
}
/** An RDF 1.2 triple term. `turtle/graph` gives none: turtle-lsp leaves triple terms out. */
interface TripleTerm {
  termType: "Triple"
  value: ""
  subject: NTerm
  predicate: TermJSON
  object: NTerm
}
export type NTerm = TermJSON | TripleTerm
/** A triple of the union of all graphs. */
export interface NQuad {
  subject: TermJSON
  predicate: string
  object: NTerm
}


const XSD = "http://www.w3.org/2001/XMLSchema#"
const XSD_STRING = `${XSD}string`

/** Prefixes that turtle-lsp can write in a datatype name without a node of that namespace in the result (its bundled vocabularies). */
const WELL_KNOWN: Record<string, string> = {
  xsd: XSD,
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
}

interface NamespaceFacet {
  iri: string
  prefix?: string | null
}

/** Prefix to namespace: the `facets.namespaces` of the result, else the well-known ones. */
function prefixesOf(result: GraphResult): Map<string, string> {
  const map = new Map(Object.entries(WELL_KNOWN))
  const namespaces = (result.facets as { namespaces?: NamespaceFacet[] } | undefined)?.namespaces ?? []
  for (const ns of namespaces) if (ns.prefix) map.set(ns.prefix, ns.iri)
  return map
}

/**
 * A literal node as a term. The text comes from the id (`"<text>"#<document>:<triple>`, the full text); the language tag or the
 * datatype from the end of the name (`"<text, at most 60 characters>"@<tag>` or `^^<prefixed name or <iri>>`). A prefixed datatype
 * whose prefix is not known stays as written.
 */
function literalOf(node: Pick<GraphNode, "id" | "name">, prefixes: Map<string, string>): TermJSON {
  const value = node.id.slice(1, node.id.lastIndexOf("#") - 1)
  const suffix = node.name.slice(node.name.lastIndexOf('"') + 1)
  const term: TermJSON = { termType: "Literal", value }
  if (suffix.startsWith("@")) term.language = suffix.slice(1)
  else if (suffix.startsWith("^^")) {
    const dt = suffix.slice(2)
    const colon = dt.indexOf(":")
    const datatype = dt.startsWith("<") ? dt.slice(1, -1) : prefixes.has(dt.slice(0, colon)) ? prefixes.get(dt.slice(0, colon)) + dt.slice(colon + 1) : dt
    if (datatype !== XSD_STRING) term.datatype = datatype
  }
  return term
}

/** A node as a term. Blank node ids stay as given (`_:<document>:<n>`). */
function termOf(node: GraphNode, prefixes: Map<string, string>): TermJSON {
  if (node.literal) return literalOf(node, prefixes)
  if (node.id.startsWith("_:")) return { termType: "BlankNode", value: node.id }
  return { termType: "NamedNode", value: node.id }
}

/** The quads of `result`: one per edge, in edge order. */
export function quadsOf(result: GraphResult): NQuad[] {
  const prefixes = prefixesOf(result)
  const terms = result.nodes.map((n) => termOf(n, prefixes))
  return result.edges.map((e) => ({ subject: terms[e.source], predicate: e.predicate, object: terms[e.target] }))
}
