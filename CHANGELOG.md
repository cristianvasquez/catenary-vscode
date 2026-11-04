# Changelog

## 0.0.4

- Requires turtle-lsp 0.14.0 or later (the `turtle/query` request). Catenary keeps no copy of the model: every question about the model is a `turtle/query` request.
- No model store: Oxigraph and the in-memory model graph are removed (`oxigraph` is no longer a dependency; `dist/` has no `node_bg.wasm`). Pasted Turtle and the built-in notations are parsed with `n3`.
- The canvas draws from `turtle/query`. A change of an open model document redraws the canvas before a save.
- The canvas is a text editor of the view `.trig` file: a canvas edit is one text edit of the file, and undo, redo, the unsaved state, save, revert and backup are VS Code's. A change of the file in a text editor redraws the canvas. TriG and Open in Canvas switch between the canvas and the text with no save, unsaved changes included. A paste of a cut from another view edits both view files (one undo step in each).
- Local SPARQL endpoint at `http://127.0.0.1:<port>/sparql` over the workspace through `turtle/query`: setting `catenary.sparql.port`, commands Start, Stop and Copy SPARQL Endpoint URL, a status bar item, and browser pages from the origins in `catenary.sparql.allowOrigins`. The default graph is the union of all files; there are no named graphs.
- Browser page: the engine is built from the turtle-lsp source (0.14.0 or later); the GitHub Pages workflow builds it from the tag `v0.14.0`. The page reads the model through `turtle/query` of that engine.

## 0.0.3

- A click on the red violation badge of a card shows the problem (hover text: "Show the problem: <message>").
- Insert: "Link to a file…" and "Link to a view…" act at once and open the file or view picker. In the browser page they have no check box, and linking works again (the picker closed without making the link).
- A view file is any `.trig` file with a `view:View`; the `.view.trig` ending is no longer required. New views are saved as `<name>.trig`. A `.trig` file without a view opens in the text editor.
- Browser page sample: flat file names (`data.ttl`, `shapes.ttl`, `cities.ttl`, `prefixes.ttl`, `model.trig`, `instances.trig`), and one SHACL error on purpose (Animal Farm).

## 0.0.2

- The Turtle RDF language server is no longer a hard dependency: Catenary offers to install it at first use, so the package installs on Open VSX editors too.
- Browser page: closing a text tab with unsaved changes asks first; a save that cannot reach browser storage is reported and the file stays marked unsaved.

## 0.0.1

- First release: canvas editor for `*.view.trig` files, model reading through the Turtle RDF language server, Markdown view embedding and export with SVG diagrams.
