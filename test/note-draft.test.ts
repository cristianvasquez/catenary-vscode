// The commit of the note editor (src/webview/note-editor.ts) without the DOM and without the GLSP client (mocked: it needs a browser).
import 'reflect-metadata';
import { expect, test, vi } from 'vitest';
import { NoteDraft } from '../src/webview/note-editor';

vi.mock('../src/webview/model-client', () => ({ ModelFrontend: class {} }));
vi.mock('../src/webview/view-editors', () => ({ CanvasWidget: class {}, ViewEditors: class {}, viewIdOf: () => '' }));
vi.mock('../src/webview/card-chrome', () => ({ colorValue: () => undefined }));

/** A NoteDraft whose execute answers `result`; records the errors shown and whether the editor was removed. */
function draft(result: { ok: true } | { ok: false; error: string }) {
    const shown: string[] = [], sent: unknown[] = [];
    let disposed = false;
    const d = new NoteDraft({
        view: 'v', id: 'n', original: 'old', draft: () => 'new', exists: async () => true,
        execute: async c => { sent.push(c); return result; }, showError: t => { shown.push(t); }, dispose: () => { disposed = true; }
    });
    return { d, shown, sent, disposed: () => disposed };
}

test('a refused note commit keeps the editor open with the error (the draft stays)', async () => {
    const t = draft({ ok: false, error: 'The note text changed.' });
    expect(await t.d.commit()).toBe(false);
    expect(t.disposed()).toBe(false);
    expect(t.shown.at(-1)).toBe('The note text changed.');
    expect(t.sent).toEqual([{ kind: 'setViewElements', view: 'v', ids: ['n'], patch: { text: 'new' }, expectedText: 'old' }]);
});

test('an accepted note commit closes the editor', async () => {
    const t = draft({ ok: true });
    expect(await t.d.commit()).toBe(true);
    expect(t.disposed()).toBe(true);
});
