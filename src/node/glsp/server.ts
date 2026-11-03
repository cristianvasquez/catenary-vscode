// One in-process GLSP server per workspace folder (from catenary-vscode src/vscode/canvas-server.ts), bound to its workspace graph.
import 'reflect-metadata';
import { NodeGlspVscodeServer } from '@eclipse-glsp/vscode-integration/lib/node/quickstart-components/node-glsp-vscode-server';
import { serverModules } from './server-contribution';
import type { ViewSource } from './view-session';

export function createCanvasServer(source: ViewSource): NodeGlspVscodeServer {
    return new NodeGlspVscodeServer({ clientId: 'catenary.glsp', clientName: 'catenary', serverModules: serverModules(source) });
}
