// tmp/discovery-probe.mjs — 用 .credentials.yaml 里的 browser-session secret 自签一个合法 cookie，
// 再打宿主的 /agent-browser/discovery，拿到桥端口与令牌（只用于本机 H 案例验收）。
// 用法: node tmp/discovery-probe.mjs [hostPort]
import fs from 'node:fs';
import { createHash, createHmac } from 'node:crypto';

const hostPort = process.argv[2] ?? '127.0.0.1:9529';
const yaml = fs.readFileSync('C:/Users/林焕文/.dsh/.credentials.yaml', 'utf8');

// 只取 client-connection/browser-session 下的 secret（其余条目不解析，避免把敏感值带进上下文）
const m = yaml.match(/client-connection\/browser-session:\s*\n(?:.*\n)*?\s+secret:\s*(\S+)/);
if (!m) throw new Error('browser-session secret not found');
const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
if (secret.byteLength !== 32) throw new Error('unexpected secret length: ' + secret.byteLength);

const b64url = (buf) => buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
const authority = hostPort;
const now = Date.now();
const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 24 * 3600 * 1000 };
const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
const sig = b64url(createHmac('sha256', secret).update(body).digest());
const cookieValue = `v1.${body}.${sig}`;
const cookieName = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest());

const base = `http://${hostPort}`;
const discovery = await fetch(`${base}/agent-browser/discovery`, {
  headers: { cookie: `${cookieName}=${cookieValue}` },
});
const text = await discovery.text();
console.log('discovery.status=' + discovery.status);
console.log('discovery.body=' + text.slice(0, 400));

let info = null;
try { info = JSON.parse(text); } catch {}
if (info?.ok) {
  const healthNoToken = await fetch(`http://127.0.0.1:${info.port}/dsh-agent-browser/health`);
  console.log('health.no-token=' + healthNoToken.status);
  const health = await fetch(`http://127.0.0.1:${info.port}/dsh-agent-browser/health`, {
    headers: { authorization: `Bearer ${info.token}` },
  });
  const healthBody = await health.text();
  console.log('health.with-token=' + health.status + ' ' + healthBody)
}
