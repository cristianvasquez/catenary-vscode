// Node globals that the shared code uses, for the web build. Imported first by web/main.ts.
const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.setImmediate !== 'function') g.setImmediate = (f: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(() => f(...args), 0);
