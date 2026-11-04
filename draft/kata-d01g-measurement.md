# d01g: view-file read measurement

## Changes

Cache view labels and descriptions in `ModelContext.viewLabels` at refresh. Pass that cache through diagram reads, choices, scoped reads, canvas labels and Markdown export. Re-read the drawn view's metadata from its file. Restrict marks, members and arrows to that file; reuse the members query within a read. Keep standalone callers without a context supported.

The regression test checks zero requests for cached labels, fresh metadata for the drawn view, stale-until-refresh labels for another view, no query of that other view file, and a warning with no box for a mark defined there. The recorded read-view and diagram fixtures have no changes. `pnpm verify` passes: 26 files, 239 tests, with the default fork binary and no `TURTLE_LSP` override.

## Method

Run the supplied scratchpad `measure.ts` before and after the code change, with imports redirected to this worktree, output under this worktree and the notation asset symlink pointing to this worktree's assets. Keep the workspace folder `/home/cvasquez/doing/EP-catenary-dprod`. Use `MEASURE_MAX_ROWS=100000` and the default release fork binary. Include 37 RDF documents and 20,516 union triples. Draw 17 views once each through `diagramOf`, after one model setup. These are cold draws without retained figure prefetch; counts exclude setup. Both runs completed without failed or omitted requests. The script's workspace RDF SHA-256 comparison reports unchanged in both runs.

## Requests per draw

View names below omit the common `urn:name:` prefix. Each draw saves 32 requests: 16 metadata requests and 16 mark requests. The workspace views did not issue arrow queries.

| View | Before | After |
|---|---:|---:|
| unnamed%20view%201-2 | 73 | 41 |
| MEP-voting-records-roles | 57 | 25 |
| MEP-voting-records | 55 | 23 |
| unnamed%20view%201-6 | 54 | 22 |
| dataset-mirror-roles | 57 | 25 |
| dataset-mirror-product | 54 | 22 |
| guide-mirror-product | 54 | 22 |
| guide-mirror-roles | 57 | 25 |
| guide-mirror-to-voting | 55 | 23 |
| additions | 61 | 29 |
| unnamed%20view%201-3 | 67 | 35 |
| unnamed%20view%201-5 | 67 | 35 |
| EP-portal-API | 56 | 24 |
| dprod-datasets | 56 | 24 |
| services | 53 | 21 |
| datasets | 56 | 24 |
| teams | 54 | 22 |
| Total draws | 986 | 442 |

## Open criterion

The target of at most 20 requests per draw remains unmet for 17 views. For `unnamed%20view%201-2`, the trace attributes 8 requests to the view reader, 29 to `hiddenNeighborCounts` including target matching, and 4 to figure prefetch. The 33 requests outside the view reader exceed the target without any view-reader requests. The kata excludes `neighbors.ts`, `targets.ts` and `figures.ts`; this change does not modify those modules. Completing the target needs a separate change or a scope decision.
