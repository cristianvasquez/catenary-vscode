## `turtle/query`: a SPARQL request for programs, with each file a named graph

### What

A custom request, listed under the server's `experimental` capabilities next to `turtle/graph`, for a client that is not an editor (another extension, a tool that reuses the running server):

```json
{ "query": "SELECT ?g (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g",
  "files": ["file:///w/data.ttl"], "base": "file:///w/", "timeoutSeconds": 10, "maxRows": 0 }
```

Only `query` is required. The answer is SPARQL 1.1 Query Results JSON with full IRIs, plus `kind` (`select`, `ask`, `construct`), `omitted` (rows past `maxRows`) and `elapsedMs`. CONSTRUCT and DESCRIBE answer `{"triples": [{"subject", "predicate", "object"}]}` in the results JSON term form. Nothing is shown and no file is written. The data is the workspace as the editor has it (open documents with their unsaved edits, imports excluded), or the `files` given.

In this request's dataset every document is also a named graph, named by its URI; a TriG or N-Quads graph named by an IRI is a named graph of its own (one named by a blank node counts as its file's). So `GRAPH <file:///w/data.ttl> { … }` reads one file, and a query can join across files. The default graph is still the union, and `FROM` / `FROM NAMED` are still ignored.

### Why

The query engine is fast, but a program could only reach it through `turtle.runQuery` (a `.rq` document URI in, a Markdown file and `window/showDocument` out, display limits applied) or by spawning `turtle-lsp query` (disk only, graphs flattened). An extension that keeps its own model of the workspace (in my case a diagram editor) had to fetch `turtle/graph` and run its own SPARQL engine. With this request it sends its queries to the server instead.

### How

- `rdf::dataset::Index::with_graphs(g, docs, uris)`: the existing `Index` with an optional `Names` table. `quads` maps a triple number to its graph through `Graph::origin`; `internal_named_graphs` and `contains_internal_graph_name` list and check the names. `Index::new` (the SHACL-SPARQL shapes-graph case) is unchanged in behaviour.
- `rdf::graph`: `with_p_numbered` and `all_numbered` (the triple number beside the triple), used by `quads`.
- `query::run_with_graphs`: `run` with the named index; `run` itself is unchanged, so ▶ Run query, the CLI and the browser editor keep their dataset.
- `query::render::json_value`: the JSON renderer as a value, with CONSTRUCT triples; `json` now wraps it.
- `server::query_request`: params, document selection, limits, the thread (as `turtle/graph`'s), the answer and the error codes (`InvalidParams` for a bad query, an UPDATE, or a `files` entry that is no document; `RequestFailed` for a run stopped at a limit).

### Tests

- Unit: `run_names_no_graphs_and_run_with_graphs_names_each_document`, `run_with_graphs_keeps_trig_graphs_and_ignores_from`, `json_value_has_construct_triples` (src/query/tests.rs).
- Protocol: test/query-request.test.mjs over stdio (capabilities, SELECT, named graphs and a cross-file join, `files`, unsaved edits, ASK, CONSTRUCT, `maxRows`, error codes). test/graph.test.mjs's capabilities assertion updated.
- Measured on a 37-file, 20k-triple workspace: 2–6 ms per request round trip, all 20k rows as JSON in 142 ms.

### Notes for review

- `cargo test --release --locked --lib -- --skip timing_` (854 tests), the `timing_` tests, `cargo fmt --check`, `cargo clippy --release --locked --all-targets -- -D warnings` and `node --test test/query-request.test.mjs test/graph.test.mjs` all pass. Not run: the chaos tests, the web engine build and the VS Code tests.
- `run_with_graphs` and `json_value` are `pub(crate)`, as AGENTS.md asks; nothing was added to the public-interface doctest.
- Out of scope, deliberately: `$/cancelRequest` for a pending `turtle/query` (same as `turtle/graph`), `FROM` / `FROM NAMED` honouring, blank-node graph names.
