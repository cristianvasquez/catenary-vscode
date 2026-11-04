// The facts of a command from the kept answers of its views and one query for the named IRIs that no answer covers. View-only commands
// send no query: they use the identities and reified relations of the views, with shape facts and view labels from the context.
import type { NamedNode, Quad, Term } from '@rdfjs/types';
import type { ViewCommand } from '../catenary/model/commands';
import { pickLabel } from '../catenary/model/labels';
import { nkey, type NQuad } from '../catenary/model/notation-graph';
import type { Range } from '../catenary/model/shapes-doc';
import { NS } from '../catenary/model/terms';
import { UNION_GRAPH } from '../catenary/rdf/files';
import { labelFromIri, labelLiterals, SKOS_MEMBERSHIP, SKOS_TYPES } from '../catenary/rdf/vocabulary';
import type { ModelPort, Row } from '../model/port';
import type { ManifestRecords } from '../read/manifest';
import type { ShapesModelRecords } from '../read/shapes';
import type { ViewGraph } from '../read/view';
import type { KeptPrefetch } from '../read/figures';
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
    viewLabels?: Map<string, ViewGraph>;
}

/** The IRI prefix of a blank node in a port answer (port.ts); it is not an address. */
const BLANK = 'urn:skolem:blank:';

/** Model-reading clipboard commands also need the SKOS vocabulary when reconstructing a Doc. */
const DOC_KINDS = new Set<ViewCommand['kind']>(['pasteIntoView', 'moveBetweenViews']);

const MODEL_KINDS = new Set<ViewCommand['kind']>(['addToView', 'pasteIntoView', 'moveBetweenViews', 'showAsEdge', 'showRelations']);

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
 * The model IRIs that a command asks about (none for a view-only command): the IRIs of its ids (an element, the ends of a relation, the element of a placement), the IRIs of
 * its clip and the ends that Show as Line can place. `placed` (default): also the views and every element, member and connector end that its views place.
 */
export function commandIris(shapes: ShapesModelRecords, command: ViewCommand, views: Views, placed = true): string[] {
    if (!MODEL_KINDS.has(command.kind)) return [];
    const c = resolveIds({ shapes: shapes.index }, command), out = new Set<string>(placed ? Object.keys(views) : []);
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
    if (placed) for (const v of Object.values(views)) {
        for (const q of [...v.match(null, V.element), ...v.match(null, V.member)]) add(q.object);
        for (const q of v.match(null, P.reifies)) if (q.object.termType === 'Quad') { add(q.object.subject); add(q.object.object); }
    }
    return [...out].filter(i => IRI.test(i) && i !== UNION_GRAPH && !i.startsWith(BLANK));
}

/**
 * The IRIs of `iris` that have no model statements to read: a view, or a subject that a view graph of `views` types with a view: type
 * (a placement, a mark). Their statements are in the view files, not in the model.
 */
export function viewSubjects(ctx: Pick<FactsContext, 'views'>, views: Views, iris: string[]): Set<string> {
    const local = new Set(Object.values(views).flatMap(v => v.match(null, P.type).filter(q => q.object.value.startsWith(NS.view)).map(q => q.subject.value)));
    return new Set(iris.filter(i => ctx.views.has(i) || local.has(i)));
}

/**
 * The query for the named IRIs that no kept answer covers: one request over the model documents. Each row is a statement and the branch `?b`
 * that found it: `a` the statements of a named IRI, `t` rdf:type and rdfs:label of their objects.
 */
function namedQuery(named: string[]): string {
    return `SELECT DISTINCT ?s ?p ?o ?b WHERE { { VALUES ?s { ${values(named)} } ?s ?p ?o BIND ("a" AS ?b) }
        UNION { VALUES ?i { ${values(named)} } ?i ?q ?s . ?s ?p ?o ${TYPING} BIND ("t" AS ?b) } }`;
}

const TYPING = `FILTER (?p IN (<${RDF_TYPE}>, <${RDFS_LABEL}>))`;

const quadOf = ({ s, p, o }: Row): Quad => rdf.quad(s as Quad['subject'], p as Quad['predicate'], o as Quad['object']);

/** A statement of a kept answer as an RDF/JS quad; undefined for a triple-term object. */
function answerQuad(q: NQuad): Quad | undefined {
    const o = q.object;
    if (o.termType !== 'NamedNode' && o.termType !== 'Literal') return undefined;
    const object = o.termType === 'NamedNode' ? rdf.namedNode(o.value) : rdf.literal(o.value, o.language || (o.datatype ? rdf.namedNode(o.datatype) : undefined));
    return rdf.quad(rdf.namedNode(q.subject.value), rdf.namedNode(q.predicate), object);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const iriKey = (iri: string) => nkey({ termType: 'NamedNode', value: iri });

/** A kept answer with its statements by subject. */
interface Answer { kept: KeptPrefetch; bySubject: Map<string, Quad[]> }

/**
 * The facts of `command` on `views` before the edit. A model-reading command takes the statements of each IRI that it names
 * (commandIris) from the kept answers of the views (`answers`, KeptPrefetch by view IRI) when an answer covers the IRI: its statements as
 * subject and the rdf:type and rdfs:label of their IRI objects. For the other IRIs it sends one query over `ctx.modelFiles` without the
 * manifest. A shape subject is never taken from an answer (the answer has no document): its model statements are those of the documents
 * where it is not a shape, read by one query per set of such documents (by document kind). Elsewhere a statement of the closure
 * (`ctx.shapes.closure`) is not a model statement. The SKOS vocabulary
 * of the clipboard commands comes from `ctx.shapes.skos`. A view-only command sends no query: it uses the identities and reified relations
 * of the views, and the relations between IRIs of the answers. `isView` and `viewLabel` use `ctx.views` and `ctx.viewLabels`.
 */
export async function factsOf(ctx: FactsContext, command: ViewCommand, views: Views, answers: Map<string, KeptPrefetch> = new Map()): Promise<Facts> {
    const named = commandIris(ctx.shapes, command, views);
    const files = ctx.modelFiles.filter(f => f !== ctx.manifest.file), vocabulary = DOC_KINDS.has(command.kind);
    const closureKeys = new Set(ctx.shapes.closure.map(tripleKey));
    const shapeRow = (q: Quad) => closureKeys.has(tripleKey(q));
    const noModel = viewSubjects(ctx, views, named);

    const kept: Answer[] = [...answers.values()].map(a => {
        const bySubject = new Map<string, Quad[]>();
        for (const n of a.quads) {
            const q = answerQuad(n);
            if (q) (bySubject.get(q.subject.value) ?? bySubject.set(q.subject.value, []).get(q.subject.value)!).push(q);
        }
        return { kept: a, bySubject };
    });
    const isShape = (iri: string) => ctx.shapes.shapeSubjects.has(`<${iri}>`);
    /** The answer has every statement of `iri` as subject: read for a view doc, or covered and not a shape subject (its outAll can come from the closure). */
    const readIn = (a: Answer, iri: string) => a.kept.covered.read.has(iri) || (!isShape(iri) && a.kept.covered.outAll.has(iriKey(iri)));
    /** The answer has the statements of `iri` and the rdf:type and rdfs:label of each IRI object of them (the branches a and t). */
    const covers = (a: Answer, iri: string) => !isShape(iri) && (a.kept.covered.read.has(iri) || readIn(a, iri)
        && (a.bySubject.get(iri) ?? []).every(q => q.predicate.value === RDF_TYPE || q.object.termType !== 'NamedNode' || q.object.value.startsWith(BLANK) || readIn(a, q.object.value)));

    // The rows of the model statements, by branch: from the answers that cover a named IRI, then from the queries for the others.
    // `exact`: an `a` row of a query by document kind, a model statement whatever the closure has.
    const modelRows: { q: Quad; b: string; exact?: boolean }[] = [];
    const uncovered: string[] = [];
    /** The shape subjects by the documents where they are not shapes (the key: those documents). */
    const byKind = new Map<string, { files: string[]; iris: string[] }>();
    for (const iri of named) {
        if (noModel.has(iri)) continue;
        if (isShape(iri)) {
            const own = files.filter(f => !ctx.shapes.shapeSubjectsByFile.get(f)?.has(`<${iri}>`)), k = own.join('\n');
            if (own.length) (byKind.get(k) ?? byKind.set(k, { files: own, iris: [] }).get(k)!).iris.push(iri);
            continue;
        }
        const a = kept.find(x => covers(x, iri));
        if (!a) { uncovered.push(iri); continue; }
        for (const q of a.bySubject.get(iri) ?? []) {
            modelRows.push({ q, b: 'a' });
            if (q.object.termType === 'NamedNode') for (const t of a.bySubject.get(q.object.value) ?? [])
                if (t.predicate.value === RDF_TYPE || t.predicate.value === RDFS_LABEL) modelRows.push({ q: t, b: 't' });
        }
    }
    const requests = [...uncovered.length ? [{ files, iris: uncovered, kind: false }] : [], ...[...byKind.values()].map(g => ({ ...g, kind: true }))];
    const answered = await Promise.all(requests.map(r => ctx.port.select(namedQuery(r.iris), r.files)));
    requests.forEach((request, i) => {
        for (const r of answered[i]) modelRows.push({ q: quadOf(r), b: r.b?.value ?? '', exact: request.kind && r.b?.value === 'a' });
    });

    const shapesBySubject = new Map<string, Quad[]>();
    for (const q of ctx.shapes.closure) (shapesBySubject.get(q.subject.value) ?? shapesBySubject.set(q.subject.value, []).get(q.subject.value)!).push(q);

    // The model statements (not the shapes part), once each, by subject; `full`: the subjects whose every statement is here.
    const model = new Map<string, Map<string, Quad>>(), full = new Set<string>(), skos = new Set<string>();
    const put = (q: Quad) => { const t = rdf.quad(q.subject, q.predicate, q.object); (model.get(q.subject.value) ?? model.set(q.subject.value, new Map()).get(q.subject.value)!).set(tripleKey(t), t); };
    for (const { q, b, exact } of modelRows) {
        if (!exact && shapeRow(q)) continue;
        put(q);
        if (b === 'a') full.add(q.subject.value);
    }
    if (vocabulary) {
        // The SKOS vocabulary of the refresh (vocabularyOf), per document: a statement of a subject in the shapes part of its document is not a model statement.
        const shapeKeys = new Set(ctx.shapes.closure.map(q => `${q.graph.value} ${termKey(q.subject)}`));
        for (const q of ctx.shapes.skos) {
            if (shapeKeys.has(`${q.graph.value} ${termKey(q.subject)}`) || q.subject.termType !== 'NamedNode') continue;
            put(q);
            full.add(q.subject.value);
            if (q.predicate.value === RDF_TYPE && SKOS_TYPES.some(x => x.value === q.object.value)) skos.add(q.subject.value);
        }
    }
    if (!MODEL_KINDS.has(command.kind)) {
        // A view-only edit needs card identities, not their model properties. A label statement lets docOfViewQuads retain
        // those identities; shape subjects, view references and local marks keep their existing classification.
        const local = Object.values(views);
        const identity = (t: Term) => {
            if (t.termType !== 'NamedNode' || full.has(t.value) || ctx.views.has(t.value) || t.value === UNION_GRAPH || shapesBySubject.has(t.value)
                || local.some(v => v.match(t, P.type).length)) return;
            const q = rdf.quad(t, rdf.namedNode(RDFS_LABEL), rdf.literal(labelFromIri(t.value)));
            model.set(t.value, new Map([[tripleKey(q), q]]));
            full.add(t.value);
        };
        const relation = (q: Quad) => {
            identity(q.subject); identity(q.object);
            const rows = model.get(q.subject.value);
            if (rows) rows.set(tripleKey(q), q);
        };
        for (const v of local) {
            for (const q of [...v.match(null, V.element), ...v.match(null, V.member)]) identity(q.object);
            for (const q of v.match(null, P.reifies)) if (q.object.termType === 'Quad') relation(q.object);
        }
        // Connector restoration (for example uncollect) uses the relations between IRIs of the answers, not a model query.
        for (const q of kept.flatMap(a => [...a.bySubject.values()].flat())) {
            if (q.object.termType !== 'NamedNode') continue;
            // Only relations between the instance identities already named by this view are relevant.
            const rows = model.get(q.subject.value);
            if (rows && model.has(q.object.value)) rows.set(tripleKey(q), q);
        }
        for (const id of commandIds(resolveIds({ shapes: ctx.shapes.index }, command))) {
            const r = relationTriple(id), t = elementTerm(id);
            if (r) relation(rdf.quad(r.s, r.p, r.o));
            else if (t) identity(t);
        }
    }
    const rowsOf = (s: string) => full.has(s) ? [...model.get(s)?.values() ?? []] : [];
    const typedOrLabelled = (t: Term) => t.termType === 'NamedNode' && [...model.get(t.value)?.values() ?? []].some(q => q.predicate.value === RDF_TYPE || q.predicate.value === RDFS_LABEL);
    const inModel = (iri: string) => typedOrLabelled(rdf.namedNode(iri));

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
        viewLabel: iri => pickLabel(labelLiterals(p => p === RDFS_LABEL ? ctx.viewLabels?.get(iri)?.subjects.get(termKey(rdf.namedNode(iri)))?.labels ?? [] : []), ctx.manifest.language) ?? labelFromIri(iri),
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
