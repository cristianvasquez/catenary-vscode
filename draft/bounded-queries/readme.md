# Bounded queries: the reads say subject and predicate

Handoff document of the round. Updated when a kata closes or a decision changes.

## Intent

Every turtle/query that Catenary sends names what it asks for: a subject or object bound to a short list of IRIs, and the predicate when the read has one. A query is a text that a person can read and run by hand.

A blank node is not an address. It belongs to the IRI that reaches it. A query that reads a statement from an IRI brings the blank nodes under its object along, in the same answer. No query names a blank node, no query dumps every blank-node statement of the workspace, no query encodes a path to a blank node as a UNION branch.

## Why

The figure prefetch (`src/read/figures.ts`) walked from the placed terms 5 rounds outward, every predicate, both directions. On a workspace with the Publications Office file-type vocabulary, round 5 had 3,540 terms and 1,176 UNION branches for blank nodes: one query of 836 KB, 4.2 s on the server, for a view of 9 cards whose derivation reads a few dozen statements. Catenary v1 (`~/os/rdf/catenary/packages/rdf/src/notations.ts`) never had this: its engine read `store.match(s, p, o)` on demand, and blank nodes were skolem IRIs at load.

## Decisions

- Read strategy of the figures: rounds driven by the reads the engine misses. The engine is synchronous and stays so. It runs over an index; the reads it missed (`(term, predicate, direction)` or a whole predicate) are fetched with bounded queries; the index grows; repeat until nothing is missed.
- Blank nodes: fetched as the closure under the object of a read, to depth 4, lists walked with `rdf:rest*`. Never named across queries.
- A placement of a blank node (`view:element _:x`) is not supported: no figure, the join reports it. Catenary writes property shapes as IRIs; a figure of an anonymous property shape in a foreign file is drawn but cannot be placed by name.
- The turtle-lsp fork is not changed by this work. Its branch `turtle-query-request` (HEAD f46241c, the one going upstream) has no named graphs: `GRAPH` matches nothing, `files` is the only scope, blank nodes are labelled `g<n>` per request. Catenary-vscode follows.
- The file is the scope. No query uses `GRAPH`, `?g` or a graph IRI. A query that needs one document runs with `files: [file]`; a query that needs the document of a statement runs once per file, for IRI subjects only.
- Blank-node statements are read over the whole folder (no `files`), so their labels agree with every other whole-folder query. No label crosses two file sets.
- A placement of a blank node is not supported (round 1).
- Rule of the reads (the user's words): the only thing asked to the server is the data of the boxes and the relations between them; everything else is the view turtle. Catenary holds no copy of the model. The data of a view is the answer of the view's query, kept per view (`KeptPrefetch`); a reader is a function of the view text and that answer; a miss is fetched by the one loop of `prefetchFigures`.
- Target badges count the direct targets of a placed shape only (`sh:targetClass` with `rdfs:subClassOf*`, `sh:targetSubjectsOf`, `sh:targetObjectsOf`, `sh:targetNode`); the `sh:node` chain walk runs for the targets picker only (r49d).

## Open

- `showAsEdge` can still place a blank node implicitly (roborev on fyh4).
- The figure rounds read blank nodes over the whole folder while the view read uses `files: [viewFile]`: a blank node in a view file is not reachable from the figures (placements of blank nodes are unsupported, so no known case).

- Incoming reads on a blank list cell reached through the closure are marked covered although nothing above a blank node is fetched (roborev on 05rh). No fixture hits it. Needs a rule for incoming reads on blank nodes.
- Round 2: the other readers still name blank nodes by skolem IRI and branch on `FILTER (isBlank(?s))`: `src/read/targets.ts` `bindings()`, `src/read/view.ts` `BLANK_STATEMENTS`, `src/edit/facts-of.ts`, `src/read/scope.ts`, `src/read/choices.ts`, `src/vscode/paste-rdf.ts`. They do so because the shapes model (`src/read/shapes-index.ts`) addresses an anonymous property shape by its skolem IRI. The address of such a shape should be its holder statement `(owner, sh:property, n)`, as list figures already do with `listTerm`. Design before katas.

## Katas

| Kata | Scope | Depends on | State |
|---|---|---|---|
| 05rh | `src/read/figures.ts`: miss-driven rounds, closure queries, tests | none | merged (06d4284): 47 queries in 3 rounds, longest 1,857 bytes, 233 tests |
| bq0e | every query: `files` instead of `GRAPH`; per-file reads for IRI subjects; `ModelContext.views`; `viewFileProblem` from the text | 05rh | merged (bd71b48, roborev 2309 pass) |
| mcrr | `targets.ts`: a walk through blank nodes is one query from an IRI; `bindings()` without the isBlank clause; `neighbors.ts`: a blank neighbour's type and label in the same query | bq0e | merged (67a4aa3, roborev 2321 pass) |
| fyh4 | `view.ts`: no `BLANK_STATEMENTS`, a placed blank node of a model file is a warning; `facts-of.ts`: no `BLANK_QUERY`; a command that places a blank node is refused | bq0e | merged (fcc328b, roborev 2319 fail: `showAsEdge` can still place a blank node implicitly, noted in the kata) |

## Round 4 and 5 (merged)

| Kata | Scope | State |
|---|---|---|
| t5b2 | port sends maxRows 0; the server ceiling is the setting `turtle.query.maxRows` (default 1000; 0 = no limit), see readme | merged |
| dyx2 | one figure query per round: 519 to 77 queries over 17 views | merged |
| 4xc6 | targets: one query per level for all chains: 17,538 to 2,735 requests | merged |
| a62t | per-file reads become two queries by document kind: 1,715 to 347 | merged |
| 54k2 | kept prefetch per view: figures on a redraw 1 request | merged |
| d01g | view labels from the context, marks from the view's own file: a draw 21 to 41 requests | merged |
| g18q | two-phase draw: phase 1 from the view text and the kept index, 0 requests; phase 2 fills box data, never positions | merged |

Measured on EP-catenary-dprod (17 views, 37 files): setup plus 17 draws 17,538 requests and 34 s before round 4; 1,069 requests and 8 s after round 4; a draw 21 to 41 requests after d01g; a redraw after undo 0 requests after g18q.

Open after round 5: the vocabulary read at setup loads whole SKOS schemes (9,783 statements for file-type); read a value set's members only when a card needs them. The expand picker reads the view document before its two neighbour queries.

## Round 6 (merged)

| Kata | Scope | State |
|---|---|---|
| fwr7 | view-only commands send no request: view quads from the text, kept figures | merged (334a954): after a draw `collect` 0, `setBounds` 0, `createNote` 0, `addToView` 2 requests |
| 1nkh | expand pickers 'in'/'out': one neighbour query, no view read; `scope.ts` deleted | merged (a992e07): 'in'/'out' 1 request |
| a1rw | `viewDocOf` from the view text and the kept answer, no model query | merged: workspace 559 to 444 requests |
| r49d | neighbour counts from the kept answer; target badges as one COUNT query | merged (d4d0c82, 27ce9f0): cold draw 4 to 8 requests (before 16 to 34) |
| 5p5s | command facts from the kept answers plus one query for the uncovered named IRIs | merged (a259b5e) |

Measured on EP-catenary-dprod after round 6 (main a259b5e, maxRows 100000): setup plus 17 cold draws 192 requests (setup 100) and 4.1 s, before round 6 559 requests and 8.9 s; a cold draw 4 to 8 requests (before 22 to 42); a redraw with the kept answer 2 to 3 through `diagramOf` (view read plus badges), 1 to 2 from the view text (badges); redraw schema equal to the cold schema for all 17 views. `pnpm verify`: 27 files, 274 tests.

Open after round 6:

- No document provenance in the answer: a relation, or a type or label triple, present in both a shapes document and a data document is classed as shapes only, so the model side loses it (roborev 2341 on 1nkh, 2342 on a1rw, 2345 on r49d; 2348 on 5p5s is fixed by q9jg in round 7). The fork's turtle/query has no named graphs. Exact fix: per-kind reads (one more request per round, shapes files and data files) or a fork feature that reports the file of a row. Decision for the user.
- The vocabulary read at setup still loads whole SKOS schemes; on a large workspace the server setting `turtle.query.maxRows` must be raised (0 = no limit) or the answer is truncated.
- The largest request is the target badge COUNT query: 96,840 characters for urn:name:unnamed%20view%201-5 (VALUES of shape, kind, target and the `NOT IN` list of placed IRIs).

## Round 7 (merged)

| Kata | Scope | State |
|---|---|---|
| q9jg | `facts-of.ts`: the type and label of a shape-subject object of a shape subject's model statement are read by document kind, `exact` rows; regression test | merged (c90290f, roborev 2351 pass): fixture `addToView` 2, `showAsEdge` 1 requests; one more request when such an object exists |
| vjva | `test/server.ts`: after `stop()` a request rejects, `open`/`change` are no-ops, a notification rejection is handled | merged (394c760, roborev 2352 pass): the EPIPE did not reproduce in 20 runs before or after, so the guard is not a confirmed root-cause fix |

`pnpm verify` on main 34a0dba: 27 files, 275 tests.

## Agent contract (short)

One worktree per kata, branch `kata/<id>-<slug>`. Read AGENTS.md, `kata show <id>`, do the task as written, `pnpm verify`, commit with the kata id, wait for the roborev review, apply findings inside the kata text, comment the others, close with `--commit`. No push, no pull request.
