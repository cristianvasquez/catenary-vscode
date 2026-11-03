// The quads of one view graph in memory, with a change log, and its deterministic TriG text. No graph, no store.
import type { NamedNode, Quad, Quad_Object, Quad_Predicate, Quad_Subject, Term } from '@rdfjs/types';
import { PREFIXES } from '../catenary/model/shapes-doc';
import { rdf, termKey, tripleKey } from './terms';

type Maybe<T> = T | null | undefined;

/** One step of the change log. */
export interface ViewChange { op: 'add' | 'remove'; quad: Quad }

/**
 * The statements of one view graph. Every quad has the graph `graph`. Terms compare by `termKey`, so terms of other factories
 * (Oxigraph, the turtle/query answer) match. `steps()` gives every add and remove in order; `changes()` the net change since the start.
 */
export class ViewQuads {
    readonly graph: NamedNode;
    private readonly bySubject = new Map<string, Map<string, Quad>>();
    private readonly original = new Map<string, Quad>();
    private readonly log: ViewChange[] = [];

    /** `quads`: the statements of one graph. `graph`: its IRI; omitted, the graph of the first quad. */
    constructor(quads: Iterable<Quad>, graph?: NamedNode) {
        const list = [...quads];
        const g = graph ?? list[0]?.graph;
        if (g?.termType !== 'NamedNode') throw new Error('A view is a named graph: give its IRI.');
        this.graph = rdf.namedNode(g.value);
        for (const q of list) {
            if (q.graph.termType !== 'NamedNode' || q.graph.value !== this.graph.value) throw new Error(`The quad ${tripleKey(q)} is not in the view ${this.graph.value}.`);
            const c = rdf.quad(q.subject, q.predicate, q.object, this.graph);
            this.put(c);
            this.original.set(tripleKey(c), c);
        }
    }

    private put(q: Quad): void {
        const s = termKey(q.subject);
        (this.bySubject.get(s) ?? this.bySubject.set(s, new Map()).get(s)!).set(tripleKey(q), q);
    }

    /** The statements that match; `null` or `undefined` matches every term. */
    match(s?: Maybe<Term>, p?: Maybe<Term>, o?: Maybe<Term>): Quad[] {
        const rows = s ? [...(this.bySubject.get(termKey(s))?.values() ?? [])] : [...this.bySubject.values()].flatMap(m => [...m.values()]);
        const pk = p && termKey(p), ok = o && termKey(o);
        return rows.filter(q => (!pk || termKey(q.predicate) === pk) && (!ok || termKey(q.object) === ok));
    }

    has(s: Term, p: Term, o: Term): boolean {
        return !!this.bySubject.get(termKey(s))?.has(tripleKey({ subject: s, predicate: p, object: o }));
    }

    add(s: Quad_Subject, p: Quad_Predicate, o: Quad_Object): void {
        if (this.has(s, p, o)) return;
        const q = rdf.quad(s, p, o, this.graph);
        this.put(q);
        this.log.push({ op: 'add', quad: q });
    }

    remove(q: { subject: Term; predicate: Term; object: Term }): void {
        const rows = this.bySubject.get(termKey(q.subject)), key = tripleKey(q), found = rows?.get(key);
        if (!found) return;
        rows!.delete(key);
        if (rows!.size === 0) this.bySubject.delete(termKey(q.subject));
        this.log.push({ op: 'remove', quad: found });
    }

    removeMatches(s?: Maybe<Term>, p?: Maybe<Term>, o?: Maybe<Term>): void {
        for (const q of this.match(s, p, o)) this.remove(q);
    }

    /** Replace the objects of (s, p). Undefined removes them. */
    set(s: Quad_Subject, p: Quad_Predicate, o: Quad_Object | undefined): void {
        for (const q of this.match(s, p)) if (!o || termKey(q.object) !== termKey(o)) this.remove(q);
        if (o) this.add(s, p, o);
    }

    objects(s: Term, p: Term): Quad_Object[] { return this.match(s, p).map(q => q.object); }

    /** The first object by value: a stable choice when there are several. */
    object(s: Term, p: Term): Quad_Object | undefined {
        return this.objects(s, p).sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))[0];
    }

    subjects(p: Term, o?: Maybe<Term>): Quad_Subject[] { return this.match(null, p, o).map(q => q.subject); }

    number(s: Term, p: Term, fallback: number): number {
        const v = this.object(s, p)?.value;
        return v === undefined || isNaN(Number(v)) ? fallback : Number(v);
    }

    quads(): Quad[] { return this.match(); }

    /** Every add and remove since the start, in order (an add that a later remove undoes is in it). */
    steps(): readonly ViewChange[] { return this.log; }

    /** The net change since the start: statements that are new, and statements that are gone. */
    changes(): { added: Quad[]; removed: Quad[] } {
        const now = new Map(this.quads().map(q => [tripleKey(q), q]));
        return {
            added: [...now].filter(([k]) => !this.original.has(k)).map(([, q]) => q),
            removed: [...this.original].filter(([k]) => !now.has(k)).map(([, q]) => q)
        };
    }
}

/** Deterministic TriG of one view: the prefixes, then the graph block with its statements sorted. Retains RDF 1.2 triple terms. */
export function viewText(view: ViewQuads): string {
    const statements = [...new Set(view.quads().map(tripleKey))].sort();
    const prefixes = Object.entries(PREFIXES).map(([p, ns]) => `@prefix ${p}: <${ns}> .`);
    return [...prefixes, '', `${termKey(view.graph)} {`, ...statements.map(s => `  ${s} .`), '}', ''].join('\n');
}
