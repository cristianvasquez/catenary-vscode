// The halo, "+ member" and insert picker choices from turtle/query answers (model/choices.ts and rdf/link-choices.ts over the port).
import type { Term } from '@rdfjs/types';
import { Parser } from 'n3';
import { pathToFileURL } from 'node:url';
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
import { byDocumentKind, documentSets } from './documents';
import { type ModelContext, drawFromText } from './diagram';
import type { KeptPrefetch } from './figures';
import type { ShapesModelRecords } from './shapes';
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
/** Every IRI subject and its statements, including labels and SKOS membership, by model document kind. */
const INSTANCE_ROWS = `${PREFIXES} SELECT ?s ?p ?o WHERE { ?s ?p ?o
    FILTER (isIRI(?s) && !STRSTARTS(STR(?s), "${BLANK}")) }`;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const named = (value: string): FocusNode => ({ termType: 'NamedNode', value });

/**
 * IRI → label of every model statement subject outside the shapes of its document, sorted by IRI. Blank nodes and UNION_GRAPH are excluded.
 * The label follows the manifest language, else comes from the IRI.
 * `vocabulary` (the insert picker): also every SKOS subject of the shapes, labelled from its shapes statements when it has none outside.
 */
export async function instanceLabels(ctx: ModelContext, options: { vocabulary?: boolean } = {}): Promise<Map<string, string>> {
    const inShapes = inShapesOf(ctx.shapes);
    const rows = legacyRows(await byDocumentKind(ctx.port, documentSets(ctx.shapes, ctx.modelFiles), INSTANCE_ROWS));
    const modelRows = rows.filter(r => !inShapes(r.kind, r.s));
    const instances = new Set(modelRows.map(r => r.s.value));
    const vocabulary = new Set(rows.filter(r => inShapes(r.kind, r.s) && ((r.p.value === TYPE && SKOS_TYPES.has(r.o.value)) || SKOS_MEMBERSHIP.has(r.p.value))).map(r => r.s.value));
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

/** The statements of the shapes closure (ShapesModelRecords.closure) as `s p o` keys, per shapes model. */
const closureKeys = new WeakMap<ShapesModelRecords, Set<string>>();

const tripleKey = (s: Term, p: Term, o: Term) => `${termKey(s)} ${termKey(p)} ${termKey(o)}`;

function shapesClosureKeys(ctx: ModelContext): Set<string> {
    let keys = closureKeys.get(ctx.shapes);
    if (!keys) closureKeys.set(ctx.shapes, keys = new Set(ctx.shapes.closure.map(q => tripleKey(q.subject, q.predicate, q.object))));
    return keys;
}

/**
 * The objects of `p` for `iri` that are model statements (factsOf of neighbors.ts: outside the shapes). One answer over every model
 * document has no document kind: a statement of a shapes subject is a model statement when the shapes closure does not hold it.
 */
function modelObjects(ctx: ModelContext, facts: Facts, iri: string, p: string): Term[] {
    const objects = facts.get(iri)?.get(p) ?? [], s = rdf.namedNode(iri);
    if (!ctx.shapes.shapeSubjects.has(termKey(s))) return objects;
    return objects.filter(o => !shapesClosureKeys(ctx).has(tripleKey(s, rdf.namedNode(p), o)));
}

/** In the model graph: rdf:type or rdfs:label outside the shapes (the home of factsOf is the model graph). */
const inModel = (ctx: ModelContext, facts: Facts, iri: string) => [TYPE, LABEL].some(p => modelObjects(ctx, facts, iri, p).length);

/**
 * The instance test of factsOf (neighbors.ts) on one answer over every model document: rdf:type or rdfs:label outside the shapes
 * (modelObjects), or, for a shapes subject, a SKOS type or a SKOS membership statement.
 */
function isInstance(ctx: ModelContext, facts: Facts, iri: string): boolean {
    const own = facts.get(iri);
    if (!own || iri === UNION_GRAPH) return false;
    if (inModel(ctx, facts, iri)) return true;
    return ctx.shapes.shapeSubjects.has(termKey(rdf.namedNode(iri)))
        && ((own.get(TYPE) ?? []).some(t => SKOS_TYPES.has(t.value)) || [...SKOS_MEMBERSHIP].some(p => own.has(p)));
}

/**
 * The label of `iri` (the label rule by the manifest language); `path`: else its first sh:path (labelsOf); else from the IRI. `home`: the
 * statements of the graph of an instance only (records of the old scopedDoc): of a shapes subject in the model graph, its model statements.
 */
function labelOf(ctx: ModelContext, facts: Facts, iri: string, path = false, home = false): string {
    const model = home && inModel(ctx, facts, iri);
    const objects = (p: string) => model ? modelObjects(ctx, facts, iri, p) : facts.get(iri)?.get(p) ?? [];
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
    id: elementId(rdf.namedNode(iri)), uri: iri, label: labelOf(ctx, facts, iri, false, true),
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
 * of a statement other than rdf:type outside the shapes closure, an IRI that is not a blank node.
 */
async function neighborsOf(ctx: ModelContext, iri: string, dir: 'in' | 'out'): Promise<{ edges: { p: string; n: string }[]; facts: Facts }> {
    const self = `<${iri}>`;
    const around = (p: string, n: string) => `${dir === 'out' ? `${self} ${p} ${n}` : `${n} ${p} ${self}`} FILTER (${p} != rdf:type && isIRI(${n}) && !STRSTARTS(STR(${n}), "${BLANK}"))`;
    const rows = ctx.modelFiles.length ? await ctx.port.select(`${PREFIXES} SELECT DISTINCT ?p ?n ?x ?q ?v WHERE {
        { ${around('?p', '?n')} } UNION { { { ${around('?p0', '?x')} } UNION { VALUES ?x { ${self} } } } ${FACTS} ?x ?q ?v } }`, ctx.modelFiles) : [];
    const edges = new Map<string, { p: string; n: string }>(), facts: Facts = new Map();
    for (const r of rows) {
        if (r.p && r.n) {
            const self = rdf.namedNode(iri), [s, o] = dir === 'out' ? [self, r.n] : [r.n, self];
            if (!shapesClosureKeys(ctx).has(tripleKey(s, r.p, o))) edges.set(`${r.p.value} ${r.n.value}`, { p: r.p.value, n: r.n.value });
        }
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
    const viewFile = ctx.views.get(view.uri);
    const viewSubjects = new Set(new Parser({ format: 'application/trig', baseIRI: viewFile ? pathToFileURL(viewFile).href : undefined }).parse(viewText).map(q => q.subject.value));
    if (iri === UNION_GRAPH || viewSubjects.has(iri)) return undefined;
    // The relations of `iri` in `dir` are the answer's; the view text gives the placements and the drawn relations.
    const selfId = elementId(rdf.namedNode(iri));
    doc.instances[selfId] = instanceOf(ctx, facts, iri);
    for (const [id, r] of Object.entries(doc.relations)) if ((dir === 'out' ? r.subject : r.object) === selfId) delete doc.relations[id];
    for (const { p, n } of edges) {
        if (n === iri || n === UNION_GRAPH || n.startsWith(BLANK) || viewSubjects.has(n)) continue;
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
