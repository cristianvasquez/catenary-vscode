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

## Known limitations found in the round

- A SPARQL query cannot name a blank node. Every lookup by IRI (`VALUES`) of a model blank node needs a second query with `FILTER(isBlank(…))` matched in code by the port's skolem label. K3, K4, K5 and K9 each do this. Open: a list under a placed blank-node root longer than the figure prefetch depth (5) is cut off (K4, roborev 2266); a declared target that is a blank node does not match (K5). The clean fix is in the fork: a `turtle/query` parameter that binds blank nodes by their `<document>:<n>` label.
- The blank-node label `<document>:<n>` numbers the documents in URI order. Adding a document can renumber the others, so a view that places a model blank node by its skolem IRI can lose it after a file is added (K3 found the label change when a document was opened). A stable label in the fork (hash of the document URI) would fix it.
- A model resource named in a legacy `osg://vocab/` namespace is queried by its published IRI and not found (K3, roborev 2267). Only legacy vocabulary terms are affected.
- `test/fixtures/shapes/graph.json` (the recorded turtle/graph answer of the old pipeline) is stale against `data.ttl`. K11 deletes it.
- Decision 6 changed these ops to this-view-only (K8): mark statements, `view:arrow`, `view:member`, `placeConnectors`, `pruneArrows`, `createArrow`, `elementIdOf`, `markIri`, `ownedBy`; `uncollect` releases members in IRI order.

## State on 2026-11-03 evening

Merged on main: K1 `1rhb`, K2 `q74p`, K3 `1sx9`, K4 `af1j`, K5 `w1pm`, K6 `8twe`, K7 `dxwx`, K8 `sef3`, K9 `mydh`, K10 `v3y7`, K11 `qhck`, K12 `h3bm`. The store is gone: `grep -rn "oxigraph\|ModelGraph\|QuadStore\|graphOf\b" src test scripts package.json` finds nothing. 230 tests against the fork binary. The extension builds. The canvas reads through `turtle/query` and edits the view file with the tree-sitter patcher, undo is VS Code's.

Running at the end of the session: K13 `thfz` (browser page, worktree `wt-thfz` in the session scratchpad, branch `kata/thfz-web`). When it closes: merge, `pnpm install`, verify, remove the worktree, then K14 `401x`. The user's VS Code settings got `turtle.server.path` = the fork binary (backup `settings.json.bak-before-turtle-fork`).

## The round is functionally done and unusably slow: diagnosis

Measured on `/home/cvasquez/doing/EP-catenary-dprod` (37 RDF files, 20k triples, 17 views), with the harness copy in `perf-harness.ts.txt` (put it back as `test/_perf.test.ts` to run it) and with timing lines in the Catenary output channel (not committed). Facts:

- turtle-lsp is not the problem. Every query answers in milliseconds, also right after a `didChange`. The model context is 27 queries, 700 ms; a draw of a small view is 21 queries, 170 ms; a move is 12 queries, 110 ms.
- One query shape is 4 to 8 s: the notation-figures prefetch of K4 (`src/read/figures.ts` `prefetchFigures`). It walks 5 hops from the placed terms in both directions with no predicate bound; on the view `urn:name:dprod-datasets` (9 cards, file `views/sources/EP-portal-datasets.view.trig`) the frontier reaches 3,540 terms and the query text is 836 KB with 1,176 `UNION` branches, one pair per blank node reached (the `isBlank` anchor workaround). Catenary v1 reads figures lazily: only the statements a notation role path asks for, from a placed term along that path's predicate and direction (`packages/rdf/src/notations.ts` `storeInput`, `LazyTripleIndex`).
- One change causes 5 to 7 full draws of every open canvas: `WorkspaceCore.execute` fires, then the document change event fires again (`viewChanged`, 100 ms), each fire makes every session draw from scratch (hidden tabs included), plus the command's own draw. Nothing is kept per session. The user saw 21 s for "Show all 3" and 10 s for an undo on that view: one 4 s command plus six 5 s draws.
- The blank-node workaround is everywhere (K3, K4, K5, K7, K9: a second query with `FILTER(isBlank(…))` matched in code by label) because this handoff did not carry the v1 rule (Catenary `AGENTS.md` "No blank nodes": the read skolemizes every blank node immediately, every node is an IRI, no code handles blank nodes).

The history that applies, from the sessions of 2026-10-09 to 11 on Catenary v1 (agentsview project `catenary`, session `06a5abc9-5a4f-471d-8e53-6adc8e350bfd`, messages 1, 82, 90, 104, 136, 248): the same lag came from "no component keeps a read model, request-scoped reads" (ADR 0012), the user called it limiting, and the fix (commit a674342 "Keep the view model of a canvas across changes", kata 8v6d) made a move 0.1 to 0.3 ms: a session keeps the read model of its view; a view-graph change applies to it in place with no read; a data change re-reads only the shown elements; a shapes change or a reload re-reads fully; a hidden canvas marks a refresh due and refreshes when shown; one tested law: after any change the kept model equals a fresh read. A kept read model of one view is not a copy of the model and does not break the intent of this round.

## Next round (not created yet; decision F0 open with the user)

- F0 (fork): `turtle/query` returns every blank node as a skolem IRI, stable per document and label (the `<document>:<n>` labels exist), and accepts those IRIs in queries. Then delete every `isBlank` branch in `src/read/*.ts` and `src/edit/facts-of.ts`. The user asked why blank nodes matter at all; the answer is that they do not, and the rule belongs in the server.
- F1: bound the figures prefetch to the predicates and directions of the loaded notation role paths, as `LazyTripleIndex` did; target `dprod-datasets` draw under 500 ms in the harness; the K4 oracle tests stay.
- F2: kept session model with the v1 tiers: a command updates the kept view quads, `Doc`, prefetch and schema in memory and its own text edit (known `version`) does not trigger a re-read; an outside text change (undo, text editor) re-reads the view quads only, one query; a model change invalidates. Oracle test: kept equals fresh after each command and after an undo.
- F3: one draw per canvas per change: coalesce the two fires, no draw while one is in flight for that session (one more after, if due), hidden webviews (`webviewPanel.visible`) mark due and draw when shown.
- F4: on a model change recompute the shapes model only when a shapes file changed; a view redraws from the kept model with new facts for its shown elements only. `requestGraph` (turtle/graph, 9 MB) still runs on every refresh for the diagnostic ranges: replace.

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
