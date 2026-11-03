// Render untrusted note Markdown with markdown-it, without HTML or images; canvas note content has pointer events disabled.
// HTTP and HTTPS are the only permitted link schemes.
import { injectable } from 'inversify';
import MarkdownIt from 'markdown-it';

/** The rendered note: its element, and a dispose that removes it (the Theia MarkdownRenderResult). */
export interface MarkdownRenderResult {
    readonly element: HTMLElement;
    dispose(): void;
}

@injectable()
export class NoteMarkdown {
    protected readonly md = new MarkdownIt({ html: false, linkify: false }).disable(['image']);

    constructor() {
        const validate = this.md.validateLink.bind(this.md);
        this.md.validateLink = url => validate(url) && /^https?:\/\//i.test(url);
    }

    render(text: string): MarkdownRenderResult {
        const element = document.createElement('div');
        element.classList.add('catenary-markdown');
        element.innerHTML = this.md.render(text);
        return { element, dispose: () => element.remove() };
    }
}
