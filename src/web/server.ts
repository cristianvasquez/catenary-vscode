// The GLSP server of the page: one server instance per canvas iframe, each over its own MessagePort, all bound to the workspace graph.
// Replaces the in-process NodeGlspVscodeServer of the extension host (node/glsp/server.ts).
import 'reflect-metadata';
import { JsonRpcGLSPServerLauncher, LogLevel, createAppModule } from '@eclipse-glsp/server/browser';
import { Container, injectable } from 'inversify';
import { BrowserMessageReader, BrowserMessageWriter, createMessageConnection } from 'vscode-jsonrpc/browser';
import { catenaryServerModule, sourceModule } from '../node/glsp/server-contribution';
import type { ViewSource } from '../node/glsp/view-session';

@injectable()
class PortServerLauncher extends JsonRpcGLSPServerLauncher<MessagePort> {
    protected run(port: MessagePort): void {
        this.connect(port);
    }

    /** One server instance for the canvas at the other end of `port`; the result stops it. */
    connect(port: MessagePort): () => void {
        const connection = createMessageConnection(new BrowserMessageReader(port), new BrowserMessageWriter(port));
        this.createServerInstance(connection); // configureClientConnection starts listening
        return () => {
            const instance = this.serverInstances.get(connection);
            if (instance) this.disposeServerInstance(instance);
            port.close();
        };
    }
}

export interface CanvasServer {
    /** Serves the canvas at the other end of `port`; the result stops the server instance of that canvas. */
    connect(port: MessagePort): () => void;
}

export function createCanvasServer(source: ViewSource): CanvasServer {
    const app = new Container();
    app.load(createAppModule({ logLevel: LogLevel.warn, consoleLog: true }));
    const launcher = app.resolve(PortServerLauncher);
    launcher.configure(catenaryServerModule(), sourceModule(source));
    return { connect: port => launcher.connect(port) };
}
