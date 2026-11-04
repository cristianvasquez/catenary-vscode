// The halo, "+ member" and insert picker choices from turtle/query answers (model/choices.ts and rdf/link-choices.ts over the port).
import type { Term } from '@rdfjs/types';
import { type Doc, type Instance, boxes, elementOfId } from '../catenary/model/doc';
import { pickLabel } from '../catenary/model/labels';
import { type Choices, neighborChoices, shapeSourceChoices } from '../catenary/model/prompts';
import { shortIri } from '../catenary/model/shapes-doc';
import { NS } from '../catenary/model/terms';
import { UNION_GRAPH } from '../catenary/rdf/files';
import { elementId, elementTerm, relationId, relationTriple } from '../catenary/rdf/ids';
import { rdf, termKey } from '../catenary/rdf/terms';
import { labelFromIri, labelLiterals } from '../catenary/rdf/vocabulary';
import { reasonText } from '../catenary/shacl/common';
import type { FocusNode } from '../catenary/shacl/common/index';
import { byDocumentKind, documentSets, type DocumentRow } from './documents';
import { type ModelContext, drawFromText } from './diagram';
import type { KeptPrefetch } from './figures';
import { applyPrefixes } from './manifest';
import { inShapesOf } from './neighbors';
import { bindings, shapeTargetMatches } from './targets';
import { legacyRows } from './view';

/** The IRI prefix of a blank node in a port answer (port.ts, toEngine). */
const BLANK = 'urn:skolem:blank:';
const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX rdfs: <${NS.rdfs}> PREFIX skos: <${NS.skos}> PREFIX sh: <${NS.sh}>`;
const TYPE = NS.rdf + 'type', LABEL = NS.rdfs + 'label', PATH = NS.sh + 'path';
const SKOS_TYPES = new Set(['ConceptScheme', 'Concept', 'Collection'].map(t => NS.skos + t));
const SKOS_MEMBERSHIP = new Set(['inScheme', 'topConceptOf'].map(p => NS.skos + p));
/** The statements that make an IRI subject an instance, and its label statements, by model document kind. */
const INSTANCE_ROWS = `${PREFIXES} SELECT ?s ?p ?o WHERE { ?s ?p ?o
    VALUES ?p { rdf:type rdfs:label skos:prefLabel sh:name skos:inScheme skos:topConceptOf } FILTER (isIRI(?s)) }`;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const named = (value: string): FocusNode => ({ termType: 'NamedNode', value });

/** The rows of `query(clause)` for `iris` bound to `?variable` (VALUES by document kind; a blank node among `iris` is left out). */
async function rowsOf(ctx: ModelContext, variable: string, iris: string[], query: (clause: string) => string, files = ctx.modelFiles): Promise<DocumentRow[]> {
    if (!iris.length || !files.length) return [];
    return (await Promise.all(bindings(variable, iris.map(named)).map(({ clause }) => byDocumentKind(ctx.port, documentSets(ctx.shapes, files), query(clause))))).flat();
}

/**
 * IRI → label of each instance of the model, sorted by IRI (instanceLabels of model/choices.ts): a subject with rdf:type or rdfs:label outside
 * the shapes of its document, or a SKOS subject of the shapes that has a statement outside the shapes. The label by the manifest language.
 * `vocabulary` (the insert picker): also every SKOS subject of the shapes, labelled from its shapes statements when it has none outside.
 */
export async function instanceLabels(ctx: ModelContext, options: { vocabulary?: boolean } = {}): Promise<Map<string, string>> {
    const inShapes = inShapesOf(ctx.shapes);
    const rows = legacyRows(await byDocumentKind(ctx.port, documentSets(ctx.shapes, ctx.modelFiles), INSTANCE_ROWS));
    const modelRows = rows.filter(r => !inShapes(r.kind, r.s));
    const instances = new Set(modelRows.filter(r => r.p.value === TYPE || r.p.value === LABEL).map(r => r.s.value));
    const inUnion = new Set(modelRows.map(r => r.s.value));
    const vocabulary = new Set(rows.filter(r => inShapes(r.kind, r.s) && ((r.p.value === TYPE && SKOS_TYPES.has(r.o.value)) || SKOS_MEMBERSHIP.has(r.p.value))).map(r => r.s.value));
    // A SKOS subject of the shapes counts when it has a statement outside the shapes (the old pipeline reads the subjects of the model graph).
    const open = [...vocabulary].filter(s => !instances.has(s) && !inUnion.has(s));
    for (const r of await rowsOf(ctx, 's', open, clause => `SELECT DISTINCT ?s WHERE { ?s ?p ?o ${clause} }`)) {
        if (!inShapes(r.kind, r.s)) inUnion.add(r.s.value);
    }
    for (const s of vocabulary) if (inUnion.has(s)) instances.add(s);
    const shapesOnly = options.vocabulary ? new Set([...vocabulary].filter(s => !instances.has(s))) : new Set<string>();
    for (const s of shapesOnly) instances.add(s);
    instances.delete(UNION_GRAPH);
    const objects = new Map<string, Map<string, Term[]>>();
    for (const r of [...modelRows, ...rows.filter(r => shapesOnly.has(r.s.value))]) {
        const bySubject = objects.get(r.s.value) ?? objects.set(r.s.value, new Map()).get(r.s.value)!;
        (bySubject.get(r.p.value) ?? bySubject.set(r.p.value, []).get(r.p.value)!).push(r.o);
    }
    return new Map([...instances].sort(cmp).map(s => [s, pickLabel(labelLiterals(p => objects.get(s)?.get(p) ?? []), ctx.manifest.language) ?? labelFromIri(s)]));
}

/** The predicates of the instance test (factsOf of neighbors.ts) and of the label rule (pickLabel; labelsOf: else the sh:path). */
const FACTS = `VALUES ?q { rdf:type rdfs:label skos:prefLabel sh:name sh:path skos:inScheme skos:topConceptOf }`;

/** IRI → predicate → objects of the FACTS predicates, from one answer. */
type Facts = Map<string, Map<string, Term[]>>;

function addFact(facts: Facts, s: Term | undefined, p: Term | undefined, o: Term | undefined): void {
    if (s?.termType !== 'NamedNode' || !p || !o) return;
    const bySubject = facts.get(s.value) ?? facts.set(s.value, new Map()).get(s.value)!;
    const objects = bySubject.get(p.value) ?? bySubject.set(p.value, []).get(p.value)!;
    if (!objects.some(x => x.equals(o))) objects.push(o);
}

/**
 * The instance test of factsOf (neighbors.ts) on one answer over every model document: an IRI that is not a shapes subject is an instance
 * with rdf:type or rdfs:label; a shapes subject, with a SKOS type or a SKOS membership statement. One answer has no document kind: a
 * statement of a shapes subject in a data document counts as a shapes statement.
 */
function isInstance(ctx: ModelContext, facts: Facts, iri: string): boolean {
    const own = facts.get(iri);
    if (!own || iri === UNION_GRAPH) return false;
    if (!ctx.shapes.shapeSubjects.has(termKey(rdf.namedNode(iri)))) return own.has(TYPE) || own.has(LABEL);
    return (own.get(TYPE) ?? []).some(t => SKOS_TYPES.has(t.value)) || [...SKOS_MEMBERSHIP].some(p => own.has(p));
}

/** The label of `iri` (the label rule by the manifest language); `path`: else its first sh:path (labelsOf); else from the IRI. */
function labelOf(ctx: ModelContext, facts: Facts, iri: string, path = false): string {
    const objects = (p: string) => facts.get(iri)?.get(p) ?? [];
    const paths = path ? objects(PATH).map(o => o.value).filter(v => !v.startsWith('urn:skolem:')).sort() : [];
    return pickLabel(labelLiterals(objects), ctx.manifest.language) ?? labelFromIri(paths[0] ?? iri);
}

/** The FACTS statements of `iris` in the model documents: one turtle/query (none for no IRI). */
async function factsOfIris(ctx: ModelContext, iris: string[]): Promise<Facts> {
    const facts: Facts = new Map();
    const [binding] = bindings('s', iris.map(named));
    if (!binding || !ctx.modelFiles.length) return facts;
    for (const r of await ctx.port.select(`${PREFIXES} SELECT DISTINCT ?s ?q ?v WHERE { ${binding.clause} ${FACTS} ?s ?q ?v }`, ctx.modelFiles)) addFact(facts, r.s, r.q, r.v);
    return facts;
}

/** An instance record from its facts (instanceRecords of rdf/records.ts: the label and the types; no fields). */
const instanceOf = (ctx: ModelContext, facts: Facts, iri: string): Instance => ({
    id: elementId(rdf.namedNode(iri)), uri: iri, label: labelOf(ctx, facts, iri),
    types: [...new Set((facts.get(iri)?.get(TYPE) ?? []).map(t => t.value))].sort(cmp), fields: {}
});

/** Unshown instances for a shape, or unshown applicable shapes for an instance (shapeTargetChoices of rdf/link-choices.ts). */
async function shapeTargetChoices(ctx: ModelContext, doc: Doc, viewId: string, from: string, kept?: KeptPrefetch): Promise<Choices | undefined> {
    const view = doc.views[viewId];
    if (!view) return undefined;
    const element = elementOfId(view, from);
    const shown = new Set(boxes(view, 'card').map(card => card.element));
    const shape = doc.shapes.nodeShapes[element];
    if (shape) {
        const found = (await shapeTargetMatches(ctx.port, ctx.modelFiles, ctx.shapes, { shapes: [shape.uri] })).filter(m => m.node.termType === 'NamedNode');
        const unshown = found.filter(m => !shown.has(elementId(rdf.namedNode(m.node.value))));
        const facts = await factsOfIris(ctx, unshown.map(m => m.node.value));
        const matches = unshown.filter(m => isInstance(ctx, facts, m.node.value));
        if (!matches.length) return undefined;
        applyPrefixes(ctx.manifest);
        return {
            title: `${shape.label}: instances (${matches.length} not in the view)`,
            items: matches.map(m => ({ label: labelOf(ctx, facts, m.node.value, true),
                description: reasonText(m.reasons, shortIri), ids: [elementId(rdf.namedNode(m.node.value))] }))
                .sort((a, b) => a.label.localeCompare(b.label) || a.ids[0].localeCompare(b.ids[0]))
        };
    }
    // The record of the view's answer (kept by the last draw), else one query for the instance test and the label.
    const iri = elementTerm(element)?.value;
    if (!iri || !doc.instances[element]) return undefined;
    let instance = kept?.records?.instances[element];
    if (!instance) {
        const facts = await factsOfIris(ctx, [iri]);
        if (!isInstance(ctx, facts, iri)) return undefined;
        instance = instanceOf(ctx, facts, iri);
    }
    const matches = await shapeTargetMatches(ctx.port, ctx.modelFiles, ctx.shapes, { nodes: [named(instance.uri)] });
    const shapes = matches.flatMap(match => {
        const shape = Object.values(doc.shapes.nodeShapes).find(s => s.uri === match.shape);
        return shape && !shown.has(shape.id) ? [{ ...shape, reasons: match.reasons }] : [];
    });
    if (!shapes.length) return undefined;
    applyPrefixes(ctx.manifest);
    return {
        title: `${instance.label}: applicable node shapes (${shapes.length} not in the view)`,
        items: shapes.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
            .map(shape => ({ label: shape.label, description: reasonText(shape.reasons, shortIri), ids: [shape.id] }))
    };
}

/**
 * The neighbours of `iri` in `dir` and the FACTS statements of `iri` and of each neighbour: one turtle/query. A neighbour: the other end
 * of a statement other than rdf:type and rdfs:label, an IRI.
 */
async function neighborsOf(ctx: ModelContext, iri: string, dir: 'in' | 'out'): Promise<{ edges: { p: string; n: string }[]; facts: Facts }> {
    const self = `<${iri}>`;
    const around = (p: string, n: string) => `${dir === 'out' ? `${self} ${p} ${n}` : `${n} ${p} ${self}`} FILTER (${p} NOT IN (rdf:type, rdfs:label) && isIRI(${n}))`;
    const rows = ctx.modelFiles.length ? await ctx.port.select(`${PREFIXES} SELECT DISTINCT ?p ?n ?x ?q ?v WHERE {
        { ${around('?p', '?n')} } UNION { { { ${around('?p0', '?x')} } UNION { VALUES ?x { ${self} } } } ${FACTS} ?x ?q ?v } }`, ctx.modelFiles) : [];
    const edges = new Map<string, { p: string; n: string }>(), facts: Facts = new Map();
    for (const r of rows) {
        if (r.p && r.n) edges.set(`${r.p.value} ${r.n.value}`, { p: r.p.value, n: r.n.value });
        addFact(facts, r.x, r.q, r.v);
    }
    return { edges: [...edges.values()], facts };
}

/**
 * Halo expand of `from` (an element or its placement) in `viewId` (expandChoices of model/choices.ts), from `viewText` (the text of the
 * view document) and `kept` (the view's answer of the last draw). 'in', 'out': a node shape, the node shapes with a property to it (no
 * query); an instance, its hidden neighbours (one query). 'targets': a node shape, the instances it checks; an instance, its applicable
 * node shapes (the walk of shapeTargetMatches, and at most one query for the instance test and the labels).
 */
export async function expandChoices(ctx: ModelContext, viewId: string, viewText: string, from: string, dir: 'in' | 'out' | 'targets', kept?: KeptPrefetch): Promise<Choices | undefined> {
    const doc = drawFromText(ctx, viewId, viewText, kept).drawn.doc;
    if (dir === 'targets') return shapeTargetChoices(ctx, doc, viewId, from, kept);
    const view = doc.views[viewId];
    if (!view) return undefined;
    const element = elementOfId(view, from);
    applyPrefixes(ctx.manifest);
    if (ctx.shapes.index.model.nodeShapes[element]) return dir === 'in' ? shapeSourceChoices(doc, viewId, from) : undefined;
    const iri = elementTerm(element)?.value;
    if (!iri || iri.startsWith(BLANK) || relationTriple(element)) return undefined;
    const { edges, facts } = await neighborsOf(ctx, iri, dir);
    if (!isInstance(ctx, facts, iri)) return undefined;
    // The relations of `iri` in `dir` are the answer's; the view text gives the placements and the drawn relations.
    const selfId = elementId(rdf.namedNode(iri));
    doc.instances[selfId] = instanceOf(ctx, facts, iri);
    for (const [id, r] of Object.entries(doc.relations)) if ((dir === 'out' ? r.subject : r.object) === selfId) delete doc.relations[id];
    for (const { p, n } of edges) {
        if (n === iri || !isInstance(ctx, facts, n)) continue;
        const other = instanceOf(ctx, facts, n), [s, o] = dir === 'out' ? [iri, n] : [n, iri];
        doc.instances[other.id] = other;
        const id = relationId(rdf.namedNode(s), rdf.namedNode(p), rdf.namedNode(o));
        doc.relations[id] = { id, subject: elementId(rdf.namedNode(s)), predicate: p, object: elementId(rdf.namedNode(o)) };
    }
    applyPrefixes(ctx.manifest);
    return neighborChoices(doc, ctx.shapes.meta, viewId, from, dir);
}

/** Labels of the instances that are not members of the entity group `collection` of `viewId` (for "+ member"), sorted. `viewText`: the view document. */
export async function memberOptions(ctx: ModelContext, viewId: string, viewText: string, collection: string): Promise<string[]> {
    const doc = drawFromText(ctx, viewId, viewText).drawn.doc, labels = await instanceLabels(ctx);
    const box = doc.views[viewId]?.boxes.find(b => b.kind === 'collection' && b.id === collection);
    const members = new Set(box?.kind === 'collection' ? box.members : []);
    return [...new Set([...labels].filter(([s]) => !members.has(elementId(rdf.namedNode(s)))).map(([, label]) => label))].sort();
}

/** The ids of the instances with the label or IRI `text`. */
export async function instancesNamed(ctx: ModelContext, text: string): Promise<string[]> {
    return [...await instanceLabels(ctx)].filter(([s, label]) => label === text || s === text).map(([s]) => elementId(rdf.namedNode(s)));
}
