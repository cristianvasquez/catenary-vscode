// Model-reading commands query their bounded subjects. View-only commands use the identities and reified relations in the view
// and command, with shape facts and view labels from the context; they do not read model statements.
import type { NamedNode, Quad, Term } from '@rdfjs/types';
import type { ViewCommand } from '../catenary/model/commands';
import { pickLabel } from '../catenary/model/labels';
import type { Range } from '../catenary/model/shapes-doc';
import { NS } from '../catenary/model/terms';
import { UNION_GRAPH, fileOfGraph } from '../catenary/rdf/files';
import { labelFromIri, labelLiterals, SKOS_MEMBERSHIP, SKOS_TYPES } from '../catenary/rdf/vocabulary';
import { byFile, type ModelPort, type Row } from '../model/port';
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
 * its clip, the ends that Show as Line can place, and every element, member and connector end that its views place.
 */
export function commandIris(shapes: ShapesModelRecords, command: ViewCommand, views: Views): string[] {
    if (!MODEL_KINDS.has(command.kind)) return [];
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
    return [...out].filter(i => IRI.test(i) && i !== UNION_GRAPH && !i.startsWith(BLANK));
}

/**
 * The model query, per model document (byFile, each row with its `file`). Each row is a statement and the branch `?b` that found it:
 * `a` the statements of a named IRI, `t` rdf:type and rdfs:label of their objects, `v` every statement of an IRI subject with a SKOS type.
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

const quadOf = ({ s, p, o }: Row): Quad => rdf.quad(s as Quad['subject'], p as Quad['predicate'], o as Quad['object']);

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The facts of `command` on `views` before the edit. Model-reading commands query `ctx.modelFiles` without the manifest, unless
 * the figure prefetch already supplies an instance-only add. View-only commands retain named identities and cached connector relations.
 * `isView` and `viewLabel` use the context metadata; no view label query is sent.
 */
export async function factsOf(ctx: FactsContext, command: ViewCommand, views: Views, figureRelations: Quad[] = [], prefetched?: KeptPrefetch): Promise<Facts> {
    const named = commandIris(ctx.shapes, command, views);
    const files = ctx.modelFiles.filter(f => f !== ctx.manifest.file), vocabulary = DOC_KINDS.has(command.kind);
    const shapeSubjects = new Set(ctx.shapes.closure.map(q => q.subject.value));
    // For an instance-only add the figures already read every named subject. Reuse those complete statements; commands that
    // need vocabulary or per-file shape/model disambiguation retain the per-file facts query.
    const reuse = command.kind === 'addToView' && prefetched && named.every(iri => !shapeSubjects.has(iri)
        && prefetched.covered.outAll.has(termKey(rdf.namedNode(iri))));
    const modelRows = reuse ? prefetched.quads.flatMap(q => {
        if (shapeSubjects.has(q.subject.value)) return [];
        const o = q.object;
        if (o.termType !== 'NamedNode' && o.termType !== 'Literal') return [];
        const object = o.termType === 'NamedNode' ? rdf.namedNode(o.value) : rdf.literal(o.value, o.language || (o.datatype ? rdf.namedNode(o.datatype) : undefined));
        const b = named.includes(q.subject.value) ? 'a' : 't';
        const row: Row = { s: rdf.namedNode(q.subject.value), p: rdf.namedNode(q.predicate), o: object, b: rdf.literal(b) };
        return [Object.assign(row, { file: '' }) as Row & { file: string }];
    }) : named.length || vocabulary ? await byFile(ctx.port, files, namedQuery(named, vocabulary)) : [];

    // The shapes part: the statements of the shapes closure (K2), by subject; a statement of a document outside it is a model statement.
    const shapeKeys = new Set(ctx.shapes.closure.map(q => `${fileOfGraph(q.graph.value)} ${termKey(q.subject)}`));
    const isShapeRow = (r: Row & { file: string }, q: Quad) => shapeKeys.has(`${r.file} ${termKey(q.subject)}`);
    const shapesBySubject = new Map<string, Quad[]>();
    for (const q of ctx.shapes.closure) (shapesBySubject.get(q.subject.value) ?? shapesBySubject.set(q.subject.value, []).get(q.subject.value)!).push(q);

    // The model statements (not the shapes part), once each, by subject; `full`: the subjects whose every statement is here.
    const model = new Map<string, Map<string, Quad>>(), full = new Set<string>(), skos = new Set<string>();
    for (const r of modelRows) {
        const q = quadOf(r), b = r.b?.value;
        if (isShapeRow(r, q)) continue;
        const s = q.subject.value, t = rdf.quad(q.subject, q.predicate, q.object);
        (model.get(s) ?? model.set(s, new Map()).get(s)!).set(tripleKey(t), t);
        if (b === 'a' || b === 'v') full.add(s);
        if (b === 'v' && q.predicate.value === RDF_TYPE && SKOS_TYPES.some(x => x.value === q.object.value)) skos.add(s);
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
        for (const q of figureRelations) {
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
