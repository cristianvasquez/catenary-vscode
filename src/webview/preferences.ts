// Store canvas settings received from the host at startup and on configuration changes, and notify preference consumers.
import { Emitter } from '@eclipse-glsp/client';
import { injectable } from 'inversify';

/** The settings by full name (`catenary.edgeStyle`). A value that is not set is undefined: the reader uses its default. */
export type PreferenceValues = Record<string, unknown>;

@injectable()
export class CanvasPreferences {
    protected values: PreferenceValues = {};
    protected readonly changed = new Emitter<string[]>();
    /** Fires with the names whose value changed. */
    readonly onDidChange = this.changed.event;

    get<T>(name: string, fallback: T): T | unknown {
        return this.values[name] ?? fallback;
    }

    /** New values from the host: fires once with the changed names, if any. */
    update(values: PreferenceValues): void {
        const names = [...new Set([...Object.keys(this.values), ...Object.keys(values)])].filter(n => this.values[n] !== values[n]);
        this.values = { ...values };
        if (names.length) this.changed.fire(names);
    }
}
