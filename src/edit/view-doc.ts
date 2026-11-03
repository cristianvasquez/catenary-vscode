// The Doc of a view from its quads in memory and the model facts: the view read (catenary/rdf/view-read.ts, readView without `elements`) of a
// view that is not saved yet. No graph, no store.
import type { Quad, Term } from '@rdfjs/types';
import { Doc, emptyDoc } from '../catenary/model/doc';
import { pickLabel } from '../catenary/model/labels';
import type { ShapesModel } from '../catenary/model/shapes-doc';
import { NS } from '../catenary/model/terms';
import { fileOfGraph, UNION_GRAPH } from '../catenary/rdf/files';
import { cardIdsOf, first, instanceRecords, key, type Plain, projectView, type Resource, type Statements } from '../catenary/rdf/records';
import { labelFromIri, labelLiterals, SKOS_MEMBERSHIP, SKOS_TYPES } from '../catenary/rdf/vocabulary';
import type { Facts } from './facts';
import { elementId, P, rdf, tripleKey, V } from './terms';
import type { ViewQuads } from './view-quads';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const plain = (t: Term): Plain => ({ termType: t.termType, value: t.value, term: t });

const MARKS = [['Frame', 'groups', 'label'], ['Note', 'notes', 'text'], ['FileRef', 'fileReferences', 'file'], ['EntityGroup', 'collections', 'member']] as const;

const MARK_PREDICATES: Record<string, string> = { label: P.label.value, text: V.text.value, file: V.file.value, member: V.member.value };

const PLACEMENT_PROPS = ['element', 'x', 'y', 'width', 'height', 'color', 'display', 'fromSide', 'toSide', 'vertices'] as const;

/** The values of `s` for each local name: the objects of `view:<name>`, once each. */
function resource(view: ViewQuads, s: Term, names: readonly string[], predicate = (n: string) => NS.view + n): Resource {
    const values = new Map<string, Plain[]>();
    for (const n of names) {
        const os = view.match(s, rdf.namedNode(predicate(n))).map(q => plain(q.object));
        if (os.length) values.set(n, os);
    }
    return { s: plain(s), values };
}

/**
 * The Doc of the view `view` (readView of view-read.ts): the view, the instances it places (and the SKOS vocabulary when it shows shapes),
 * their relations, and the views it refers to. `facts` carry the statements of the placed IRIs. An empty Doc when the quads hold no view:View.
 */
export function docOfViewQuads(view: ViewQuads, facts: Facts, shapes: ShapesModel, warnings: string[] = []): Doc {
    const iri = view.graph.value;
    if (!view.match(null, P.type, V.View).length) return emptyDoc();
    const doc = emptyDoc();
    doc.shapes = shapes;
    const placements = view.subjects(P.type, V.Placement);
    // Placements and group members are the bounded subject set.
    const placed = new Set(placements.flatMap(pl => view.objects(pl, V.element).map(o => o.value)));
    for (const e of [...placed]) for (const m of view.objects(rdf.namedNode(e), V.member)) if (view.has(rdf.namedNode(e), P.type, V.EntityGroup)) placed.add(m.value);
    const own = facts.statementsOf([...placed]);
    // A view shows shape elements when it places a subject of a shapes file, or a concept scheme or collection of the model.
    const valueSetTypes = SKOS_TYPES.filter(t => !t.value.endsWith('#Concept')).map(t => t.value);
    const shows = view.match(null, V.element).some(q => q.object.termType === 'NamedNode' && (facts.shapesMatch(q.object.value, null).length > 0
        || own.some(r => r.subject.value === q.object.value && r.predicate.equals(P.type) && valueSetTypes.includes(r.object.value))));
    const rows = new Map<string, Quad>();
    for (const q of [...own, ...shows ? facts.vocabularyStatements() : []]) rows.set(tripleKey(q), q);
    const statements = new Map<string, Statements>();
    for (const q of rows.values()) {
        const s = plain(q.subject);
        let e = statements.get(key(s));
        if (!e) statements.set(key(s), e = { s, rows: [] });
        e.rows.push({ s, p: plain(q.predicate), o: plain(q.object) });
    }
    const subjects = [...statements.values()].filter(e => e.s.termType === 'NamedNode' && e.s.value !== UNION_GRAPH
        && e.rows.some(r => r.p.value === P.type.value || r.p.value === P.label.value));
    // A view with shape elements: the SKOS subjects of the shapes files that are not instances above, with their statements of the first such file.
    const files = new Map<string, string>();
    if (shows) {
        const known = new Set(subjects.map(e => e.s.value));
        const found = [...SKOS_TYPES.flatMap(t => facts.shapesMatch(null, P.type.value, t.value)), ...SKOS_MEMBERSHIP.flatMap(p => facts.shapesMatch(null, p.value, null))];
        for (const graph of [...new Set(found.map(q => q.graph.value))].sort(cmp)) {
            for (const q of found.filter(x => x.graph.value === graph)) {
                const s = q.subject.value;
                if (q.subject.termType !== 'NamedNode' || known.has(s)) continue;
                known.add(s);
                files.set(s, fileOfGraph(graph));
                const rs = facts.shapesMatch(s, null).filter(x => x.graph.value === graph).map(x => ({ s: plain(x.subject), p: plain(x.predicate), o: plain(x.object) }));
                subjects.push({ s: rs[0].s, rows: rs });
            }
        }
    }
    const { instanceIds, relationIds } = instanceRecords(doc, subjects, files, warnings, facts.language);

    // Views that the part names: this view and the targets of its view references.
    const views = new Set([iri, ...[...placed].filter(e => e === iri || facts.isView(e))]);
    const labelOf = (graph: string) => {
        if (graph !== iri) return facts.viewLabel(graph);
        const subject = view.subjects(P.type, V.View).map(t => t.value).sort(cmp)[0];
        return pickLabel(labelLiterals(p => p === P.label.value ? view.objects(rdf.namedNode(subject), P.label) : []), facts.language) ?? labelFromIri(subject);
    };
    const viewIds = new Map([...views].map(graph => [graph, elementId(rdf.namedNode(graph))]));

    // Placements of the view. A placement of a relation or an arrow reifies its triple.
    const resources = placements.map(pl => {
        const r = resource(view, pl, PLACEMENT_PROPS);
        const triple = view.objects(pl, P.reifies).find(o => o.termType === 'Quad') as Quad | undefined;
        if (triple) for (const [n, t] of [['subject', triple.subject], ['predicate', triple.predicate], ['object', triple.object]] as const) r.values.set(n, [plain(t)]);
        return r;
    });
    // The marks that the placements place, with their content. A subject with two mark types: the last of MARKS.
    const marks = new Map<string, { kind: typeof MARKS[number][1]; r: Resource }>();
    for (const [type, kind, prop] of MARKS) {
        for (const e of placed) {
            const t = rdf.namedNode(e);
            if (view.has(t, P.type, rdf.namedNode(NS.view + type))) marks.set(key(plain(t)), { kind, r: resource(view, t, [prop], n => MARK_PREDICATES[n]) });
        }
    }
    const parts: Parameters<typeof projectView>[2] & { fileReferences: Resource[] } = {
        cards: [], edges: [], arrows: [], groups: [], notes: [], references: [], fileReferences: [], collections: []
    };
    for (const r of resources) {
        const e = first(r.values.get('element'));
        const mark = e && marks.get(key(e));
        if (!e && r.values.has('subject')) (first(r.values.get('predicate'))?.value === V.arrow.value ? parts.arrows : parts.edges).push(r);
        else if (mark) parts[mark.kind].push({ s: r.s, values: new Map([...mark.r.values, ...r.values]) });
        else if (e && e.termType === 'NamedNode' && views.has(e.value)) parts.references.push({ s: r.s, values: new Map([...r.values, ['references', [e]]]) });
        else parts.cards.push(r);
    }
    // Arrows: a placement shows a statement `x view:arrow y` of this view.
    const arrowStatements = new Set(view.match(null, P.reifies).flatMap(q => {
        const t = q.object;
        return t.termType === 'Quad' && t.predicate.equals(V.arrow) && view.has(t.subject, V.arrow, t.object) ? [`${key(plain(t.subject))} ${key(plain(t.object))}`] : [];
    }));

    // Cards: instances, node shapes, value sets, and properties drawn out of their cards (by IRI). A shape wins over an instance.
    const cardIds = cardIdsOf(instanceIds, shapes);
    const properties = new Set(Object.keys(shapes.properties));
    for (const graph of [...views].sort(cmp)) {
        const empty = { cards: [], edges: [], arrows: [], groups: [], notes: [], references: [], fileReferences: [], collections: [] };
        const v = projectView(graph, labelOf(graph), graph === iri ? parts : empty, cardIds, relationIds, viewIds, warnings, arrowStatements, properties);
        const description = graph === iri ? view.objects(view.graph, V.description)[0] : undefined;
        if (description?.termType === 'Literal') v.description = description.value;
        doc.views[v.id] = v;
    }
    return doc;
}
