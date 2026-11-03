// Browser-safe SHACL target records and labels; adapted from Catenary packages/shacl/src/common/index.ts.

/** Browser-safe SHACL target declarations. Several declarations select their union. */
export interface ShapeTargets {
    targetClass?: string;
    /** All class targets, including targetClass. */
    targetClasses?: string[];
    targetSubjectsOf?: string[];
    targetObjectsOf?: string[];
    targetNodes?: FocusNode[];
    /** Node constraints on this node shape, independent of its targets. */
    nodes?: string[];
}


/** Catenary replaces blank nodes with IRIs before SHACL reads them. */
export interface FocusNode {
    termType: 'NamedNode' | 'Literal';
    value: string;
    language?: string;
    datatype?: string;
}


export type TargetKind = 'targetClass' | 'implicitClass' | 'targetNode' | 'targetSubjectsOf' | 'targetObjectsOf';


export interface TargetReason {
    kind: TargetKind | 'node';
    target: FocusNode;
    sourceShape?: string;
    sourceNode?: FocusNode;
    property?: string;
}


export interface TargetMatch {
    shape: string;
    node: FocusNode;
    reasons: TargetReason[];
}


/** Text shared by shape cards, Properties and canvas pickers. */
export function targetText(targets: ShapeTargets, label: (iri: string) => string): string {
    return [
        [...new Set(targets.targetClasses ?? (targets.targetClass ? [targets.targetClass] : []))].map(label).join(' or '),
        targets.targetSubjectsOf?.length ? `subjects of ${targets.targetSubjectsOf.map(label).join(' or ')}` : '',
        targets.targetObjectsOf?.length ? `objects of ${targets.targetObjectsOf.map(label).join(' or ')}` : '',
        targets.targetNodes?.length ? `nodes ${targets.targetNodes.map(n => n.termType === 'NamedNode' ? label(n.value) : JSON.stringify(n.value)).join(' or ')}` : ''
    ].filter(Boolean).join(' · ') || 'no target';
}


export function reasonText(reasons: readonly TargetReason[], label: (iri: string) => string): string {
    return [...new Set(reasons.map(r => {
        const value = r.target.termType === 'NamedNode' ? label(r.target.value) : JSON.stringify(r.target.value);
        return r.kind === 'node' ? `checked through ${label(r.sourceShape!)}${r.property ? ` (${label(r.property)})` : ''}`
            : r.kind === 'targetSubjectsOf' ? `subjects of ${value}` : r.kind === 'targetObjectsOf' ? `objects of ${value}`
            : r.kind === 'targetNode' ? `node ${value}` : `class ${value}`;
    }))].join(' · ');
}

