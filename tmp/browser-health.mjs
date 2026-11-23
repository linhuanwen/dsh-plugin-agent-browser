// 装机复核探针：discovery → /health（桥 diagnostics），用于 G5 前置条件与 G3 复跑。
// 用法：node tmp/browser-health.mjs [127.0.0.1:4991]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, createHmac } from 'node:crypto'

const hostPort = process.argv[2] ?? '127.0.0.1:4991'
const credPath = path.join(os.homedir(), '.dsh', '.credentials.yaml')
const yaml = fs.readFileSync(credPath, 'utf8')
const m = yaml.match(/client-connection\/browser-session:\s*\n(?:.*\n)*?\s+secret:\s*(\S+)/)
if (!m) throw new Error('browser-session secret not found in ' + credPath)
const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
if (secret.byteLength !== 32) throw new Error('unexpected secret length: ' + secret.byteLength)

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
const discoveryText = await discovery.text()
console.log(`discovery: HTTP ${discovery.status}`)
if (discovery.status !== 200) {
  console.log('  body:', discoveryText.slice(0, 300))
  console.log('RESULT: plugin NOT active in this host')
  process.exit(1)
}
const info = JSON.parse(discoveryText)
console.log('  discovery:', JSON.stringify({ ok: info.ok, port: info.port, hostRev: info.hostRev, clientRev: info.clientRev, version: info.version }))

const port = info.port
const base = `http://127.0.0.1:${port}`
for (const route of ['/dsh-agent-browser/health', '/health']) {
  const res = await fetch(base + route, { headers: { authorization: `Bearer ${info.token}` } })
  console.log(`${route}: HTTP ${res.status}`)
  if (res.status === 200) {
    const health = await res.json()
    console.log(JSON.stringify(health, null, 2))
    const d = health.diagnostics ?? {}
    console.log('RESULT: tools=' + d.tools + ' registered=' + d.registered
      + ' conflicts=' + JSON.stringify(d.conflicts ?? [])
      + ' failed=' + JSON.stringify(d.failed ?? []))
    break
  }
}
