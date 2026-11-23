/**
 * Downloads: the one browser capability that does not need the page.
 *
 * Everything else in this plugin is a round trip to the panel (it owns the
 * `<webview>`). A file is different: the host has Node, `fetch` and the
 * filesystem, so the shortest honest path is "fetch it here, write it there,
 * report the hash". Doing it in the page would only buy cookies, and that case
 * is opt-in (`via: 'page'`, not implemented yet) rather than the default.
 *
 * Two rules are load-bearing and easy to get wrong later:
 *  - a name from a header is never trusted with a path, and an existing file is
 *    never replaced (a second download of the same regulation becomes `-1`);
 *  - a failure is reported as a failure. The agent must not be able to mistake
 *    "I could not download it" for "here is what the attachment says".
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import fsp from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'

/** Hard ceiling for one file; the panel is a browsing aid, not a mirror. */
export const MAX_BYTES = 50 * 1024 * 1024

/** Time to first byte. A site that has not answered in 10 s is not going to. */
export const CONNECT_TIMEOUT_MS = 10_000

/** Whole transfer, body included. */
export const TOTAL_TIMEOUT_MS = 60_000

/** Where downloads land, relative to the session working directory. */
export const DOWNLOADS_DIR = 'downloads'

/** Extensions that mean "this was supposed to be a document". */
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.7z'])

/** Extension per content type, for urls that end in a query string or nothing. */
const MIME_EXTENSIONS = new Map([
  ['application/pdf', '.pdf'],
  ['application/msword', '.doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/zip', '.zip'],
  ['text/csv', '.csv'],
])

/** Hosts that are this machine. Refused unless a test opts in explicitly. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]'])

/**
 * A download failed, with the stage that failed.
 *
 * The stage is the contract: the model (and the user reading the card) needs to
 * tell "the network is down" from "the file is not there" from "it was too big".
 */
export class DownloadError extends Error {
  /**
   * @param {'validate' | 'connect' | 'http' | 'too_large' | 'write'} stage - where it broke.
   * @param {string} message - one line for the model.
   * @param {Record<string, unknown>} [detail] - extra fields for the caller.
   */
  constructor(stage, message, detail = {}) {
    super(message)
    this.name = 'DownloadError'
    this.stage = stage
    Object.assign(this, detail)
  }
}

/**
 * Turn any string into a single safe path segment.
 *
 * Windows is the stricter target: `:` and `\` are separators or stream names,
 * and a trailing dot or space is silently dropped by Win32, which turns
 * `report.` and `report` into the same file. Anything that could climb out of
 * the directory (`..`) is rejected rather than stripped, because a silent
 * rename of `../../x` to `x` looks like success.
 * @param {string} name - a header or url basename.
 * @returns {string} a safe filename, never empty.
 */
export function sanitizeFilename(name) {
  const cleaned = String(name)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..' || cleaned.includes('..')) {
    throw new DownloadError('validate', `refusing the filename ${JSON.stringify(String(name))}: it is empty or tries to climb out of downloads/`)
  }
  // Windows drops a trailing dot/space, so `a.` and `a` would collide.
  const trimmed = cleaned.replace(/[. ]+$/, '')
  if (trimmed === '') throw new DownloadError('validate', `refusing the filename ${JSON.stringify(String(name))}: it has no base name`)
  return trimmed.slice(0, 120)
}

/**
 * Read a filename out of a Content-Disposition header.
 *
 * `filename*=UTF-8''%E4%B8%AD%E6%96%87.pdf` wins over `filename="fallback.pdf"`:
 * that is what the RFC says, and it is the one sites use for Chinese names.
 * @param {string | null | undefined} header - the raw header value.
 * @returns {string | undefined} the decoded name, if the header had a usable one.
 */
export function filenameFromDisposition(header) {
  if (typeof header !== 'string' || header === '') return undefined
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header)
  if (extended !== null) {
    try {
      return decodeURIComponent(extended[2].trim().replace(/^"|"$/g, ''))
    } catch {
      // A broken escape is not worth failing the download over; fall through.
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header)
  if (plain !== null) {
    const raw = (plain[2] ?? plain[1] ?? '').trim()
    if (raw !== '') return percentDecode(raw)
  }
  return undefined
}

/**
 * Undo percent-encoding when a header carries it.
 *
 * `filename="%E4%B8%AD%E6%96%87.pdf"` is what many Chinese CMSs send instead of
 * the RFC 5987 form. Browsers decode it, so we must too, or the file lands on
 * disk as an unreadable run of escapes (seen on samr.gov.cn attachments).
 * A literal `%` in a real name (`100%.pdf`) fails to decode and is kept as is.
 * @param {string} value - raw header fragment.
 * @returns {string} the decoded name when the escapes are valid.
 */
function percentDecode(value) {
  if (!value.includes('%')) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Decide what the file will be called, before touching the disk.
 *
 * Order is deliberate: the server's own name first (it is the most informative),
 * then the url basename (most links carry it), then a timestamp so two
 * unnamed files never fight over one name.
 * @param {object} input - the pieces a name can come from.
 * @param {string} input.url - the final url.
 * @param {string | null} [input.disposition] - raw Content-Disposition.
 * @param {string | null} [input.contentType] - raw Content-Type.
 * @param {string} [input.wanted] - a name the model asked for.
 * @param {number} [input.timestamp] - ms, for the fallback name.
 * @returns {string} a safe filename.
 */
export function pickFilename({ url, disposition, contentType, wanted, timestamp = Date.now() }) {
  if (typeof wanted === 'string' && wanted.trim() !== '') return sanitizeFilename(wanted)

  const fromHeader = filenameFromDisposition(disposition)
  if (fromHeader !== undefined) {
    try {
      return sanitizeFilename(fromHeader)
    } catch {
      // A hostile header must not fail the download; the url is still usable.
    }
  }

  let fromUrl
  try {
    const path = new URL(url).pathname
    const last = decodeURIComponent(path.split('/').filter((part) => part !== '').pop() ?? '')
    if (last !== '') fromUrl = sanitizeFilename(last)
  } catch {
    // Fall through to the timestamp.
  }
  if (fromUrl !== undefined && fromUrl !== '') {
    if (!fromUrl.includes('.')) {
      const extension = MIME_EXTENSIONS.get(String(contentType ?? '').split(';')[0].trim().toLowerCase())
      return extension === undefined ? fromUrl : `${fromUrl}${extension}`
    }
    return fromUrl
  }

  const extension = MIME_EXTENSIONS.get(String(contentType ?? '').split(';')[0].trim().toLowerCase()) ?? ''
  return `download-${timestamp}${extension}`
}

/**
 * The absolute downloads directory for a workspace, created on demand.
 * @param {string} root - absolute session working directory.
 * @param {string} [dirName] - directory name under the workspace, from config.
 * @returns {Promise<string>} the directory path.
 */
export async function ensureDownloadsDir(root, dirName = DOWNLOADS_DIR) {
  const dir = resolve(root, dirName)
  const rel = relative(resolve(root), dir)
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new DownloadError('validate', `refusing to write outside the workspace: ${dir}`)
  }
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

/**
 * Assert that a name resolves to a file directly inside `dir` (no subpaths).
 * @param {string} dir - the downloads directory.
 * @param {string} filename - an already-sanitized name.
 * @returns {string} the absolute target.
 */
export function resolveTarget(dir, filename) {
  const target = resolve(dir, filename)
  if (relative(dir, target).includes(sep) || basename(target) !== filename) {
    throw new DownloadError('validate', `refusing to write outside downloads/: ${filename}`)
  }
  return target
}

/**
 * The next free name: `a.pdf`, `a-1.pdf`, `a-2.pdf`.
 *
 * Existence is checked by trying to create it exclusively (`wx`), not by a
 * stat-then-write, so two downloads racing cannot clobber each other.
 * @param {string} dir - the downloads directory.
 * @param {string} filename - the preferred name.
 * @returns {string} a free absolute path.
 */
export async function reserveTarget(dir, filename) {
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const extension = dot > 0 ? filename.slice(dot) : ''
  for (let index = 0; index < 1000; index += 1) {
    const candidate = index === 0 ? filename : `${stem}-${index}${extension}`
    const target = resolveTarget(dir, candidate)
    try {
      const handle = await fsp.open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY)
      await handle.close()
      return target
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw new DownloadError('write', `cannot create ${candidate}: ${error?.message ?? error}`)
      }
    }
  }
  throw new DownloadError('write', `cannot find a free name for ${filename} after 1000 tries`)
}

/**
 * Refuse a url we must not fetch.
 *
 * `file:` and friends are dropped for the same reason `browser_open` drops them
 * (see `normalizeUrl`): the model gets a clear refusal instead of an empty file.
 * Loopback is refused too — the only http service this plugin itself owns is the
 * workspace file server, and downloading a file the agent already has on disk is
 * always a mistake (or a probe of the harness' own ports).
 * @param {string} raw - the url the model passed.
 * @param {{ allowLocal?: boolean }} [options] - tests may opt into loopback.
 * @returns {URL} the parsed url.
 */
export function assertDownloadable(raw, options = {}) {
  let parsed
  try {
    parsed = new URL(String(raw))
  } catch {
    throw new DownloadError('validate', `not an absolute URL: ${String(raw).slice(0, 120)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DownloadError('validate', `only http(s) URLs can be downloaded, got ${parsed.protocol}`)
  }
  if (options.allowLocal !== true && LOCAL_HOSTS.has(parsed.hostname)) {
    throw new DownloadError('validate', `refusing to download from ${parsed.hostname}: that is this machine, not the web`)
  }
  return parsed
}

/**
 * Read a response body with a hard byte ceiling.
 * @param {Response} response - an ok response.
 * @param {AbortSignal} signal - the total-transfer signal.
 * @param {number} [limit] - byte ceiling, from config.
 * @returns {Promise<Buffer>} the whole body.
 */
async function readCapped(response, signal, limit = MAX_BYTES) {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > limit) {
    throw new DownloadError('too_large', `the file is ${declared} bytes, over the ${limit} byte limit`, { bytes: declared })
  }
  if (response.body === null) return Buffer.alloc(0)
  const chunks = []
  let total = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      if (signal.aborted) throw new DownloadError('too_large', `transfer stopped: ${String(signal.reason?.message ?? 'aborted')}`)
      const { done, value } = await reader.read()
      if (done === true) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        throw new DownloadError('too_large', `the file passed the ${limit} byte limit mid-transfer`, { bytes: total })
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock?.()
  }
  return Buffer.concat(chunks)
}

/** @param {Buffer} body - bytes to hash. @returns {string} hex sha256. */
export function sha256(body) {
  return createHash('sha256').update(body).digest('hex')
}

/**
 * Fetch one url into `<root>/downloads/`, or explain why not.
 *
 * Never returns a partial success: the file exists and hashes, or a
 * `DownloadError` says which stage failed. The caller turns that into
 * `download_failed`, and the agent is expected to say it could not download.
 * @param {string} root - absolute session working directory.
 * @param {object} options - what to download.
 * @param {string} options.url - absolute http(s) url.
 * @param {string} [options.filename] - a preferred name.
 * @param {string} [options.referer] - a Referer some sites require.
 * @param {string} [options.dir] - directory under the workspace, from config.
 * @param {number} [options.maxBytes] - byte ceiling, from config.
 * @param {(target: { filename: string, bytes: number, mime: string, finalUrl: string }) => void | Promise<void>} [options.checkTarget] -
 *   policy hook run once the final name and byte count are known, before
 *   anything is written; throwing refuses the download (TICKET-024).
 * @param {boolean} [options.allowLocal] - tests only.
 * @param {typeof fetch} [options.fetchImpl] - tests only.
 * @param {number} [options.now] - tests only.
 * @returns {Promise<{ path: string, bytes: number, sha256: string, mime: string, finalUrl: string }>} the file.
 */
export async function downloadTo(root, options) {
  const limit = Number.isInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_BYTES
  const parsed = assertDownloadable(options.url, { allowLocal: options.allowLocal === true })
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const headers = { accept: '*/*' }
  if (typeof options.referer === 'string' && options.referer !== '') headers.referer = options.referer

  let response
  const connectTimer = setTimeout(() => controller.abort(new Error(`no response in ${CONNECT_TIMEOUT_MS} ms`)), CONNECT_TIMEOUT_MS)
  try {
    response = await fetchImpl(parsed.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers,
    })
  } catch (error) {
    throw new DownloadError('connect', `could not reach ${parsed.host}: ${error?.message ?? error}`, { url: parsed.toString() })
  } finally {
    clearTimeout(connectTimer)
  }

  const finalUrl = typeof response.url === 'string' && response.url !== '' ? response.url : parsed.toString()
  const mime = String(response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (response.ok !== true) {
    throw new DownloadError('http', `the server answered ${response.status} ${response.statusText ?? ''}`.trim(), {
      status: response.status,
      url: finalUrl,
    })
  }

  // A wall or a login page answers 200 with html. If the link looked like a
  // document, that is not the document: say so instead of saving a login page.
  let wantedExtension = ''
  try {
    wantedExtension = basename(new URL(finalUrl).pathname).toLowerCase().replace(/^.*(\.[^.]+)$/, '$1')
  } catch {
    wantedExtension = ''
  }
  if ((mime === 'text/html' || mime === 'application/xhtml+xml') && DOCUMENT_EXTENSIONS.has(wantedExtension)) {
    throw new DownloadError(
      'http',
      `the server returned an HTML page instead of ${wantedExtension} (a wall or a login page, not the file)`,
      { url: finalUrl, mime },
    )
  }

  const totalTimer = setTimeout(() => controller.abort(new Error(`transfer passed ${TOTAL_TIMEOUT_MS} ms`)), TOTAL_TIMEOUT_MS)
  let body
  try {
    body = await readCapped(response, controller.signal, limit)
  } finally {
    clearTimeout(totalTimer)
  }

  const filename = pickFilename({
    url: finalUrl,
    disposition: response.headers.get('content-disposition'),
    contentType: mime,
    wanted: options.filename,
    timestamp: options.now ?? Date.now(),
  })
  // Policy decides on the resolved name and the real size, which is the only
  // moment both are known and nothing has been written yet (TICKET-024).
  if (typeof options.checkTarget === 'function') {
    await options.checkTarget({ filename, bytes: body.byteLength, mime, finalUrl })
  }
  const dir = await ensureDownloadsDir(root, options.dir ?? DOWNLOADS_DIR)
  const target = await reserveTarget(dir, filename)
  try {
    await fsp.writeFile(target, body)
  } catch (error) {
    throw new DownloadError('write', `cannot write ${target}: ${error?.message ?? error}`)
  }
  return {
    path: relative(root, target).replace(/\\/g, '/'),
    bytes: body.byteLength,
    sha256: sha256(body),
    mime: mime === '' ? 'application/octet-stream' : mime,
    finalUrl,
  }
}
