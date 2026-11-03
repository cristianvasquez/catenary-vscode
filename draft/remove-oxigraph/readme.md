# Remove the model store: turtle-lsp is the only engine

Handoff document of the round. Updated when a kata closes or a decision changes.

## Intent

The model lives in turtle-lsp only. Catenary never holds a copy of the model. Every question about the model is a `turtle/query` request to the server (the fork `cristianvasquez/turtle-lsp`, branch `turtle-query`).

A view is one `.trig` file, and the canvas edits that file. A canvas command changes the text of the view document through a VS Code `WorkspaceEdit`; VS Code records the undo; the server sees the new text through `didChange`; the next draw reads the new state through `turtle/query`. To change the text, Catenary parses that one file in memory for the duration of the command. That is a document being edited, not a store.

Done means: no `ModelGraph`, no `QuadStore`, no `OxigraphStore`, no `graphOf`, no `oxigraph` in `package.json`. The only RDF Catenary holds in memory is the one view file it is editing, while it edits it.

## Why the earlier rounds failed

Four rounds (katas ansc, mzg2, 9k26, mh0y, y4mq) changed how quads get into the store and how fast. None removed the store, because no kata said the store is the problem and no done criterion said the dependency is gone. The branch `turtle-query` loads the model through `turtle/query` into Oxigraph: same 12 importing files as main. It is abandoned; the katas branch from `main`.

## What exists (main, 08341eb)

| Part | Where | State |
|---|---|---|
| Store | `src/catenary/rdf-files/oxigraph-store.ts`, `store.ts`; `src/catenary/rdf-core/graph.ts` `ModelGraph` (367 lines: transactions, undo patches, cache keys, `scopedQuery`) | to delete |
| Load | `src/model/graph-input.ts` `graphOf` (turtle/graph → N-Quads → Oxigraph, view files parsed from disk), `src/model/nquads.ts`, `src/node/quads.ts` | to delete |
| Read side | 21 files, about 140 graph reads: `src/catenary/rdf/{view-read,shapes-read,scoped-doc,notations,shacl-targets,authoring,shapes,vocabulary,views,quad-read,records,link-choices}.ts`, `src/catenary/shacl/backend/*`, `src/catenary/rdfs/domain-range.ts`, `src/model/choices.ts`, `src/node/diagnostics.ts` | rewrite over the port |
| Pure records | `src/catenary/model/{doc,view-schema,diagram-schema,shapes-doc,metamodel,notation,notation-graph,notation-join,notation-schema,labels}.ts`, `src/catenary/rdf/records.ts` (`instanceRecords`, `projectView`) | keep |
| Write side | `src/model/store.ts` `ViewStore`; `src/catenary/rdf/{commands,ops,figure-edits,clipboard}.ts` (19 command kinds; post-steps `placeConnectors`, `syncFigures`, `pruneArrows`) | rewrite over view quads + facts |
| Editor | `src/vscode/canvas-editor.ts` `CustomEditorProvider`: document = the store, undo = store patch, file written on save; backups; `keepOpenViews` | becomes `CustomTextEditorProvider` |
| Hosts | `src/model/workspace-core.ts`, `src/node/workspace-model.ts`, `src/web/workspace.ts`; `src/node/turtle-api.ts` already has `requestQuery` | rewrite |
| GLSP | `src/node/glsp/{view-session,handlers,diagram-module,layout}.ts`; `createModel` is synchronous | schema computed before submit |
| Parsers | `parseRdfSync` (Oxigraph) in `paste-rdf.ts`, `notations.ts` (built-in `notations/*.ttl`), `markdown-view.ts`, `graph-input.ts` (`isViewFile`, `viewIriOf`) | server query, or the `n3` parser for text that is not a document |
| Browser page | `src/web/main.ts` (Oxigraph wasm), engine pinned to upstream 0.13.1 (`scripts/fetch-turtle-lsp.mjs`), no `turtle/query` | engine built from the fork |
| Tests | 129 in 16 files; 7 files build graphs with `graphOf` over the recorded `test/fixtures/shapes/graph.json` | run against the fork binary over stdio |
| Fork | `~/os/rdf/turtle-lsp` branch `turtle-query` (cd98bae local, 8cb7bdc pushed); `turtle/query`: SELECT, ASK, CONSTRUCT, DESCRIBE; `files` restricts the documents; open buffers included; default graph = union of every triple; every document a named graph; a TriG graph block a named graph of its own; blank nodes labelled `<document>:<n>`; binary at `target/release/turtle-lsp`; the wasm engine (`web/engine`, `web/build.mjs`) answers `turtle/query` inline (not built yet) | ready |

## Facts that shape the design

- `turtle/query` runs on the server; the derivation code is synchronous and reads one pattern at a time. The rewrite gives each derivation one or a few queries and works from the rows.
- The server has no shapes graph. Today the shapes part of a file is the subject closure of `shapePart` (`src/catenary/rdf/loader.ts:61`): subjects with a `sh:` statement, plus nested skolem nodes and RDF list cells below them. The new shapes query fetches the statements of the subjects reachable from a shape root over the path `(sh:property|sh:node|sh:or|sh:xone|sh:and|sh:not|sh:in|sh:path|sh:inversePath|sh:alternativePath|sh:zeroOrMorePath|sh:oneOrMorePath|sh:zeroOrOnePath|sh:languageIn|rdf:first|rdf:rest)*`. "Instance" = a subject of a model file with `rdf:type` or `rdfs:label` that is not in the shapes closure.
- Proved by `test/port.test.ts` against the fork binary over stdio on `test/fixtures/shapes` (1rhb):
  - The default graph is the union of every document, the triples inside the TriG graph blocks of the view files included (282 = 8 + 27 + 28 + 57 + 93 + 69). A model query without `files` therefore sees the view statements; model queries pass `files: modelFiles`.
  - A `.trig` document whose statements are all in graph blocks has no graph under its file URI: `GRAPH <file:///…/instances.trig> { ?s ?p ?o }` is empty. Its statements are only in the graph named by the block IRI: `GRAPH <urn:name:Bookshop> { ?s ?p ?o }` gives the 93 statements. View queries use `GRAPH <viewIri> { … }` and need no `files`.
  - `GRAPH <file:///…/data.ttl> { ?s ?p ?o }` reads one Turtle file; `files: [data.ttl]` restricts the dataset to that document (one named graph, its file URI).
  - So one query over every `.trig` file cannot tell the file of a view graph (`GRAPH ?d { ?g a view:View }` binds `?d` to the view IRI, not the file). `viewFilesOf` (`src/model/view-files.ts`) sends one `SELECT ?g WHERE { GRAPH ?g { ?g a view:View } }` per `.trig` file with `files: [file]`, in parallel. It returns `{ views, skipped }`: a view IRI in two or more files skips every one of them (`duplicate view <IRI>`); `modelFilesOf` excludes view files and skipped files.
  - A blank node comes back as `bnode` with the label `<document>:<n>`; the same query twice gives the same label; a CONSTRUCT answer gives the same labels as the SELECT. The port maps a label to `toEngine('_:' + label)` (`urn:skolem:blank:<d padded 6>-<n padded 8>`, `src/model/nquads.ts:30`). `shapes.ttl` of the fixture has no blank node; the test uses the nine of `prefixes.ttl`.
  - After `didOpen` and a full-text `didChange` of `data.ttl` on the same connection, the next `turtle/query` sees the new triple: the open buffer wins over the disk, with no wait between the notification and the request.
- Model documents = the RDF documents of the folder minus the view files (`modelFilesOf`).
- `ModelContext.modelFiles` (`src/read/diagram.ts`) is the model documents WITHOUT the manifest document (`ShapesModelRecords.files`): `shapeTargetMatches`, `hiddenNeighborCounts`, `viewFiguresOf` and `diagnosticsOf` take it as given; only `shapesModelOf` removes the manifest itself. `modelContextOf(port, documents)` builds the context (8twe).
- The turtle extension syncs `trig` documents (`editors/vscode/src/extension.ts:72`), so an edit of a view document reaches the server before the next request on the same connection.
- No command writes a model file today (`WorkspaceCore.execute` refuses a patch outside open views). Four writes reach the graph of a mark that can be another view (`ops.ts:143,144,429,441,543,560`); `placeConnectors` and `pruneArrows` touch every view. See decision 6.
- GLSP `GModelFactory.createModel` is synchronous: the session computes the schema asynchronously first, then submits.

## Decisions

1. **Read side: option A.** Each derivation is an asynchronous function over a `ModelPort` (`query(sparql, files?)`), with one or a few queries, returning the existing plain records (`Doc`, `ShapesIndex`, `Classes`, `ViewFigures`, `TargetMatch[]`). No function takes a graph or a store. In-memory consumers of rows that already exist (`readShapes` over a dataset, the SHACL `Triples` class, `LazyTripleIndex`, `instanceRecords`) stay and take the rows of one query. Option B (a temporary quad set behind the old store interface) is not allowed, not even as a step.
2. **Write side: text edits.** A command parses the view quads (from the server: `GRAPH <view> { ?s ?p ?o }`, open buffer included), changes them in memory, serializes, and applies one `WorkspaceEdit` to the view document. Model facts a command needs (is this IRI an instance, its label, its card size, the statements between placed elements) come from one prefetch query per command. First with the whole-file deterministic serializer (`viewText`); then with the tree-sitter patcher of `~/os/rdf/catenary/packages/rdf-files/src/text-patch.ts` (copied with `grammars/turtle.wasm` and `web-tree-sitter`; the package itself depends on Oxigraph and is not a dependency).
3. **Editor: `CustomTextEditorProvider`** over the `.trig` document. Undo, redo, dirty, save, revert and backup are VS Code's. `ViewStore`, patches, `backupCustomDocument`, `replaceView`, `keepOpenViews` are deleted. A change of the document (from the canvas or from a text editor) redraws the canvas.
4. **Parser package allowed** for text that is not a document: `n3` for pasted Turtle and the built-in `notations/*.ttl`. `isViewFile`, `viewIriOf`, `markdown-view` ask the server.
5. **Browser page: engine built from the fork** (`web/build.mjs` of the fork), replacing the pinned upstream download.
6. **One command edits one file.** The current view only; `moveBetweenViews` edits two, both open. The post-steps run on the current view only. A mark's statements live in the file of the view where it was made; a command on another view does not change them. A placement whose statement or mark is gone is not drawn and is removed by the next command on that view.
7. **No incremental caches.** The `WeakMap` caches keyed on the graph (`shapesIndexOf`, `shacl-targets` state, `notations` kept index, prefix tables) go. The shapes model is computed once per refresh generation (any model document change) and kept as records.
8. **Old pipeline as oracle, then deleted.** New modules live in `src/read/` and `src/edit/`. Until the cutover, tests compare the new result with the old on every fixture view (deep equal). The cutover katas switch the hosts and delete the old modules.
9. **Tests run the fork binary** over stdio on `test/fixtures/shapes` (helper `test/server.ts`); the recorded `graph.json` and `fixture-graph.ts` go with the old pipeline. The binary path: `TURTLE_LSP` env, default `~/os/rdf/turtle-lsp/target/release/turtle-lsp`.
10. The branch `turtle-query` of catenary-vscode is not merged. `toEngine` of the `<d>:<n>` labels (y4mq) is taken into K1.

## Katas

Order and dependencies. One kata = one agent session. K1 blocks everything.

| Id | Kata | Blocked by | Worker |
|---|---|---|---|
| K1 (`1rhb`) | `ModelPort` over `turtle/query`, node implementation, stdio test harness with the fork binary, view files of a folder by query, facts test (TriG document graphs, blank-node labels, open buffer, `files`) | – | Claude |
| K2 (`q74p`) | Shapes model: `shapesModelOf(port)` → `ShapesIndex` + vocabulary + `Classes` (SHACL and RDFS providers over rows); oracle = `shapesIndexOf` and `authoringMetamodel` on the fixtures | K1 | Claude |
| K3 (`1sx9`) | View doc: `viewDocOf(port, viewIri, shapes)` → `Doc` (readView rewritten); `viewLabels`; oracle = `readView` | K2 | Claude |
| K4 (`af1j`) | Notation figures: `viewFiguresOf(port, viewIri, shapes)` over a `TripleIndex` filled by one prefetch (view quads, shapes closure, neighbourhood of the placed terms to the depth of the notation paths); oracle = `viewFiguresOf` | K2 | Claude |
| K5 (`w1pm`) | Shape targets and hidden neighbours: `shapeTargetMatches(port, selection)` (the existing SPARQL moved to the server, no state), `hiddenNeighborCounts(port, …)`; oracle = the old functions | K2 | Claude |
| K6 (`8twe`) | Diagram cutover: `diagramOf(port, viewIri, opts)` async; GLSP session computes the schema before submit; `WorkspaceCore`/`WorkspaceModel` hold a port and a refresh generation, no graph; `diagnosticsOf` over the port; oracle test: every fixture view byte-identical to main | K3, K4, K5 | Claude |
| K7 (`dxwx`) | Pickers and choices over the port: `expandChoices`, `memberOptions`, `instancesNamed`, `shapeTargetChoices` (`scopedDoc` rewritten); `insertElement` and `pasteTurtle` facts; oracle = old choices | K6 | Claude or pi |
| K8 (`sef3`) | Ops over view quads and facts, part 1: `ops.ts` (placements, bounds, marks, collections, arrows, edge layouts) take `ViewQuads` + `Facts`; pure, synchronous, no graph; tests from fixture views with canned facts; oracle = `ViewStore` | K2 | Claude |
| K9 (`mydh`) | Ops part 2: `figure-edits.ts`, `clipboard.ts`, `commands.ts` dispatch, post-steps on the current view; the `Facts` prefetch query per command kind; oracle = `ViewStore` for the 19 kinds | K8, K4 | Claude |
| K10 (`v3y7`) | The text editor: `CustomTextEditorProvider`, async command executor (prefetch facts → ops → `viewText` → `WorkspaceEdit`), GLSP handlers on it, `new-view`, drop and paste; delete `ViewStore`, backups, `replaceView`, `keepOpenViews` | K6, K9 | Claude |
| K11 (`qhck`) | Delete the store: `rdf-core/graph.ts`, `rdf-files/*`, `graph-input.ts`, `nquads.ts`, `quads.ts`, old read and write modules, `fixture-graph.ts`, `graph.json`; `n3` for paste and notations; `oxigraph` out of `package.json` and the build scripts; `grep -rn oxigraph src test scripts package.json` finds nothing | K7, K10 | Claude or pi |
| K12 (`h3bm`) | Tree-sitter text patch: copy `text-patch.ts` + grammar, `web-tree-sitter` dependency; a command patches the text instead of rewriting the file; whole-file write is the fallback when the patcher gives no text | K10 | Claude |
| K13 (`thfz`) | Browser page: build the engine from the fork, `fetch-turtle-lsp.mjs` replaced by a local build step, `web/workspace.ts` port over `LspClient`, file edits of the `FileStore` sent as `didChange`, Oxigraph wasm gone from `build-web.mjs` | K11 | Claude |
| K14 (`401x`) | Documentation: `readme.md`, `CHANGELOG.md`, `AGENTS.md` rule "no model copy in Catenary"; push the fork branch and post the upstream issue (user) | K13 | pi |

Rounds: 1 = K1. 2 = K2, K8 in parallel. 3 = K3, K4, K5, K9 in parallel. 4 = K6, then K7 and K10 in parallel. 5 = K11, K12. 6 = K13, K14.

## Agent contract (short)

Work only in the worktree of the kata. Read AGENTS.md, then `kata show <id>`. Do the task as written. `pnpm verify` must pass with the expected count. Commit with the kata id first. Wait for the roborev job, apply findings inside the kata text, comment the others. Do not push. Close with `kata close <id> --done --commit <sha>`. Report facts: branch, commit, verify lines, roborev job, open items.
