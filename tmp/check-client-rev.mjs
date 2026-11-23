// Read the last client-half reports from the bridge /logs (local forensic probe).
import fs from 'node:fs'
import { createHash, createHmac } from 'node:crypto'

const hostPort = process.argv[2] ?? '127.0.0.1:7734'
const yaml = fs.readFileSync('C:/Users/林焕文/.dsh/.credentials.yaml', 'utf8')
const m = yaml.match(/client-connection\/browser-session:\s*\n(?:.*\n)*?\s+secret:\s*(\S+)/)
if (!m) throw new Error('browser-session secret not found')
const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
if (secret.byteLength !== 32) throw new Error('unexpected secret length: ' + secret.byteLength)

const b64url = (buf) => buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const now = Date.now()
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority: hostPort, issuedAt: now, expiresAt: now + 24 * 3600 * 1000 }), 'utf8'))
const sig = b64url(createHmac('sha256', secret).update(body).digest())
const cookieName = 'dsh-auth-' + b64url(createHash('sha256').update(hostPort).digest())

const discovery = await fetch(`http://${hostPort}/agent-browser/discovery`, { headers: { cookie: `${cookieName}=v1.${body}.${sig}` } })
const info = JSON.parse(await discovery.text())
if (!info?.ok) throw new Error('discovery failed: ' + discovery.status)

const res = await fetch(`http://127.0.0.1:${info.port}/dsh-agent-browser/logs`, { headers: { authorization: `Bearer ${info.token}` } })
const parsed = JSON.parse(await res.text())
const entries = Array.isArray(parsed) ? parsed : parsed.logs || []
console.log('entries:', entries.length)
for (const entry of entries.slice(-40)) {
  const message = typeof entry === 'string' ? entry : entry.message
  const data = typeof entry === 'string' ? '' : JSON.stringify(entry.data ?? '')
  if (/client half|rev/i.test(String(message) + data)) console.log('-', message, data.slice(0, 180))
}
