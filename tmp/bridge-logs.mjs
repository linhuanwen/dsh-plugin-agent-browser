// 桥日志探针：discovery → /dsh-agent-browser/logs（H/S 案例取证用，例如截图挂死时看 capture 记录）。
// 用法：node tmp/bridge-logs.mjs [hostPort] [tail=40] [filter=capture]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, createHmac } from 'node:crypto'

const hostPort = process.argv[2] ?? '127.0.0.1:9522'
const tail = Number(process.argv[3] ?? 40)
const filter = process.argv[4] ?? ''

const yaml = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const m = yaml.match(/client-connection\/browser-session:\s*\n(?:.*\n)*?\s+secret:\s*(\S+)/)
if (!m) throw new Error('browser-session secret not found')
const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
const b64url = (buf) => buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const now = Date.now()
const body = b64url(Buffer.from(JSON.stringify({
  version: 1, authority: hostPort, issuedAt: now, expiresAt: now + 24 * 3600 * 1000,
}), 'utf8'))
const sig = b64url(createHmac('sha256', secret).update(body).digest())
const cookie = 'dsh-auth-' + b64url(createHash('sha256').update(hostPort).digest()) + '=v1.' + body + '.' + sig

const disc = await fetch(`http://${hostPort}/agent-browser/discovery`, { headers: { cookie } })
const info = await disc.json()
if (!info.ok) throw new Error('discovery failed: ' + JSON.stringify(info))

const res = await fetch(`http://127.0.0.1:${info.port}/dsh-agent-browser/logs?tail=${tail}`, {
  headers: { authorization: `Bearer ${info.token}` },
})
const text = await res.text()
let entries
try { entries = JSON.parse(text) } catch { entries = null }
if (!entries) { console.log('HTTP ' + res.status + ' body: ' + text.slice(0, 500)); process.exit(0) }
const list = Array.isArray(entries) ? entries : (entries.logs ?? entries.entries ?? [])
console.log(`log entries: ${list.length} (tail=${tail} filter=${filter || '(none)'})`)
for (const e of list) {
  const line = typeof e === 'string' ? e : JSON.stringify(e)
  if (!filter || line.includes(filter)) console.log(line.slice(0, 300))
}
