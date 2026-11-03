Title: A request for programs: `turtle/query` (SPARQL text in, results JSON out, one named graph per file)

I build Catenary, a VS Code extension that draws diagrams of RDF, SHACL and SKOS models (https://github.com/cristianvasquez/catenary-vscode). It runs next to your extension and reads the workspace through the language server. The query engine is exactly what it needs, but a program cannot reach it today:

- `turtle.runQuery` takes a `.rq` document URI, writes a Markdown table and opens it with `window/showDocument`. The rows are formatted for people and capped by `query.maxRows`.
- `turtle-lsp query` on the command line gives results JSON, but reads the disk, not the editor buffers, and starts a process per query.
- `turtle/graph` gives the whole workspace as nodes and edges (9 MB for 20k triples), without named graphs or triple terms.

So Catenary fetches `turtle/graph` on each refresh and runs its own SPARQL engine over a copy. The server has already parsed and indexed everything.

**Proposal.** A custom request `turtle/query`, listed under `experimental` next to `turtle/graph`:

```json
{ "query": "SELECT ?g (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g",
  "files": ["file:///w/data.ttl"], "base": "file:///w/", "timeoutSeconds": 10, "maxRows": 0 }
```

Only `query` is required. The answer is SPARQL 1.1 Query Results JSON with full IRIs, plus `kind` (`select`, `ask`, `construct`), `omitted` (rows past `maxRows`) and `elapsedMs`; CONSTRUCT and DESCRIBE answer `{"triples": [{subject, predicate, object}]}` in the same term form. Nothing is shown and no file is written. The data is the workspace as the editor has it (unsaved edits included, imports excluded), or the `files` given.

One thing differs from ▶ Run query: in this request's dataset every file is also a named graph, named by its URI, and a TriG, N-Quads or JSON-LD graph named by an IRI is a graph of its own. So `GRAPH <file:///w/shapes.ttl> { … }` reads one file and a query can join across files. The default graph stays the union, `FROM` and `FROM NAMED` stay ignored, and ▶ Run query, the CLI and the browser editor keep their dataset.

**I have a working implementation** on a branch of my fork, in case it helps you judge the size: https://github.com/cristianvasquez/turtle-lsp/tree/turtle-query (one commit on top of v0.13.1). It adds `server/query_request.rs`, `Index::with_graphs` in `rdf/dataset.rs` (the existing `Index::new` path is untouched), `query::run_with_graphs`, `render::json_value`, unit tests, a stdio protocol test, and the docs. `cargo test --release --locked --lib`, fmt, clippy and the node tests pass. Measured on a 37-file, 20k-triple workspace: 2 to 6 ms per request, all 20k quads as JSON in about 200 ms (the same workspace through `turtle/graph` takes 900 ms and 9 MB, and loses the 133 triple terms).

What I did not do, on purpose: `$/cancelRequest` for a pending query (same as `turtle/graph`), `FROM` honouring, blank-node graph names (they fold into the file's graph), and any limit on concurrent query threads.

I am happy to open it as a pull request as is, or to change the shape of the request first if you see it differently. Two questions where your view decides:

1. Is one named graph per file the right dataset for this request, or would you rather keep the flat dataset and add a `files` parameter only?
2. Should `maxRows` default to the `query.maxRows` setting, as the lens does, or to no limit, as I did for a program?
