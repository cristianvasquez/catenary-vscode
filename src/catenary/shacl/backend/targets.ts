// SHACL focus node terms and target selections; adapted from Catenary packages/shacl/src/backend/targets.ts.
import type { QueryTerm as Term } from '../../contracts/query';
import { XSD, iri } from '../../contracts/query';
import type { FocusNode } from '../common/index';


export interface QueryTerm extends Term {
    language?: string;
    datatype?: { value: string };
}


/** The host owns the RDF store and graph identities. This package owns the query. */
export interface TargetQueryPort {
    select(query: string): readonly Record<string, QueryTerm>[];
    /** Materialize a bounded frontier once and traverse its direct predicates in an RDF/JS dataset. */
    traverse?(nodes: readonly FocusNode[], predicates: readonly string[], reverse: boolean, graphs: readonly string[]): readonly { node: FocusNode; predicate: string; value: FocusNode }[];
}


export interface TargetSelection {
    nodes?: readonly FocusNode[];
    shapes?: readonly string[];
}


export function term(node: FocusNode): string {
    if (node.termType === 'NamedNode') return iri(node.value);
    if (node.language && !/^[a-z]+(?:-[a-z0-9]+)*$/i.test(node.language)) throw new Error('Invalid literal language in SHACL query.');
    return JSON.stringify(node.value) + (node.language ? `@${node.language}` : node.datatype ? `^^${iri(node.datatype)}` : '');
}


export function focus(node: QueryTerm): FocusNode {
    if (node.termType !== 'NamedNode' && node.termType !== 'Literal') throw new Error('SHACL query returned an unsupported term.');
    return { termType: node.termType, value: node.value,
        ...(node.language ? { language: node.language } : node.datatype && node.datatype.value !== XSD + 'string' ? { datatype: node.datatype.value } : {}) };
}


export {  };
