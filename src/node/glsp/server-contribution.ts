// Bind GLSP server modules and report action errors in the extension host; adapted from Catenary modeler/src/node/glsp/server-contribution.ts.

import { ActionMessage, DefaultGLSPServer, GLSPServerError, MessageAction } from '@eclipse-glsp/server';
import { LogLevel, ServerModule, createAppModule } from '@eclipse-glsp/server/node';
import { ContainerModule, injectable } from 'inversify';
import { ViewDiagramModule } from './diagram-module';
import { ViewSource } from './view-session';

/** Characters of a failed action kept in the log. */
const MAX_ACTION = 2000;

/**
 * An error outside an edit (a handler bug, an unknown action): the GLSP error path. The default logs the
 * message and the reason on two lines and sends one error message. This server logs one line with the action and the stack, and
 * sends the same one message. An error of an edit never reaches this path: ViewSession.edit sends its warning itself.
 */
@injectable()
class LoggingGLSPServer extends DefaultGLSPServer {
    protected override handleProcessError(message: ActionMessage, reason: unknown): void {
        console.error(`[catenary] GLSP action "${message.action.kind}" failed (client ${message.clientId}): ${JSON.stringify(message.action).slice(0, MAX_ACTION)}\n`,
            reason instanceof Error ? reason.stack : reason);
        const cause = reason instanceof GLSPServerError ? reason.cause : reason;
        const errorMsg = reason instanceof GLSPServerError ? reason.message : `Could not process action: '${message.action.kind}'`;
        this.sendToClient({ clientId: message.clientId, action: MessageAction.create(errorMsg, { severity: 'ERROR', details: String(cause) }) });
    }
}

class CatenaryServerModule extends ServerModule {
    protected override bindGLSPServer() { return LoggingGLSPServer; }
}

/** The GLSP server module of the view diagram. */
export function catenaryServerModule(): ServerModule {
    return new CatenaryServerModule().configureDiagramModule(new ViewDiagramModule());
}

/** Binds the workspace graph that the sessions read. */
export function sourceModule(source: ViewSource): ContainerModule {
    return new ContainerModule(bind => { bind(ViewSource).toConstantValue(source); });
}

/** VS Code glue (catenary-vscode): replaces the Theia GLSPNodeServerContribution. */
export function serverModules(source: ViewSource): ContainerModule[] {
    return [createAppModule({ logLevel: LogLevel.warn, consoleLog: true, fileLog: false }), catenaryServerModule(), sourceModule(source)];
}
