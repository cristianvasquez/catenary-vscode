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

## Agent contract (short)

One worktree per kata, branch `kata/<id>-<slug>`. Read AGENTS.md, `kata show <id>`, do the task as written, `pnpm verify`, commit with the kata id, wait for the roborev review, apply findings inside the kata text, comment the others, close with `--commit`. No push, no pull request.
