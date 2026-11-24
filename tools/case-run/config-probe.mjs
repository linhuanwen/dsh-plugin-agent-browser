// Settings-page channel probe: GET /config, and optionally POST one patch.
//
// Usage:
//   node tools/case-run/config-probe.mjs [127.0.0.1:10972]
//   node tools/case-run/config-probe.mjs 127.0.0.1:10972 '{"routing":"auto"}'
//
// The bridge is behind the same auth fence as everything else, so the probe
// mints the dsh-auth cookie exactly like browser-health.mjs does.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, createHmac } from 'node:crypto'

const hostPort = process.argv[2] ?? '127.0.0.1:10972'
// PowerShell eats quotes inside a native argument, so a patch may also arrive in
// PATCH_JSON (set it with $env:PATCH_JSON = '{"routing":"auto"}').
const patchArg = process.argv[3] ?? process.env.PATCH_JSON

const credPath = path.join(os.homedir(), '.dsh', '.credentials.yaml')
const yaml = fs.readFileSync(credPath, 'utf8')
const m = yaml.match(/client-connection\/browser-session:\s*\n(?:.*\n)*?\s+secret:\s*(\S+)/)
if (!m) throw new Error('browser-session secret not found in ' + credPath)
const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')

const b64url = (buf) => buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const now = Date.now()
const body = b64url(Buffer.from(JSON.stringify({
  version: 1, authority: hostPort, issuedAt: now, expiresAt: now + 24 * 3600 * 1000,
}), 'utf8'))
const sig = b64url(createHmac('sha256', secret).update(body).digest())
const cookieName = 'dsh-auth-' + b64url(createHash('sha256').update(hostPort).digest())

const discovery = await fetch(`http://${hostPort}/agent-browser/discovery`, {
  headers: { cookie: `${cookieName}=v1.${body}.${sig}` },
})
console.log(`discovery: HTTP ${discovery.status}`)
if (discovery.status !== 200) {
  console.log('  body:', (await discovery.text()).slice(0, 300))
  process.exit(1)
}
const info = await discovery.json()
const base = `http://127.0.0.1:${info.port}/dsh-agent-browser`
const headers = { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }

const read = async () => {
  const res = await fetch(`${base}/config`, { headers })
  const text = await res.text()
  console.log(`GET /config: HTTP ${res.status}`)
  if (res.status !== 200) {
    console.log('  body:', text.slice(0, 300))
    return
  }
  const data = JSON.parse(text)
  console.log('  fields:', JSON.stringify(data.fields))
  console.log('  values:', JSON.stringify(data.values, null, 2))
}

await read()

if (patchArg !== undefined) {
  const patch = JSON.parse(patchArg)
  const res = await fetch(`${base}/config`, { method: 'POST', headers, body: JSON.stringify({ patch }) })
  const text = await res.text()
  console.log(`POST /config ${patchArg}: HTTP ${res.status}`)
  console.log('  body:', text.slice(0, 600))
  await read()
}
