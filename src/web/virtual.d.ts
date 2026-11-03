// Modules that the web build makes (scripts/build-web.mjs).

/** The notation files by file name. */
declare module 'catenary:notations' {
    const files: Record<string, string>;
    export default files;
}

/** The sample workspace (test/fixtures/shapes, without graph.json) by relative path. */
declare module 'catenary:samples' {
    const files: Record<string, string>;
    export default files;
}
