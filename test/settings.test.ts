import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, test } from 'vitest';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));

/** Read the host's literal list without loading its VS Code runtime dependencies. */
function canvasSettings(): string[] {
    const source = ts.createSourceFile('canvas-editor.ts', readFileSync('src/vscode/canvas-editor.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    const declarations = source.statements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations]);
    const initializer = declarations.find(d => ts.isIdentifier(d.name) && d.name.text === 'CANVAS_SETTINGS')?.initializer;
    if (!initializer || !ts.isArrayLiteralExpression(initializer)) throw new Error('CANVAS_SETTINGS must be a literal array');
    return initializer.elements.map(e => {
        if (!ts.isStringLiteral(e)) throw new Error('CANVAS_SETTINGS entries must be string literals');
        return `catenary.${e.text}`;
    });
}

/** Settings that the extension host reads; the canvas does not get them. */
const HOST_SETTINGS = ['catenary.sparql.port'];

test('configuration declares exactly the settings sent to the canvas plus the host settings, with types and defaults', () => {
    const properties = manifest.contributes.configuration.properties;
    expect(Object.keys(properties).sort()).toEqual([...canvasSettings(), ...HOST_SETTINGS].sort());
    expect(properties).toMatchObject({
        'catenary.cardFontSize': { type: 'number', default: 40 },
        'catenary.groupFontSize': { type: 'number', default: 47 },
        'catenary.noteFontSize': { type: 'number', default: 40 },
        'catenary.edgeStyle': { type: 'string', default: 'curved', enum: ['direct', 'curved'] },
        'catenary.vocabularyColor': { type: 'string', default: 'name', enum: ['name', 'prefix', 'off'] },
        'catenary.sparql.port': { type: 'integer', default: 0, minimum: 0, maximum: 65535 }
    });
});
