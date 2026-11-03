// Type the turtle-lsp API and request turtle/graph from its running language client without importing VS Code.

const GRAPH_METHOD = 'turtle/graph'

/** The language client surface used here (vscode-languageclient LanguageClient). */
interface GraphClient {
  isRunning(): boolean
  sendRequest<R>(method: string, params: unknown): Promise<R>
}

/** What turtle-lsp 0.13.0 `activate()` returns (`TurtleApi` in its `editors/vscode/src/extension.ts`). */
export interface TurtleApi {
  /** `undefined` until the server starts. */
  client(): GraphClient | undefined
  /** Settles when every start, restart and stop asked so far has finished. */
  idle(): Promise<void>
}

/** Params of `turtle/graph`; every field is optional. */
export interface GraphParams {
  /** Document URIs; omitted: every workspace document. */
  files?: string[]
  literals?: boolean
  /** rdf:type edges. */
  types?: boolean
  /** Default 2000, max 20000. */
  maxNodes?: number
}

/** Sends `turtle/graph`. Throws a plain Error when the client is not running. */
export async function requestGraph(api: TurtleApi, params: GraphParams): Promise<GraphResult> {
  await api.idle()
  const client = api.client()
  if (!client?.isRunning()) throw new Error('the Turtle language server is not running')
  return client.sendRequest<GraphResult>(GRAPH_METHOD, params)
}

interface Position {
  line: number
  character: number
}

export interface GraphNode {
  id: string
  label?: string
  name: string
  kind: string
  uri: string
  range: { start: Position; end: Position }
  literal: boolean
}

interface GraphEdge {
  /** Index into `nodes`. */
  source: number
  /** Index into `nodes`. */
  target: number
  predicate: string
  name: string
  uri: string
}

export interface GraphResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** x, y per node, in node order. */
  positions: number[]
  total: { nodes: number; edges: number }
  facets: unknown
}
