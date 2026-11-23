// 桥回执尺寸探针：给 /settle 发不同大小的 JSON body，看 host 侧上限与响应形态。
// 用法：node tools/case-run/settle-size-probe.mjs [127.0.0.1:9515]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, createHmac } from 'node:crypto'

const hostPort = process.argv[2] ?? '127.0.0.1:9515'
const credPath = path.join(os.homedir(), '.dsh', '.credentials.yaml')
const yaml = fs.readFileSync(credPath, 'utf8')
const m = yaml.match(/client-connection\/browser-session:\s*\n(?:.*\n)*?\s+secret:\s*(\S+)/)
if (!m) throw new Error('browser-session secret not found')
const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
const b64url = (buf) => buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const now = Date.now()
const claim = b64url(Buffer.from(JSON.stringify({
  version: 1, authority: hostPort, issuedAt: now, expiresAt: now + 3600 * 1000,
}), 'utf8'))
const sig = b64url(createHmac('sha256', secret).update(claim).digest())
const cookieName = 'dsh-auth-' + b64url(createHash('sha256').update(hostPort).digest())

const discovery = await fetch(`http://${hostPort}/agent-browser/discovery`, {
  headers: { cookie: `${cookieName}=v1.${claim}.${sig}` },
})
if (discovery.status !== 200) {
  console.log('discovery HTTP', discovery.status, '— plugin not active')
  process.exit(1)
}
const info = await discovery.json()
const base = `http://127.0.0.1:${info.port}/dsh-agent-browser`

/** One settle attempt with a payload of `chars` filler characters. */
async function attempt(chars) {
  const payload = JSON.stringify({ id: 'c-probe', ok: true, result: { dataUrl: 'x'.repeat(chars) } })
  const started = Date.now()
  try {
    const res = await fetch(`${base}/settle`, {
      method: 'POST',
      headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(20_000),
    })
    const text = await res.text()
    console.log(`chars=${String(chars).padStart(8)} bytes=${String(payload.length).padStart(8)} → HTTP ${res.status} ${Date.now() - started}ms ${text.slice(0, 160)}`)
  } catch (error) {
    console.log(`chars=${String(chars).padStart(8)} bytes=${String(payload.length).padStart(8)} → ${Date.now() - started}ms THREW ${String(error?.message ?? error)}`)
  }
}

// Sizes are the real samples plus the old 4 MiB boundary; `argv[3]` adds more
// (comma separated) so the same probe can poke a newer cap without editing it.
const extra = (process.argv[3] ?? '').split(',').filter(Boolean).map(Number)
for (const chars of [...[62_358, 2_772_754, 4_180_000, 4_190_000, 4_194_000, 4_239_798, 8_000_000], ...extra]) {
  await attempt(chars)
}
