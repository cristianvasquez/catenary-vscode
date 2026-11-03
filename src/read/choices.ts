// The halo, "+ member" and insert picker choices from turtle/query answers (model/choices.ts and rdf/link-choices.ts over the port).
import type { Term } from '@rdfjs/types';
import { type Doc, boxes, elementOfId } from '../catenary/model/doc';
import { idIri } from '../catenary/model/ids';
import { LABEL_PREDICATES, pickLabel } from '../catenary/model/labels';
import { type Choices, neighborChoices, shapeSourceChoices } from '../catenary/model/prompts';
import { shortIri } from '../catenary/model/shapes-doc';
import { NS } from '../catenary/model/terms';
import { UNION_GRAPH } from '../catenary/rdf/graph-names';
import { elementId } from '../catenary/rdf/ids';
import { rdf } from '../catenary/rdf/terms';
import { labelFromIri, labelLiterals } from '../catenary/rdf/vocabulary';
import { reasonText } from '../catenary/shacl/common';
import type { FocusNode } from '../catenary/shacl/common/index';
import type { Row } from '../model/port';
import type { ModelContext } from './diagram';
import { applyPrefixes } from './manifest';
import { factsOf, inShapesOf } from './neighbors';
import { scopedDoc } from './scope';
import { bindings, shapeTargetMatches } from './targets';
import { legacyRows, viewDocOf } from './view';

const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX rdfs: <${NS.rdfs}> PREFIX skos: <${NS.skos}> PREFIX sh: <${NS.sh}>`;
const TYPE = NS.rdf + 'type', LABEL = NS.rdfs + 'label', PATH = NS.sh + 'path';
const SKOS_TYPES = new Set(['ConceptScheme', 'Concept', 'Collection'].map(t => NS.skos + t));
const SKOS_MEMBERSHIP = new Set(['inScheme', 'topConceptOf'].map(p => NS.skos + p));
/** The statements that make a subject an instance, and its label statements, with their document. */
const INSTANCE_ROWS = `${PREFIXES} SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o
    VALUES ?p { rdf:type rdfs:label skos:prefLabel sh:name skos:inScheme skos:topConceptOf } } }`;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const named = (value: string): FocusNode => ({ termType: 'NamedNode', value });

/** The rows of `query(clause)` for `iris` bound to `?variable` (VALUES, and the isBlank query for blank nodes), on the model documents. */
async function rowsOf(ctx: ModelContext, variable: string, iris: string[], query: (clause: string) => string, files = ctx.modelFiles): Promise<Row[]> {
    if (!iris.length || !files.length) return [];
    return (await Promise.all(bindings(variable, iris.map(named)).map(async ({ clause, keep }) =>
        (await ctx.port.select(query(clause), files)).filter(r => keep(r[variable]))))).flat();
}

/**
 * IRI → label of each instance of the model, sorted by IRI (instanceLabels of model/choices.ts): a subject with rdf:type or rdfs:label outside
 * the shapes of its document, or a SKOS subject of the shapes that has a statement outside the shapes. The label by the manifest language.
 * `vocabulary` (the insert picker): also every SKOS subject of the shapes, labelled from its shapes statements when it has none outside.
 */
export async function instanceLabels(ctx: ModelContext, options: { vocabulary?: boolean } = {}): Promise<Map<string, string>> {
    const inShapes = inShapesOf(ctx.shapes);
    const rows = ctx.modelFiles.length ? legacyRows(await ctx.port.select(INSTANCE_ROWS, ctx.modelFiles)) : [];
    const modelRows = rows.filter(r => !inShapes(r.g.value, r.s));
    const instances = new Set(modelRows.filter(r => r.p.value === TYPE || r.p.value === LABEL).map(r => r.s.value));
    const inUnion = new Set(modelRows.map(r => r.s.value));
    const vocabulary = new Set(rows.filter(r => inShapes(r.g.value, r.s) && ((r.p.value === TYPE && SKOS_TYPES.has(r.o.value)) || SKOS_MEMBERSHIP.has(r.p.value))).map(r => r.s.value));
    // A SKOS subject of the shapes counts when it has a statement outside the shapes (the old pipeline reads the subjects of the model graph).
    const open = [...vocabulary].filter(s => !instances.has(s) && !inUnion.has(s));
    for (const r of await rowsOf(ctx, 's', open, clause => `SELECT DISTINCT ?g ?s WHERE { GRAPH ?g { ?s ?p ?o } ${clause} }`)) if (!inShapes(r.g.value, r.s)) inUnion.add(r.s.value);
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

/** Label of each of `iris` from its statements in the model documents (labels of rdf/quad-read.ts): a label predicate, else the sh:path, else the IRI. */
async function labelsOf(ctx: ModelContext, iris: string[]): Promise<Map<string, string>> {
    const rows = legacyRows((await rowsOf(ctx, 's', iris, clause => `${PREFIXES} SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o
        VALUES ?p { rdfs:label skos:prefLabel sh:name sh:path } } ${clause} }`)));
    return new Map(iris.map(s => {
        const own = rows.filter(r => r.s.value === s);
        const paths = own.filter(r => r.p.value === PATH && !r.o.value.startsWith('urn:skolem:')).map(r => r.o.value).sort();
        const objects = (p: string) => own.filter(r => r.p.value === p).map(r => r.o);
        return [s, pickLabel(labelLiterals(p => (LABEL_PREDICATES as readonly string[]).includes(p) ? objects(p) : []), ctx.manifest.language) ?? labelFromIri(paths[0] ?? s)];
    }));
}

/** Unshown instances for a shape, or unshown applicable shapes for an instance (shapeTargetChoices of rdf/link-choices.ts). */
async function shapeTargetChoices(ctx: ModelContext, doc: Doc, viewId: string, from: string): Promise<Choices | undefined> {
    const view = doc.views[viewId];
    if (!view) return undefined;
    const element = elementOfId(view, from);
    const shown = new Set(boxes(view, 'card').map(card => card.element));
    const shape = doc.shapes.nodeShapes[element];
    if (shape) {
        const found = (await shapeTargetMatches(ctx.port, ctx.modelFiles, ctx.shapes, { shapes: [shape.uri] })).filter(m => m.node.termType === 'NamedNode');
        const facts = await factsOf(ctx.port, ctx.modelFiles, inShapesOf(ctx.shapes), found.map(m => m.node.value));
        const matches = found.filter(m => facts.instance.has(m.node.value) && !shown.has(elementId(rdf.namedNode(m.node.value))));
        if (!matches.length) return undefined;
        const names = await labelsOf(ctx, matches.map(m => m.node.value));
        applyPrefixes(ctx.manifest);
        return {
            title: `${shape.label}: instances (${matches.length} not in the view)`,
            items: matches.map(m => ({ label: names.get(m.node.value) ?? shortIri(m.node.value),
                description: reasonText(m.reasons, shortIri), ids: [elementId(rdf.namedNode(m.node.value))] }))
                .sort((a, b) => a.label.localeCompare(b.label) || a.ids[0].localeCompare(b.ids[0]))
        };
    }
    const instance = doc.instances[element];
    if (!instance) return undefined;
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
 * Halo expand of `from` (an element or its placement) in `viewId` (expandChoices of model/choices.ts). 'in', 'out': a node shape, the node
 * shapes with a property to it; an instance, its hidden neighbours. 'targets': a node shape, the instances it checks; an instance, its
 * applicable node shapes.
 */
export async function expandChoices(ctx: ModelContext, viewId: string, from: string, dir: 'in' | 'out' | 'targets'): Promise<Choices | undefined> {
    if (dir === 'targets') return shapeTargetChoices(ctx, await scopedDoc(ctx, { views: [viewId] }), viewId, from);
    const doc = await scopedDoc(ctx, { elements: [from], neighbors: true, views: [viewId] });
    applyPrefixes(ctx.manifest);
    if (ctx.shapes.index.model.nodeShapes[elementOfId(doc.views[viewId], from)]) return dir === 'in' ? shapeSourceChoices(doc, viewId, from) : undefined;
    return neighborChoices(doc, ctx.shapes.meta, viewId, from, dir);
}

/** Labels of the instances that are not members of the entity group `collection` of `viewId` (for "+ member"), sorted. */
export async function memberOptions(ctx: ModelContext, viewId: string, collection: string): Promise<string[]> {
    const iri = idIri(viewId);
    const [doc, labels] = await Promise.all([iri ? viewDocOf(ctx.port, iri, ctx.shapes, ctx.manifest) : undefined, instanceLabels(ctx)]);
    const box = doc?.views[viewId]?.boxes.find(b => b.kind === 'collection' && b.id === collection);
    const members = new Set(box?.kind === 'collection' ? box.members : []);
    return [...new Set([...labels].filter(([s]) => !members.has(elementId(rdf.namedNode(s)))).map(([, label]) => label))].sort();
}

/** The ids of the instances with the label or IRI `text`. */
export async function instancesNamed(ctx: ModelContext, text: string): Promise<string[]> {
    return [...await instanceLabels(ctx)].filter(([s, label]) => label === text || s === text).map(([s]) => elementId(rdf.namedNode(s)));
}
