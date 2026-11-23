/**
 * A tiny read-only static file server for workspace pages.
 *
 * Why this exists at all: the panel cannot load `file://`. The main process only
 * allows `http:`/`https:` navigation (see `lib/main.js` `allowedNavigation`), so
 * a local HTML file has to be served over loopback to be seen at all.
 *
 * The rules here are deliberately narrow: one server per workspace root, bound
 * to 127.0.0.1 on a system-assigned port, GET/HEAD only, nothing outside the
 * root, and no directory listings — a miss is a 404 with plain text.
 *
 * A random port is not a secret, so every URL carries a per-process token:
 * `/t/<token>/<path>`. A document reached that way is redirected to its plain
 * path with an `HttpOnly` cookie, so subresource requests (which never carry a
 * query) still load while the token stays out of the final page URL.
 */
import { createReadStream } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'

/** Bigger than this and the panel would choke; the ticket says 413, not a hang. */
const MAX_BYTES = 32 * 1024 * 1024

/** How long `dispose()` waits for open connections before cutting them off. */
const CLOSE_TIMEOUT_MS = 2_000

/** Path segment in front of the token: `/t/<token>/<path>`. */
export const TOKEN_PREFIX = '/t/'

/** HttpOnly cookie that carries the token to subresource requests. */
export const TOKEN_COOKIE = 'ab'

/** Only types a page actually needs. Anything else is served as octet-stream. */
const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}))

/**
 * Turn a URL path into an absolute path inside `root`, or refuse.
 *
 * Kept separate from the request handler so the escape cases can be unit
 * tested without opening a socket. Everything that could leave the root —
 * `..`, encoded dots, a drive letter, a UNC prefix, a NUL — is refused here
 * rather than in the caller.
 * @param {string} root - absolute, already resolved workspace root.
 * @param {string} pathname - the raw (still percent-encoded) URL path.
 * @returns {{ path: string } | { error: 'bad_path' | 'path_escape' }}
 */
export function resolveWithin(root, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return { error: 'bad_path' }
  }
  if (decoded.includes('\0')) return { error: 'bad_path' }
  // Backslashes are path separators to Windows, so treat them as such before
  // deciding anything; `%5c` in a URL decodes to one.
  const slashed = decoded.replace(/\\/g, '/')
  if (/^[A-Za-z]:/.test(slashed)) return { error: 'path_escape' }
  if (slashed.startsWith('//')) return { error: 'path_escape' }
  const target = resolve(root, `.${slashed.startsWith('/') ? '' : '/'}${slashed}`)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) return { error: 'path_escape' }
  return { path: target }
}

/**
 * Resolve a `path` argument against a workspace root.
 *
 * Accepts a relative path or an absolute one that already sits inside the root;
 * everything else is refused with the ticket's `path_escape` code.
 * @param {string} root - absolute workspace root.
 * @param {string} input - the raw `path` argument.
 * @returns {string} the absolute target path.
 */
export function resolveWorkspacePath(root, input) {
  const raw = String(input ?? '').trim()
  if (raw === '') throw new Error('path_escape: path is empty')
  const asUrl = raw.split(/[?#]/)[0].replace(/\\/g, '/')
  // On Windows `path.isAbsolute('/demo/x')` is true (it means the drive root),
  // but callers write a leading slash meaning "from the workspace". Only a
  // drive letter or a UNC prefix really means "somewhere else on this machine".
  const foreign = /^[A-Za-z]:/.test(raw) || asUrl.startsWith('//')
  if (foreign) {
    const rel = relative(root, resolve(raw))
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return resolve(raw)
    throw new Error(`path_escape: ${raw} is outside the workspace (${root}); browser_open only serves files from the workspace`)
  }
  const got = resolveWithin(root, `/${asUrl.replace(/^\.?\/+/, '')}`)
  if ('error' in got) {
    throw new Error(`path_escape: ${raw} resolves outside the workspace (${root}); browser_open only serves files from the workspace`)
  }
  return got.path
}

/** Where a `path` argument ends up, as a URL on `origin`. */
export function urlForPath(origin, root, input, token) {
  const target = resolveWorkspacePath(root, input)
  const rel = relative(root, target).replace(/\\/g, '/')
  const encoded = rel.split('/').map((part) => encodeURIComponent(part)).join('/')
  return token === undefined || token === null || token === ''
    ? `${origin}/${encoded}`
    : `${origin}${TOKEN_PREFIX}${token}/${encoded}`
}

/** One server per workspace root, created on demand and reused afterwards. */
export class StaticSites {
  #logger
  #sites = new Map()
  #closing = false
  /** Per-file ceiling for a served asset. */
  #maxBytes = MAX_BYTES
  /** Per-process token every URL must carry; also set as a cookie on documents. */
  #token

  /**
   * @param {{ logger?: (message: string) => void, maxBytes?: number, token?: string }} [options]
   */
  constructor(options = {}) {
    this.#logger = options.logger ?? (() => {})
    this.#maxBytes = options.maxBytes ?? MAX_BYTES
    this.#token = options.token ?? randomBytes(32).toString('base64url')
  }

  /** Bearer-ish token for the static origin; the panel must carry it in the URL. */
  get token() {
    return this.#token
  }

  /**
   * The loopback origin serving `root`, starting a server the first time.
   * @param {string} root - absolute workspace root.
   * @returns {Promise<{ url: string, port: number, root: string, token: string }>}
   */
  async ensure(root) {
    const key = await fsp.realpath(root)
    const existing = this.#sites.get(key)
    if (existing !== undefined) return existing.info
    if (this.#closing) throw new Error('the static server is shutting down')
    const site = await this.#listen(key)
    this.#sites.set(key, site)
    this.#logger(`static server for ${key} on ${site.info.url}`)
    return site.info
  }

  /** Close every server. Called from the plugin's disposer. */
  async dispose() {
    this.#closing = true
    const sites = [...this.#sites.values()]
    this.#sites.clear()
    // `server.close()` waits for open connections, and a page being previewed can
    // hold one. Bound the wait so unloading the plugin never hangs.
    await Promise.all(sites.map((site) => new Promise((done) => {
      const timer = setTimeout(() => {
        site.server.closeAllConnections?.()
        done()
      }, CLOSE_TIMEOUT_MS)
      timer.unref?.()
      site.server.close(() => {
        clearTimeout(timer)
        done()
      })
    })))
  }

  /** @param {string} root - real path of the workspace root. */
  async #listen(root) {
    const server = createServer((request, response) => {
      void this.#handle(root, request, response)
    })
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      // Port 0: the system picks a free one, so two workspaces never fight.
      server.listen(0, '127.0.0.1', () => {
        server.off('error', rejectListen)
        resolveListen(undefined)
      })
    })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    return { server, info: { url: `http://127.0.0.1:${port}`, port, root, token: this.#token } }
  }

  /**
   * Whether the Host header names this loopback listener; a rebound page carries
   * the attacker's name here even though the socket lands on 127.0.0.1.
   * @param {import('node:http').IncomingMessage} request
   */
  #hostTrusted(request) {
    const host = String(request.headers.host ?? '')
    const port = request.socket.localPort
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`
  }

  /**
   * Resolve the token a request carries.
   *
   * Only `/t/<token>/<path>` can boot a page (no cookie exists yet); after that
   * the HttpOnly cookie carries every subresource request, which is why the
   * token can be stripped from the document URL. Both forms address the same
   * tree: everything served lives under `/t/`, and the part after it is the
   * workspace path.
   * @param {import('node:http').IncomingMessage} request
   * @param {string} pathname
   * @returns {{ pathname: string, source: 'path' | 'cookie' } | null}
   */
  #authorization(request, pathname) {
    if (pathname.startsWith(TOKEN_PREFIX)) {
      const rest = pathname.slice(TOKEN_PREFIX.length)
      const slash = rest.indexOf('/')
      const token = slash === -1 ? rest : rest.slice(0, slash)
      if (sameToken(safeDecode(token), this.#token)) {
        const tail = slash === -1 ? '/' : rest.slice(slash)
        return { pathname: tail === '' ? '/' : tail, source: 'path' }
      }
    }
    const cookie = readCookie(request.headers.cookie, TOKEN_COOKIE)
    if (typeof cookie === 'string' && sameToken(cookie, this.#token)) {
      const tail = pathname.startsWith(TOKEN_PREFIX) ? `/${pathname.slice(TOKEN_PREFIX.length)}` : pathname
      return { pathname: tail, source: 'cookie' }
    }
    return null
  }

  /**
   * @param {string} root - real path of the workspace root.
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async #handle(root, request, response) {
    const send = (status, body, headers = {}) => {
      response.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        // Iterating on a file should not require a cache-busting query.
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...headers,
      })
      response.end(request.method === 'HEAD' ? undefined : body)
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(405, 'method not allowed\n', { allow: 'GET, HEAD' })
      return
    }

    let pathname
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      send(400, 'bad request\n')
      return
    }

    if (!this.#hostTrusted(request)) {
      this.#logger(`refused ${pathname} with an untrusted host`)
      send(403, 'forbidden\n')
      return
    }
    const auth = this.#authorization(request, pathname)
    if (auth === null) {
      this.#logger(`refused ${pathname} without a valid token`)
      send(403, 'forbidden\n')
      return
    }
    pathname = auth.pathname

    const got = resolveWithin(root, pathname)
    if ('error' in got) {
      // Say what happened, never which directory we looked at.
      send(got.error === 'bad_path' ? 400 : 403, 'forbidden\n')
      return
    }

    try {
      let target = got.path
      let stat = await fsp.stat(target)
      if (stat.isDirectory()) {
        target = resolve(target, 'index.html')
        stat = await fsp.stat(target)
      }
      if (!stat.isFile()) {
        send(404, 'not found\n')
        return
      }
      // A symlink inside the root can still point outside it; the string check
      // above cannot see that, so check the real path too.
      const real = await fsp.realpath(target)
      const rel = relative(root, real)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        send(403, 'forbidden\n')
        return
      }
      if (stat.size > this.#maxBytes) {
        send(413, `file too large (${stat.size} bytes, limit ${this.#maxBytes})\n`)
        return
      }
      const type = MIME.get(target.slice(target.lastIndexOf('.')).toLowerCase()) ?? 'application/octet-stream'
      // A document reached through the token URL is redirected to its plain path
      // carrying the cookie. Subresources then load without a token in any URL,
      // so page scripts cannot lift it out of `location`.
      if (type.startsWith('text/html') && auth.source === 'path') {
        const encoded = rel.split(/[\\/]/).map((part) => encodeURIComponent(part)).join('/')
        send(302, '', {
          'content-type': 'text/plain; charset=utf-8',
          location: `${TOKEN_PREFIX}${encoded}`,
          'set-cookie': `${TOKEN_COOKIE}=${this.#token}; Path=/; HttpOnly; SameSite=Lax`,
        })
        return
      }
      response.writeHead(200, {
        'content-type': type,
        'content-length': String(stat.size),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      if (request.method === 'HEAD') {
        response.end()
        return
      }
      const stream = createReadStream(real)
      stream.on('error', () => response.destroy())
      stream.pipe(response)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        send(404, 'not found\n')
        return
      }
      this.#logger(`static server error on ${pathname}: ${error?.code ?? error?.message ?? 'unknown'}`)
      send(500, 'internal error\n')
    }
  }
}

/** Constant-time token comparison; a length mismatch short-circuits instead of throwing. */
function sameToken(actual, expected) {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Decode a path segment without letting a malformed escape throw. */
function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** One cookie value from a `Cookie` header, or `undefined`. */
function readCookie(header, name) {
  if (typeof header !== 'string' || header === '') return undefined
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at === -1) continue
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return undefined
}
