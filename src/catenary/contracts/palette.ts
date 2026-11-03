// Vocabulary class palette contract; adapted from Catenary packages/contracts/src/palette.ts.


export interface PaletteClass {
    iri: string;
    /** Written label of the class. None: the host names it from its IRI. */
    name?: string;
    description?: string;
    /** Palette position (sh:order). None: after the ordered classes, by name. */
    order?: number;
    /** The resources that declare the class for this plugin (SHACL: its node shapes). */
    sources?: string[];
    /** What the plugin read but cannot give, as text for the user (SHACL: `knows: inverse path is not supported`). */
    notes?: string[];
}
