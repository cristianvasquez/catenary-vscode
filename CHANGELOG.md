# Changelog

## Unreleased

- Local SPARQL endpoint at `http://127.0.0.1:<port>/sparql` over the workspace through the Turtle language server `turtle/query` request: setting `catenary.sparql.port`, commands Start, Stop and Copy SPARQL Endpoint URL, a status bar item, and browser pages from the origins in `catenary.sparql.allowOrigins`.
- The canvas draws from `turtle/query` of the Turtle language server (fork `cristianvasquez/turtle-lsp`, branch `turtle-query`): no model copy for the drawing. A change of an open model document redraws the canvas before a save.
- The canvas is a text editor of the view `.trig` file: a canvas edit is one text edit of the file, and undo, redo, the unsaved state, save, revert and backup are VS Code's. A change of the file in a text editor redraws the canvas. The canvas and the text editor switch without a save. A paste of a cut from another view edits both view files (one undo step in each). Until the engine of the browser page answers `turtle/query`, its canvas is read-only.
- No model store: Oxigraph and the in-memory model graph are removed (`oxigraph` is no longer a dependency; `dist/` has no `node_bg.wasm`). Every question about the model is a `turtle/query` request, so the fork of turtle-lsp (`turtle.server.path`) is required. Pasted Turtle and the built-in notations are parsed with `n3`.
- Browser page: its engine has no `turtle/query` yet, and its port fails with "needs the fork engine": the page reads no model and its canvas draws nothing until the engine is built from the fork. Insert Element shows that message.

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
