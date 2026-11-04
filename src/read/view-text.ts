// Text-only projection. The model/instance reader stays in phase 2; projection rules stay in projectView.
import type { Quad, Term } from '@rdfjs/types';
import { emptyDoc } from '../catenary/model/doc';
import { NS } from '../catenary/model/terms';
import { elementId, relationId, relationTriple } from '../catenary/rdf/ids';
import { readLegacy } from '../catenary/rdf/loader';
import { cardIdsOf, key, type Plain, type Resource, projectView } from '../catenary/rdf/records';
import { rdf } from '../catenary/rdf/terms';
import type { ModelContext } from './diagram';
import type { KeptPrefetch } from './figures';

const plain = (term: Term): Plain => ({ termType: term.termType, value: term.value, term });

export function viewDocFromText(ctx: ModelContext, iri: string, quads: Quad[], kept: KeptPrefetch) {
    const doc = emptyDoc();
    doc.shapes = ctx.shapes.index.model;
    doc.instances = { ...kept.records?.instances };
    doc.relations = { ...kept.records?.relations };
    const subjects = new Map<string, { term: Term; props: Map<string, Term[]> }>();
    for (const q of readLegacy(quads).quads) {
        let s = subjects.get(q.subject.value);
        if (!s) subjects.set(q.subject.value, s = { term: q.subject, props: new Map() });
        const values = s.props.get(q.predicate.value) ?? [];
        if (!values.some(t => t.equals(q.object))) values.push(q.object);
        s.props.set(q.predicate.value, values);
    }
    const objects = (s: string, p: string) => subjects.get(s)?.props.get(p) ?? [];
    if (!objects(iri, NS.rdf + 'type').some(t => t.value === NS.view + 'View')) return doc;
    const parts: Parameters<typeof projectView>[2] = { cards: [], edges: [], arrows: [], groups: [], notes: [], references: [], fileReferences: [], collections: [] };
    const viewIds = new Map([...ctx.views.keys()].map(v => [v, elementId(rdf.namedNode(v))]));
    // New terms still get a box before the server knows their type or label.
    for (const s of subjects.values()) for (const e of [
        ...(s.props.get(NS.view + 'element') ?? []),
        ...(s.props.get(NS.rdf + 'type')?.some(t => t.value === NS.view + 'EntityGroup') ? s.props.get(NS.view + 'member') ?? [] : [])
    ]) {
        if (e.termType !== 'NamedNode' || viewIds.has(e.value) || ctx.shapes.shapeSubjects.has(`<${e.value}>`) || e.value.startsWith('urn:trellis:list:')) continue;
        if (objects(e.value, NS.rdf + 'type').some(t => ['Frame', 'Note', 'FileRef', 'EntityGroup'].some(k => t.value === NS.view + k))) continue;
        const id = elementId(e);
        doc.instances[id] ??= { id, uri: e.value, label: e.value.replace(/^.*[#/:]/, ''), types: [], fields: {} };
    }
    for (const s of subjects.values()) for (const t of s.props.get(NS.rdf + 'reifies') ?? []) {
        if (t.termType !== 'Quad' || t.subject.termType !== 'NamedNode' || t.predicate.termType !== 'NamedNode' || t.object.termType !== 'NamedNode' || t.predicate.value === NS.view + 'arrow') continue;
        const id = relationId(t.subject, t.predicate, t.object);
        doc.relations[id] ??= { id, subject: elementId(t.subject), predicate: t.predicate.value, object: elementId(t.object) };
    }
    const ids = cardIdsOf(new Map(Object.values(doc.instances).map(i => [i.uri, i.id])), doc.shapes);
    const relationIds = new Map<string, string>();
    for (const r of Object.values(doc.relations)) {
        const t = relationTriple(r.id);
        if (t) relationIds.set(`${t.s.value} ${t.p.value} ${t.o.value}`, r.id);
    }
    const arrowStatements = new Set<string>();
    for (const s of subjects.values()) for (const o of s.props.get(NS.view + 'arrow') ?? []) arrowStatements.add(`${key(plain(s.term))} ${key(plain(o))}`);
    const properties = new Set(Object.keys(doc.shapes.properties));
    for (const [subject, s] of [...subjects].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        if (!objects(subject, NS.rdf + 'type').some(t => t.value === NS.view + 'Placement')) continue;
        const values = new Map<string, Plain[]>();
        for (const p of ['element', 'x', 'y', 'width', 'height', 'color', 'display', 'fromSide', 'toSide', 'vertices']) {
            const os = objects(subject, NS.view + p);
            if (os.length) values.set(p, os.map(plain));
        }
        for (const t of objects(subject, NS.rdf + 'reifies')) if (t.termType === 'Quad') {
            for (const p of ['subject', 'predicate', 'object'] as const) values.set(p, [plain(t[p])]);
        }
        const r: Resource = { s: plain(s.term), values };
        const e = values.get('element')?.[0];
        if (!e && values.has('subject')) {
            (values.get('predicate')?.[0].value === NS.view + 'arrow' ? parts.arrows : parts.edges).push(r);
            continue;
        }
        const marks = [['Frame', 'groups', 'label', NS.rdfs], ['Note', 'notes', 'text', NS.view], ['FileRef', 'fileReferences', 'file', NS.view], ['EntityGroup', 'collections', 'member', NS.view]] as const;
        const mark = e && marks.filter(([type]) => objects(e.value, NS.rdf + 'type').some(t => t.value === NS.view + type)).at(-1);
        if (mark) {
            const [, kind, prop, ns] = mark;
            values.set(prop, objects(e!.value, ns + prop).map(plain));
            parts[kind]!.push(r);
        } else if (e && viewIds.has(e.value)) {
            values.set('references', [e]);
            parts.references.push(r);
        } else parts.cards.push(r);
    }
    const empty = { cards: [], edges: [], arrows: [], groups: [], notes: [], references: [], collections: [] };
    for (const v of [iri, ...ctx.views.keys()].filter((v, i, all) => all.indexOf(v) === i)) {
        const cached = ctx.viewLabels.get(v);
        const label = v === iri ? objects(v, NS.rdfs + 'label')[0]?.value : cached && [...cached.subjects.values()][0]?.labels[0]?.value;
        const view = projectView(v, label ?? v.replace(/^.*[#/:]/, ''), v === iri ? parts : empty, ids, relationIds, viewIds, [], arrowStatements, properties);
        doc.views[view.id] = view;
    }
    return doc;
}
