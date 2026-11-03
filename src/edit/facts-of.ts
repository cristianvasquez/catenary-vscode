// The model facts of one view command from turtle/query: one model query (VALUES over the IRIs of the command and of its views) and one
// view query, in parallel. Nothing is kept between commands.
import type { NamedNode, Quad, Term } from '@rdfjs/types';
import type { ViewCommand } from '../catenary/model/commands';
import { LABEL_PREDICATES, pickLabel } from '../catenary/model/labels';
import type { Range } from '../catenary/model/shapes-doc';
import { NS } from '../catenary/model/terms';
import { UNION_GRAPH, fileOfGraph } from '../catenary/rdf/files';
import { labelFromIri, labelLiterals, SKOS_MEMBERSHIP, SKOS_TYPES } from '../catenary/rdf/vocabulary';
import { byFile, type ModelPort, type Row } from '../model/port';
import type { ManifestRecords } from '../read/manifest';
import type { ShapesModelRecords } from '../read/shapes';
import { commandIds, resolveIds, type Views } from './commands';
import { nodeShapeTerm, type Facts } from './facts';
import { elementTerm, P, rdf, relationTriple, termKey, tripleKey, V } from './terms';

export interface FactsContext {
    port: ModelPort;
    /** The model documents (modelFilesOf); the manifest document is left out of the model. */
    modelFiles: string[];
    shapes: ShapesModelRecords;
    manifest: ManifestRecords;
    /** View IRI → file path of its view file (ModelContext.views). */
    views: Map<string, string>;
}

/** The IRI prefix of a blank node in a port answer (port.ts): a query cannot name it; it is fetched with an isBlank pattern and kept by its label. */
const BLANK = 'urn:skolem:blank:';

/** The commands that read the Doc of a view (docOfViewQuads): they also need the SKOS vocabulary of the model. */
const DOC_KINDS = new Set<ViewCommand['kind']>(['collect', 'pasteIntoView', 'moveBetweenViews']);

const RDF_TYPE = NS.rdf + 'type', RDFS_LABEL = NS.rdfs + 'label';

const IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|^`\\]*$/;

const values = (iris: Iterable<string>) => [...iris].map(t => `<${t}>`).join(' ');

/** The IRIs that the range of a property shape can place as the end of its line (figure-edits.ts placeEnd). */
function rangeIris(shapes: ShapesModelRecords, range: Range): string[] {
    const model = shapes.index.model;
    if (range.kind === 'node') return model.nodeShapes[range.shape] ? [model.nodeShapes[range.shape].uri] : [];
    if (range.kind === 'class') return [range.class, ...Object.values(model.nodeShapes).filter(n => n.targetClass === range.class).map(n => n.uri)];
    if (range.kind === 'scheme') return range.schemes;
    if (range.kind === 'collection') return [range.collection];
    return [];
}

/**
 * The IRIs that a command asks about: the IRIs of its ids (an element, the ends of a relation, the element of a placement), the IRIs of
 * its clip, the ends that Show as Line can place, and every element, member and connector end that its views place.
 */
export function commandIris(shapes: ShapesModelRecords, command: ViewCommand, views: Views): string[] {
    const c = resolveIds({ shapes: shapes.index }, command), out = new Set<string>(Object.keys(views));
    const add = (t: Term | undefined) => { if (t?.termType === 'NamedNode') out.add(t.value); };
    for (const id of commandIds(c)) {
        const r = relationTriple(id);
        if (r) { add(r.s); add(r.o); continue; }
        const t = elementTerm(id);
        add(t);
        for (const v of Object.values(views)) if (t) for (const o of v.objects(t, V.element)) add(o);
    }
    if (c.kind === 'pasteIntoView' || c.kind === 'moveBetweenViews') {
        for (const b of c.clip?.boxes ?? []) { if (b.kind === 'card') { out.add(b.id); out.add(b.element); } if (b.kind === 'reference' && b.target) out.add(b.target); }
        for (const e of c.clip?.edges ?? []) { out.add(e.subject); out.add(e.object); }
    }
    if (c.kind === 'showAsEdge') {
        const model = shapes.index.model, constraint = model.constraints[c.id];
        const properties = constraint ? constraint.members.map(m => model.properties[m]) : [model.properties[c.id]];
        for (const p of properties) if (p) { if (p.uri) out.add(p.uri); for (const i of rangeIris(shapes, p.range)) out.add(i); }
    }
    for (const v of Object.values(views)) {
        for (const q of [...v.match(null, V.element), ...v.match(null, V.member)]) add(q.object);
        for (const q of v.match(null, P.reifies)) if (q.object.termType === 'Quad') { add(q.object.subject); add(q.object.object); }
    }
    return [...out].filter(i => IRI.test(i) && i !== UNION_GRAPH);
}

/**
 * The model query, in two parts. Each row is a statement and the branch `?b` that found it. The IRI part, per model document (byFile, each
 * row with its `file`): `a` the statements of a named IRI, `t` rdf:type and rdfs:label of their objects, `v` every statement of an IRI subject
 * with a SKOS type. The blank part, once over the whole folder (no `file`): `x` every statement of a blank node subject (kept by label in
 * code), `y` rdf:type and rdfs:label of the objects of blank nodes.
 */
function namedQuery(named: string[], vocabulary: boolean): string {
    const branches = [
        ...named.length ? [
            `{ VALUES ?s { ${values(named)} } ?s ?p ?o BIND ("a" AS ?b) }`,
            `{ VALUES ?i { ${values(named)} } ?i ?q ?s . ?s ?p ?o ${TYPING} BIND ("t" AS ?b) }`
        ] : [],
        ...vocabulary ? [`{ ?s a ?t VALUES ?t { ${values(SKOS_TYPES.map(t => t.value))} } ?s ?p ?o FILTER (isIRI(?s)) BIND ("v" AS ?b) }`] : []
    ];
    return `SELECT DISTINCT ?s ?p ?o ?b WHERE { ${branches.join(' UNION ')} }`;
}

const TYPING = `FILTER (?p IN (<${RDF_TYPE}>, <${RDFS_LABEL}>))`;

const BLANK_QUERY = `SELECT DISTINCT ?s ?p ?o ?b WHERE { { ?s ?p ?o FILTER (isBlank(?s)) BIND ("x" AS ?b) }
    UNION { ?i ?q ?s FILTER (isBlank(?i)) ?s ?p ?o ${TYPING} BIND ("y" AS ?b) } }`;

/** The label statements of each view of `iris` (the view IRI as subject), from its view file. */
function viewQuery(iris: string[]): string {
    const labels = LABEL_PREDICATES.map(p => `<${p}>`).join(', ');
    return `SELECT ?v ?p ?l WHERE { VALUES ?v { ${values(iris)} } ?v ?p ?l FILTER (?p IN (${labels})) }`;
}

const quadOf = ({ s, p, o }: Row): Quad => rdf.quad(s as Quad['subject'], p as Quad['predicate'], o as Quad['object']);

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The facts of `command` on `views` (the views it edits, as they are before it): the model query over `ctx.modelFiles` without the manifest
 * (the blank part over the folder), and the view label query over the view files, in parallel. `isView`: the IRI is a view of `ctx.views`. A fact about an IRI that the prefetch did not ask about answers as for an IRI
 * without statements.
 */
export async function factsOf(ctx: FactsContext, command: ViewCommand, views: Views): Promise<Facts> {
    const iris = commandIris(ctx.shapes, command, views);
    const named = iris.filter(i => !i.startsWith(BLANK)), blanks = new Set(iris.filter(i => i.startsWith(BLANK)));
    const files = ctx.modelFiles.filter(f => f !== ctx.manifest.file), vocabulary = DOC_KINDS.has(command.kind);
    const viewIris = named.filter(i => ctx.views.has(i));
    const [namedRows, blankRows, viewRows] = await Promise.all([
        named.length || vocabulary ? byFile(ctx.port, files, namedQuery(named, vocabulary)) : [],
        blanks.size && files.length ? ctx.port.select(BLANK_QUERY) : [],
        viewIris.length ? ctx.port.select(viewQuery(viewIris), viewIris.map(v => ctx.views.get(v)!)) : []
    ]);
    const modelRows: (Row & { file?: string })[] = [...namedRows, ...blankRows];

    // The shapes part: the statements of the shapes closure (K2), by subject; a statement of a document outside it is a model statement.
    // A row without a file (the blank part, read over the folder): a shape statement when its subject is a shape in any document.
    const shapeKeys = new Set(ctx.shapes.closure.map(q => `${fileOfGraph(q.graph.value)} ${termKey(q.subject)}`));
    const shapeSubjects = new Set(ctx.shapes.closure.map(q => termKey(q.subject)));
    const isShapeRow = (r: Row & { file?: string }, q: Quad) => r.file === undefined ? shapeSubjects.has(termKey(q.subject)) : shapeKeys.has(`${r.file} ${termKey(q.subject)}`);
    const shapesBySubject = new Map<string, Quad[]>();
    for (const q of ctx.shapes.closure) (shapesBySubject.get(q.subject.value) ?? shapesBySubject.set(q.subject.value, []).get(q.subject.value)!).push(q);

    // The model statements (not the shapes part), once each, by subject; `full`: the subjects whose every statement is here.
    const model = new Map<string, Map<string, Quad>>(), full = new Set<string>(), skos = new Set<string>();
    for (const r of modelRows) {
        const q = quadOf(r), b = r.b?.value;
        if (b === 'x' && !blanks.has(q.subject.value)) continue;
        if (isShapeRow(r, q)) continue;
        const s = q.subject.value, t = rdf.quad(q.subject, q.predicate, q.object);
        (model.get(s) ?? model.set(s, new Map()).get(s)!).set(tripleKey(t), t);
        if (b === 'a' || b === 'x' || b === 'v') full.add(s);
        if (b === 'v' && q.predicate.value === RDF_TYPE && SKOS_TYPES.some(x => x.value === q.object.value)) skos.add(s);
    }
    const rowsOf = (s: string) => full.has(s) ? [...model.get(s)?.values() ?? []] : [];
    const typedOrLabelled = (t: Term) => t.termType === 'NamedNode' && [...model.get(t.value)?.values() ?? []].some(q => q.predicate.value === RDF_TYPE || q.predicate.value === RDFS_LABEL);
    const inModel = (iri: string) => typedOrLabelled(rdf.namedNode(iri));

    const viewLabels = new Map<string, Row[]>();
    for (const r of viewRows) (viewLabels.get(r.v.value) ?? viewLabels.set(r.v.value, []).get(r.v.value)!).push(r);

    const shapesMatch = (s: string | null, p: string | null, o?: string | null): Quad[] => {
        const rows = s !== null ? shapesBySubject.get(s) ?? [] : ctx.shapes.closure;
        return rows.filter(q => (p === null || q.predicate.value === p) && (o == null || (q.object.termType === 'NamedNode' && q.object.value === o)));
    };
    /** The shapes graph in which `iri` is a SKOS subject (a SKOS type, skos:inScheme or skos:topConceptOf), first in order. */
    const vocabularyGraph = (iri: string) => (shapesBySubject.get(iri) ?? [])
        .filter(q => (q.predicate.value === RDF_TYPE && SKOS_TYPES.some(t => t.value === q.object.value)) || SKOS_MEMBERSHIP.some(m => m.value === q.predicate.value))
        .map(q => q.graph.value).sort(cmp)[0];

    const facts: Facts = {
        shapes: ctx.shapes.index,
        language: ctx.manifest.language,
        isInstance: iri => iri !== UNION_GRAPH && (inModel(iri) || vocabularyGraph(iri) !== undefined),
        label: iri => pickLabel(labelLiterals(p => rowsOf(iri).filter(q => q.predicate.value === p).map(q => q.object)), ctx.manifest.language) ?? labelFromIri(iri),
        isView: iri => ctx.views.has(iri),
        viewLabel: iri => pickLabel(labelLiterals(p => (viewLabels.get(iri) ?? []).filter(r => r.p?.value === p).map(r => r.l)), ctx.manifest.language) ?? labelFromIri(iri),
        has: (s, p, o) => {
            const graph = !inModel(s) && vocabularyGraph(s);
            const key = tripleKey({ subject: rdf.namedNode(s), predicate: rdf.namedNode(p), object: rdf.namedNode(o) });
            if (graph) return shapesMatch(s, p, o).some(q => q.graph.value === graph);
            return rowsOf(s).some(q => tripleKey(q) === key);
        },
        shapesCard: id => {
            const t = elementTerm(id);
            if (!t || !shapesMatch(t.value, null).length) return undefined;
            const idx = ctx.shapes.index;
            return nodeShapeTerm(facts, id) ?? idx.valueSet.get(id)?.term ?? idx.property.get(id)?.term as NamedNode | undefined;
        },
        statementsAmong: among => {
            const set = new Set(among);
            return [...set].flatMap(rowsOf).filter(q => set.has(q.object.value) && q.predicate.value !== RDF_TYPE && q.predicate.value !== RDFS_LABEL
                && typedOrLabelled(q.subject) && typedOrLabelled(q.object));
        },
        shapesMatch,
        statementsOf: of => {
            const set = new Set(of);
            return [...set].flatMap(rowsOf).filter(q => q.predicate.value === RDF_TYPE || q.object.termType !== 'NamedNode' || set.has(q.object.value) || !typedOrLabelled(q.object));
        },
        vocabularyStatements: () => [...skos].flatMap(rowsOf)
    };
    return facts;
}
