// Index diagram placement and element ids without the read model; adapted from Catenary modeler/src/browser/diagram/diagram-ids.ts.

/** The diagram elements of one view editor by id, with the element that each card or edge places. */
export interface DiagramIds {
    /** The graph has an element with this id. */
    has(id: string): boolean;
    /** The element that a diagram id shows: a card or a placed edge its element. Other ids stay (a mark: its placement). */
    elementOf(id: string): string;
    /** The diagram id that shows an element: its card or edge. Other ids stay. */
    placementOf(element: string): string;
    /** The schema fields of a diagram element (GLSP copies them to the client model by name). */
    get(id: string): Record<string, unknown> | undefined;
}

export function diagramIds(elements: Iterable<{ id: string; element?: unknown }>): DiagramIds {
    const byId = new Map<string, Record<string, unknown>>();
    const elementOf = new Map<string, string>(), placementOf = new Map<string, string>();
    for (const e of elements) {
        byId.set(e.id, e as unknown as Record<string, unknown>);
        if (typeof e.element !== 'string' || !e.element) continue;
        elementOf.set(e.id, e.element);
        if (!placementOf.has(e.element)) placementOf.set(e.element, e.id);
    }
    return {
        has: id => byId.has(id),
        elementOf: id => elementOf.get(id) ?? id,
        placementOf: element => placementOf.get(element) ?? element,
        get: id => byId.get(id)
    };
}
