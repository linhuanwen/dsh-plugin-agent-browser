/**
 * TICKET-001 probe beacon.
 *
 * The probe runs inside the DSH renderer, where the agent cannot read the
 * console. `mode: 'no-cors'` + `text/plain` keeps every POST a simple request
 * (no preflight), so the page never needs this server to answer correctly.
 *
 *   node beacon.mjs            # listen on 127.0.0.1:8791
 *
 * Writes one JSON line per POST to stdout, and materializes any `screenshot`
 * payload as `probe/shot-<n>.txt` (a data: URL) for inspection.
 */
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PROBE_PORT ?? 8791)
let shots = 0

const server = createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('probe beacon alive\n')
    return
  }
  let body = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => { body += chunk })
  req.on('end', async () => {
    res.writeHead(204, { 'access-control-allow-origin': '*' })
    res.end()
    let parsed
    try { parsed = JSON.parse(body) }
    catch { console.log('RAW ' + body.slice(0, 2000)); return }
    if (parsed.step === 'screenshot' && typeof parsed.data?.dataUrl === 'string') {
      shots += 1
      const file = join(here, `shot-${shots}.txt`)
      await writeFile(file, parsed.data.dataUrl, 'utf8').catch(() => {})
      console.log(JSON.stringify({ ...parsed, data: { dataUrl: `<saved ${file} ${parsed.data.dataUrl.length}B>` } }))
      return
    }
    console.log(JSON.stringify(parsed))
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`beacon listening on http://127.0.0.1:${port}/beacon`)
})
