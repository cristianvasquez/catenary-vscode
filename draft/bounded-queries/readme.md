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
- The turtle-lsp fork is not changed.
- Scope of round 1: the figure read only.

## Open

- Round 2: the other readers still name blank nodes by skolem IRI and branch on `FILTER (isBlank(?s))`: `src/read/targets.ts` `bindings()`, `src/read/view.ts` `BLANK_STATEMENTS`, `src/edit/facts-of.ts`, `src/read/scope.ts`, `src/read/choices.ts`, `src/vscode/paste-rdf.ts`. They do so because the shapes model (`src/read/shapes-index.ts`) addresses an anonymous property shape by its skolem IRI. The address of such a shape should be its holder statement `(owner, sh:property, n)`, as list figures already do with `listTerm`. Design before katas.

## Katas

| Kata | Scope | Depends on | State |
|---|---|---|---|
| 05rh | `src/read/figures.ts`: miss-driven rounds, closure queries, tests | none | open |

## Agent contract (short)

One worktree per kata, branch `kata/<id>-<slug>`. Read AGENTS.md, `kata show <id>`, do the task as written, `pnpm verify`, commit with the kata id, wait for the roborev review, apply findings inside the kata text, comment the others, close with `--commit`. No push, no pull request.
