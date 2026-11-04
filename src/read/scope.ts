// A Doc of the parts of the views and the model that a picker needs, from turtle/query answers (scopedDoc of rdf/scoped-doc.ts over the port).
import type { NamedNode, Term } from '@rdfjs/types';
import { type Doc, type View, emptyDoc } from '../catenary/model/doc';
import { idIri } from '../catenary/model/ids';
import { NS } from '../catenary/model/terms';
import { dataGraphIri, fileOfGraph } from '../catenary/rdf/files';
import { elementId, elementTerm, relationTriple } from '../catenary/rdf/ids';
import { type Plain, type Statements, instanceRecords } from '../catenary/rdf/records';
import { rdf, termKey } from '../catenary/rdf/terms';
import type { FocusNode } from '../catenary/shacl/common/index';
import { byFile } from '../model/port';
import type { ModelContext } from './diagram';
import { factsOf, inShapesOf, statementsAround } from './neighbors';
import { bindings } from './targets';
import { byDocumentKind, documentSets, type DocumentRow } from './documents';
import { legacyRows, viewDocOf, viewLabelsOf } from './view';

/** What scopedDoc reads (DocScope of rdf/scoped-doc.ts, deleted with it in K11). */
export interface DocScope {
    /** Element ids: instances, relations, views and shape elements. A placement id of one of `views` stands for its element. */
    elements?: string[];
    /** Also the instances related to the instances of `elements`, with the relations to them. */
    neighbors?: boolean;
    /** Views whose selected placements and dependencies are read. */
    selectionViews?: (string | undefined)[];
    /** Views to read in full. */
    views?: (string | undefined)[];
    /** Also read every view that can show an element of `elements` (a view that places it, its shape, value set or view). */
    showing?: boolean;
}

const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX view: <${NS.view}> PREFIX oview: <osg://vocab/view#>`;

/** The home of a subject in the model graph (factsOf). */
const MODEL = '';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const plain = (t: Term): Plain => ({ termType: t.termType, value: t.value, term: t });

const named = (value: string): FocusNode => ({ termType: 'NamedNode', value });

/** A view entry with its label only. */
const labelOnly = (id: string, label: string): View => ({ id, label, uri: elementTerm(id)?.value ?? '', boxes: [], edges: [], arrows: [] });

/** The rows of `query(clause)` for `iris` bound to `?variable` (VALUES by document kind; a blank node among `iris` is left out). */
async function rowsOf(ctx: ModelContext, variable: string, iris: string[], query: (clause: string) => string): Promise<DocumentRow[]> {
    if (!iris.length || !ctx.modelFiles.length) return [];
    return (await Promise.all(bindings(variable, iris.map(named)).map(({ clause }) => byDocumentKind(ctx.port, documentSets(ctx.shapes, ctx.modelFiles), query(clause))))).flat();
}

/** scopedDoc of rdf/scoped-doc.ts: the view labels, the views of `scope` (in full or for the selected elements), the instances of `scope.elements`. */
export async function scopedDoc(ctx: ModelContext, scope: DocScope): Promise<Doc> {
    const { port, modelFiles, shapes, manifest } = ctx;
    const inShapes = inShapesOf(shapes);
    const doc = emptyDoc();
    doc.shapes = shapes.index.model;
    for (const [id, label] of Object.entries(await viewLabelsOf(port, ctx.views, manifest.language))) doc.views[id] = labelOnly(id, label);
    const read = new Set<string>();
    const readPart = async (viewId: string, elements?: string[]) => {
        if (read.has(viewId) || !doc.views[viewId]) return;
        read.add(viewId);
        const iri = idIri(viewId);
        if (!iri) return;
        const part = await viewDocOf(port, ctx.views, iri, shapes, manifest, elements ? { elements } : {});
        if (part.views[viewId]) doc.views[viewId] = part.views[viewId];
        for (const [id, i] of Object.entries(part.instances)) doc.instances[id] ??= i;
        for (const [id, r] of Object.entries(part.relations)) doc.relations[id] ??= r;
    };
    const views = (scope.views ?? []).filter((v): v is string => !!v);
    for (const v of views) await readPart(v);
    const selectedViews = (scope.selectionViews ?? []).filter((v): v is string => !!v);
    for (const v of selectedViews) await readPart(v, scope.elements ?? []);

    // Elements: a placement id of a read view stands for its element.
    const elementOf = new Map<string, string>();
    for (const v of [...views, ...selectedViews].reverse()) {
        const view = doc.views[v];
        if (!view) continue;
        for (const e of view.edges) if (e.id) elementOf.set(e.id, e.relation);
        for (const b of view.boxes) if (b.kind === 'card') elementOf.set(b.id, b.element);
    }
    const elements = [...new Set((scope.elements ?? []).map(id => elementOf.get(id) ?? id))];
    const terms = elements.flatMap(id => { const t = relationTriple(id); return (t ? [t.s, t.o] : [elementTerm(id)]).flatMap(x => x?.termType === 'NamedNode' ? [x.value] : []); });
    const own = [...(await factsOf(port, modelFiles, inShapes, terms)).instance];
    const instances = new Set<string>(own);
    if (scope.neighbors && own.length) for (const x of await neighbors(ctx, own)) instances.add(x);
    if (instances.size && (scope.neighbors || [...instances].some(s => !doc.instances[elementId(rdf.namedNode(s))]))) await records(ctx, doc, [...instances]);

    if (scope.showing) for (const v of await viewsPlacing(ctx, showingTerms(doc, elements, own), new Set(Object.keys(doc.views)))) await readPart(v, elements);
    return doc;
}

/** The instances with a statement to or from one of `subjects` (other than rdf:type and rdfs:label) in the model documents. */
async function neighbors(ctx: ModelContext, subjects: string[]): Promise<string[]> {
    const wanted = new Set(subjects), found: string[] = [];
    for (const r of await statementsAround(ctx.port, ctx.modelFiles, subjects, inShapesOf(ctx.shapes))) {
        if (wanted.has(r.s.value) && r.o.termType === 'NamedNode') found.push(r.o.value);
        if (wanted.has(r.o.value) && r.s.termType === 'NamedNode') found.push(r.s.value);
    }
    const unique = [...new Set(found)];
    const facts = await factsOf(ctx.port, ctx.modelFiles, inShapesOf(ctx.shapes), unique);
    return unique.filter(x => facts.instance.has(x));
}

/**
 * Instance records of `iris` (each an instance) and the relations between them, into `doc`. The statements of an instance of the model
 * graph are its statements outside the shapes of each document; of a SKOS subject of the shapes, its shapes statements of its home document.
 */
async function records(ctx: ModelContext, doc: Doc, iris: string[]): Promise<void> {
    const inShapes = inShapesOf(ctx.shapes);
    const [facts, rows] = await Promise.all([factsOf(ctx.port, ctx.modelFiles, inShapes, iris),
        rowsOf(ctx, 's', iris, clause => `SELECT ?s ?p ?o WHERE { ?s ?p ?o ${clause} }`)]);
    const bySubject = new Map<string, DocumentRow[]>();
    for (const r of rows) (bySubject.get(r.s.value) ?? bySubject.set(r.s.value, []).get(r.s.value)!).push(r);
    const files = new Map<string, string>();
    const subjects: Statements[] = [];
    for (const s of iris) {
        const home = facts.home.get(s) ?? MODEL;
        const own = (bySubject.get(s) ?? []).filter(r => {
            const doc = inShapes.documentOf(r), shapesPart = inShapes(r.kind, r.s);
            return home === MODEL ? !shapesPart : shapesPart && dataGraphIri(doc!) + '#shapes' === home;
        });
        const seen = new Set<string>(), out: Statements['rows'] = [];
        for (const r of legacyRows(own)) {
            const k = `${termKey(r.p)} ${termKey(r.o)}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ s: plain(r.s), p: plain(r.p), o: plain(r.o) });
        }
        if (!out.length) continue;
        if (home !== MODEL) files.set(s, fileOfGraph(home));
        subjects.push({ s: out[0].s, rows: out });
    }
    const part = emptyDoc();
    instanceRecords(part, subjects, files, [], ctx.manifest.language);
    Object.assign(doc.instances, part.instances);
    Object.assign(doc.relations, part.relations);
}

/** The terms whose placement makes a view show one of `elements` (see DocScope.showing). `instances`: the instances among them. */
function showingTerms(doc: Doc, elements: string[], instances: string[]): string[] {
    const { nodeShapes, properties, constraints, valueSets } = doc.shapes;
    const terms = new Set<string>(instances);
    for (const id of elements) {
        const owner = properties[id]?.owner ?? constraints[id]?.owner ?? id;
        const shape = nodeShapes[owner]?.uri ?? valueSets[id]?.uri;
        if (shape) terms.add(shape);
        if (doc.views[id]) terms.add(doc.views[id].uri);
    }
    for (const s of Object.values(valueSets)) if (s.members.some(m => instances.includes(m.uri))) terms.add(s.uri);
    return [...terms];
}

/** The views (ids among `views`) with a placement of one of `terms`, sorted. */
async function viewsPlacing(ctx: ModelContext, terms: string[], views: Set<string>): Promise<string[]> {
    if (!terms.length) return [];
    const viewOf = new Map([...ctx.views].map(([iri, file]) => [file, iri]));
    const found = (await Promise.all(bindings('e', terms.map(named)).map(async ({ clause, keep }) => (await byFile(ctx.port, [...ctx.views.values()], `${PREFIXES} SELECT DISTINCT ?e WHERE {
        ?n a ?t ; ?element ?e FILTER (?t IN (view:Placement, oview:Placement) && ?element IN (view:element, oview:element)) ${clause} }`)).filter(r => keep(r.e))))).flat();
    const ids = new Set(found.flatMap(r => { const v = viewOf.get(r.file); return v ? [elementId(rdf.namedNode(v))] : []; }).filter(id => views.has(id)));
    return [...ids].sort(cmp);
}
