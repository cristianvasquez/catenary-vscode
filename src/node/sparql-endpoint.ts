// SPARQL 1.1 Protocol front end (query operation only) over a query function, with node:http. No VS Code imports.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** A term in SPARQL 1.1 Query Results JSON form; `triple` is the RDF 1.2 triple term. */
export type JsonTerm =
  | { type: 'uri' | 'bnode'; value: string }
  | { type: 'literal'; value: string; 'xml:lang'?: string; datatype?: string }
  | { type: 'triple'; value: JsonTriple }

export interface JsonTriple { subject: JsonTerm; predicate: JsonTerm; object: JsonTerm }

/** The answer of the turtle-lsp `turtle/query` request. */
export type QueryAnswer =
  | { kind: 'select'; head: { vars: string[] }; results: { bindings: Record<string, JsonTerm>[] }; omitted: number; elapsedMs: number }
  | { kind: 'ask'; head: Record<string, never>; boolean: boolean; elapsedMs: number }
  | { kind: 'construct'; triples: JsonTriple[]; omitted: number; elapsedMs: number }

/** Runs one query. Rejects with `{ code: -32602 | -32803, message }` (JSON-RPC InvalidParams or RequestFailed). */
export type QueryFn = (query: string) => Promise<QueryAnswer>

export interface SparqlEndpoint { url: string; port: number; close(): Promise<void> }

const PATH = '/sparql'
const MAX_BODY = 1024 * 1024
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string'
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString'

const JSON_RESULTS = 'application/sparql-results+json'
const FORMATS: Record<QueryAnswer['kind'], string[]> = {
  select: [JSON_RESULTS, 'application/json', 'text/csv', 'text/tab-separated-values'],
  ask: [JSON_RESULTS, 'application/json', 'text/csv', 'text/tab-separated-values'],
  construct: ['application/n-triples', 'text/turtle', 'text/plain', 'application/json'],
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) { super(message) }
}

/** Starts the endpoint; `port` 0 lets the OS pick one. */
export function startSparqlEndpoint(query: QueryFn, options: { port: number; host?: string; log?: (line: string) => void }): Promise<SparqlEndpoint> {
  const host = options.host ?? '127.0.0.1'
  let url = ''
  const server = createServer((req, res) => {
    const start = Date.now()
    const path = (req.url ?? '/').split('?')[0]
    res.on('finish', () => options.log?.(`${req.method} ${path} ${res.statusCode} ${Date.now() - start}ms`))
    res.setHeader('Access-Control-Allow-Origin', '*')
    handle(req, res, path, query, url).catch(err => {
      if (res.headersSent) { res.destroy(); return }
      const e = err instanceof HttpError ? err : new HttpError(500, messageOf(err))
      send(res, e.status, 'text/plain; charset=utf-8', `${e.message}\n`, e.headers)
      if (e.status === 413) req.resume()
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, host, () => {
      server.off('error', reject)
      const port = (server.address() as AddressInfo).port
      url = `http://${urlHost(host)}:${port}${PATH}`
      resolve({
        url, port,
        close: () => new Promise<void>((done, fail) => {
          server.close(err => err ? fail(err) : done())
          server.closeAllConnections()
        }),
      })
    })
  })
}

function urlHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '') return '127.0.0.1'
  return host.includes(':') ? `[${host}]` : host
}

async function handle(req: IncomingMessage, res: ServerResponse, path: string, query: QueryFn, url: string): Promise<void> {
  if (path !== '/' && path !== PATH) throw new HttpError(404, `Not found: ${path}. The endpoint is ${url}`)
  if (path === PATH && req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, Accept' })
    res.end()
    return
  }
  if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, `Method not allowed: ${req.method}`, { Allow: 'GET, POST' })
  if (path === '/') {
    if (req.method !== 'GET') throw new HttpError(405, `Method not allowed: ${req.method}`, { Allow: 'GET' })
    send(res, 200, 'text/plain; charset=utf-8', `SPARQL endpoint at ${url} (GET ?query= or POST). SELECT and ASK: ${FORMATS.select.join(', ')}. CONSTRUCT and DESCRIBE: ${FORMATS.construct.join(', ')}.\n`)
    return
  }
  const text = await queryOf(req)
  if (!text) throw new HttpError(400, 'No query. Give a "query" parameter, or POST the query as application/sparql-query.')
  let answer: QueryAnswer
  try {
    answer = await query(text)
  } catch (err) {
    const code = (err as { code?: unknown } | undefined)?.code
    throw new HttpError(code === -32602 ? 400 : code === -32803 ? 503 : 500, messageOf(err))
  }
  const type = negotiate(req.headers.accept, FORMATS[answer.kind])
  if (!type) throw new HttpError(406, `Not acceptable: ${req.headers.accept}. This ${answer.kind} result is available as ${FORMATS[answer.kind].join(', ')}.`)
  send(res, 200, `${type}; charset=utf-8`, serialize(answer, type))
}

function messageOf(err: unknown): string {
  if (typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string') return (err as { message: string }).message
  return typeof err === 'string' ? err : 'Internal error'
}

function send(res: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...headers, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

async function queryOf(req: IncomingMessage): Promise<string | undefined> {
  const params = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
  if (req.method === 'GET') return params.get('query') ?? undefined
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  const body = await readBody(req)
  if (type === 'application/x-www-form-urlencoded') return new URLSearchParams(body).get('query') ?? undefined
  if (type === 'application/sparql-query') return body
  throw new HttpError(400, `Unsupported Content-Type: ${type || '(none)'}. Use application/x-www-form-urlencoded or application/sparql-query.`)
}

function readBody(req: IncomingMessage): Promise<string> {
  const tooLarge = () => new HttpError(413, `Body over ${MAX_BODY} bytes`, { Connection: 'close' })
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return Promise.reject(tooLarge())
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on('data', (chunk: Buffer) => {
      if (failed) return
      size += chunk.length
      if (size > MAX_BODY) { failed = true; chunks.length = 0; reject(tooLarge()); return }
      chunks.push(chunk)
    })
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

/**
 * The supported type that the Accept header admits with the highest q. A type takes the q of its most specific
 * matching range, so `q=0` excludes it. Ties go to the range that comes first, then to the default order.
 * No Accept gives the default.
 */
function negotiate(accept: string | undefined, supported: string[]): string | undefined {
  if (!accept || !accept.trim()) return supported[0]
  const ranges = accept.split(',').map((part, i) => {
    const [range, ...params] = part.split(';').map(s => s.trim().toLowerCase())
    const q = params.find(p => p.startsWith('q='))
    return { range, q: q ? Number(q.slice(2)) : 1, i }
  }).filter(r => r.range && !Number.isNaN(r.q))
  const specificity = (range: string, type: string) =>
    range === type ? 3 : range.endsWith('/*') && range !== '*/*' && type.startsWith(range.slice(0, -1)) ? 2 : range === '*/*' ? 1 : 0
  let best: { type: string; q: number; i: number } | undefined
  for (const type of supported) {
    let match: { s: number; q: number; i: number } | undefined
    for (const r of ranges) {
      const s = specificity(r.range, type)
      if (s > (match?.s ?? 0)) match = { s, q: r.q, i: r.i }
    }
    if (!match || match.q <= 0) continue
    if (!best || match.q > best.q || (match.q === best.q && match.i < best.i)) best = { type, q: match.q, i: match.i }
  }
  return best?.type
}

function serialize(answer: QueryAnswer, type: string): string {
  if (answer.kind === 'select') {
    if (type === 'text/csv') return csvSelect(answer.head.vars, answer.results.bindings)
    if (type === 'text/tab-separated-values') return tsvSelect(answer.head.vars, answer.results.bindings)
    return JSON.stringify({ head: answer.head, results: answer.results })
  }
  if (answer.kind === 'ask') {
    if (type === 'text/csv' || type === 'text/tab-separated-values') return `${answer.boolean}\n`
    return JSON.stringify({ head: {}, boolean: answer.boolean })
  }
  if (type === 'application/json') return JSON.stringify({ triples: answer.triples })
  return answer.triples.map(t => `${ntTriple(t)} .\n`).join('')
}

function csvSelect(vars: string[], bindings: Record<string, JsonTerm>[]): string {
  const field = (s: string) => /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  const lines = [vars.map(field), ...bindings.map(b => vars.map(v => b[v] ? field(csvValue(b[v])) : ''))]
  return lines.map(l => `${l.join(',')}\r\n`).join('')
}

function csvValue(term: JsonTerm): string {
  if (term.type === 'bnode') return `_:${term.value}`
  if (term.type === 'triple') return ntTerm(term)
  return term.value
}

function tsvSelect(vars: string[], bindings: Record<string, JsonTerm>[]): string {
  const lines = [vars.map(v => `?${v}`), ...bindings.map(b => vars.map(v => b[v] ? ntTerm(b[v], true) : ''))]
  return lines.map(l => `${l.join('\t')}\n`).join('')
}

function ntTriple(t: JsonTriple, tsv = false): string {
  return `${ntTerm(t.subject, tsv)} ${ntTerm(t.predicate, tsv)} ${ntTerm(t.object, tsv)}`
}

/** A term in N-Triples syntax; `tsv` also escapes tab, which a TSV field must not contain. */
function ntTerm(term: JsonTerm, tsv = false): string {
  switch (term.type) {
    case 'uri': return `<${ntIri(term.value)}>`
    case 'bnode': return `_:${term.value}`
    case 'triple': return `<<( ${ntTriple(term.value, tsv)} )>>`
    case 'literal': {
      const lexical = `"${ntString(term.value, tsv)}"`
      if (term['xml:lang']) return `${lexical}@${term['xml:lang']}`
      if (term.datatype && term.datatype !== XSD_STRING && term.datatype !== RDF_LANG_STRING) return `${lexical}^^<${ntIri(term.datatype)}>`
      return lexical
    }
  }
}

function ntString(s: string, tsv: boolean): string {
  return s.replace(tsv ? /[\\"\n\r\t]/g : /[\\"\n\r]/g, c => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' })[c]!)
}

/** Characters that IRIREF does not admit, written as UCHAR. */
function ntIri(s: string): string {
  return s.replace(/[\u0000- <>"{}|^`\\]/g, c => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
}
