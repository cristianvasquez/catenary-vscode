// Edit note Markdown in a local draft; adapted from catenary-vscode extension/src/webview/canvas/note-editor.ts.
// Ctrl+Enter or an outside press commits, Escape cancels; unchanged drafts send no edit and refused edits stay open.

import { inject, injectable } from 'inversify';
import type { ViewCommand } from '../catenary/model/commands';
import { colorValue } from './card-chrome';
import { ModelFrontend } from './model-client';
import { CanvasWidget, ViewEditors, viewIdOf } from './view-editors';

/** The command of a note commit: undefined when the draft is the text that the editor opened with. */
function noteCommit(view: string, note: string, original: string, draft: string): ViewCommand | undefined {
    return draft === original ? undefined : { kind: 'setViewElements', view, ids: [note], patch: { text: draft }, expectedText: original };
}

/** What a key does in the note editor: Escape cancels, Ctrl+Enter commits; other keys edit the draft (Enter: a newline). */
function noteKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey'>): 'cancel' | 'commit' | undefined {
    if (e.key === 'Escape') return 'cancel';
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) return 'commit';
    return undefined;
}

/**
 * The commit and cancel of one open note editor, without the DOM. `commit` (Ctrl+Enter, a press outside): an unchanged draft closes;
 * a changed draft sends its command when the note is still there, and closes when the store accepts it; else the editor stays open
 * with the error. `cancel` (Escape): the editor closes and sends nothing, also while a commit waits for the backend
 * (Escape never commits). True from `commit`: the editor closed.
 */
export class NoteDraft {
    protected closing = false;
    protected closed = false;

    constructor(protected readonly o: {
        view: string; id: string; original: string;
        draft(): string;
        /** The note is still a note of the view. */
        exists(): Promise<boolean>;
        execute(command: ViewCommand): Promise<{ ok: true } | { ok: false; error: string }>;
        showError(text: string): void;
        /** Remove the editor. */
        dispose(): void;
    }) {}

    get isClosed(): boolean { return this.closed; }

    cancel(): void {
        if (this.closed) return;
        this.closed = true;
        this.o.dispose();
    }

    async commit(): Promise<boolean> {
        if (this.closing || this.closed) return this.closed;
        this.closing = true;
        this.o.showError('');
        try {
            const command = noteCommit(this.o.view, this.o.id, this.o.original, this.o.draft());
            if (command) {
                const exists = await this.o.exists();
                if (this.closed) return true;
                if (!exists) { this.o.showError('The note is gone. Copy your draft before you close the editor.'); return false; }
                const result = await this.o.execute(command);
                if (!result.ok) { if (!this.closed) this.o.showError(result.error); return this.closed; }
            }
            if (!this.closed) { this.closed = true; this.o.dispose(); }
            return true;
        } catch (e) {
            if (!this.closed) this.o.showError(e instanceof Error ? e.message : String(e));
            return this.closed;
        } finally {
            this.closing = false;
        }
    }
}

@injectable()
export class NoteEditor {
    @inject(ModelFrontend) protected readonly model!: ModelFrontend;
    @inject(CanvasWidget) protected readonly widget!: CanvasWidget;
    @inject(ViewEditors) protected readonly editors!: ViewEditors;
    protected active?: { node: HTMLElement; close: () => Promise<void> };

    /** The note `id` as the diagram of the canvas draws it (type, text, color). */
    protected noteOf(id: string): { text: string; color?: string } | undefined {
        const note = this.editors.diagram(this.widget)?.get(this.editors.placementOf(this.widget, id));
        return note?.type === 'node:note' ? { text: String(note.text ?? ''), color: note.color as string | undefined } : undefined;
    }

    /** Open the editor of the note `id` (a box id of the view). With an editor open: focus it. */
    async open(id: string): Promise<void> {
        if (this.active) {
            if (this.active.node.isConnected) this.active.node.querySelector('textarea')?.focus();
            return;
        }
        const view = viewIdOf(this.widget);
        const note = this.noteOf(id);
        if (!note) return;
        const original = note.text;
        const host = document.createElement('div');
        host.className = 'catenary-note-popover';
        const color = colorValue(note.color);
        if (color) host.style.setProperty('--c', color);
        host.setAttribute('role', 'dialog');
        host.setAttribute('aria-label', 'Edit note Markdown');
        const field = document.createElement('textarea');
        field.className = 'catenary-note-source';
        field.value = original;
        field.setAttribute('aria-label', 'Note Markdown source');
        field.spellcheck = false;
        const error = document.createElement('div');
        error.className = 'catenary-note-error';
        error.setAttribute('role', 'alert');
        host.append(field, error);
        document.body.appendChild(host);
        const rect = document.getElementById(`${this.widget.viewerOptions.baseDiv}_${this.editors.placementOf(this.widget, id)}`)?.getBoundingClientRect();
        if (rect) {
            const width = Math.min(Math.max(160, rect.width - 16), window.innerWidth - 24);
            const height = Math.min(Math.max(80, rect.height - 16), window.innerHeight - 24);
            host.style.width = `${width}px`;
            host.style.height = `${height}px`;
            host.style.left = `${Math.max(12, Math.min(rect.left + 8, window.innerWidth - width - 12))}px`;
            host.style.top = `${Math.max(12, Math.min(rect.top + 8, window.innerHeight - height - 12))}px`;
        } else {
            const width = Math.min(440, window.innerWidth - 24);
            host.style.width = `${width}px`;
            host.style.left = `${Math.max(12, (window.innerWidth - width) / 2)}px`;
            host.style.top = `${Math.max(12, Math.min(window.innerHeight / 3, window.innerHeight - 320))}px`;
            field.style.flex = 'none';
            field.style.height = '260px';
        }

        let disposed = false;
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            document.removeEventListener('pointerdown', outside, true);
            host.remove();
            this.active = undefined;
            document.getElementById(this.widget.viewerOptions.baseDiv)?.querySelector<SVGSVGElement>('svg.sprotty-graph')?.focus();
        };
        const draft = new NoteDraft({
            view, id, original, draft: () => field.value,
            exists: async () => !!this.noteOf(id),
            execute: command => this.model.executeChecked(command),
            showError: text => { error.textContent = text; },
            dispose
        });
        const close = async () => { await draft.commit(); };
        this.active = { node: host, close };
        const outside = (event: PointerEvent) => { if (!host.contains(event.target as Node)) void close(); };
        // The keys of the draft stay in the field: the canvas does not see them (undo and redo of the field, Enter: a newline).
        field.addEventListener('keydown', event => {
            event.stopPropagation();
            const key = noteKey(event);
            if (!key) return;
            event.preventDefault();
            if (key === 'cancel') draft.cancel();
            else void close();
        });
        for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'keyup', 'keypress', 'copy', 'cut', 'paste']) host.addEventListener(type, e => e.stopPropagation());
        document.addEventListener('pointerdown', outside, true);
        field.focus();
    }
}
