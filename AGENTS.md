# catenary-vscode: agent rules

Catenary holds no copy of the model: every model read is a `turtle/query`; a view edit is a text edit of the view file; no quad store dependency.

Check: `grep -rn "oxigraph\|ModelGraph\|QuadStore\|graphOf\b" src test scripts package.json` finds nothing.
