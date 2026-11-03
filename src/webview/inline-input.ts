// Add existing instances to entity groups with an embedded input; adapted from Catenary modeler/src/browser/diagram/inline-input.ts.
// Enter, Tab or blur commits; Escape cancels. A datalist supplies existing member labels.

let open: HTMLInputElement | undefined;

export function inlineInput(o: {
    inside: Element; placeholder: string; options: Promise<string[]>;
    onCommit: (text: string, how: 'enter' | 'tab' | 'blur') => void;
}): void {
    open?.remove();
    const input = document.createElement('input');
    input.className = 'catenary-embedded-input theia-input';
    input.placeholder = o.placeholder;
    const original = [...o.inside.childNodes];
    void o.options.then(options => {
        if (!options.length || !input.isConnected) return;
        const list = document.createElement('datalist');
        list.id = 'catenary-inline-options';
        document.getElementById(list.id)?.remove();
        for (const v of options) list.appendChild(Object.assign(document.createElement('option'), { value: v }));
        document.body.appendChild(list);
        input.setAttribute('list', list.id);
    }, () => undefined);
    let done = false;
    const close = (commit: boolean, how: 'enter' | 'tab' | 'blur' = 'blur') => {
        if (done) return;
        done = true;
        const text = input.value;
        input.remove();
        if (o.inside.isConnected) o.inside.replaceChildren(...original);
        document.getElementById('catenary-inline-options')?.remove();
        if (open === input) open = undefined;
        if (commit && text.trim()) o.onCommit(text, how);
    };
    input.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') close(true, 'enter');
        if (e.key === 'Tab') { e.preventDefault(); close(true, 'tab'); }
        if (e.key === 'Escape') close(false);
    });
    input.addEventListener('blur', () => close(true));
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'keyup', 'keypress']) input.addEventListener(type, e => e.stopPropagation());
    o.inside.replaceChildren(input);
    open = input;
    input.focus();
    input.select();
}
