// tmp/bridge-logs.mjs — 读桥的 /logs（需要发现路由下发的令牌），只打印最后 N 条
import fs from 'node:fs';
import { createHash, createHmac } from 'node:crypto';

const hostPort = process.argv[2] ?? '127.0.0.1:9529';
const tail = Number(process.argv[3] ?? 25);
const yaml = fs.readFileSync('C:/Users/林焕文/.dsh/.credentials.yaml', 'utf8');
const m = yaml.match(/client-connection\/browser-session:\s*\n(?:.*\n)*?\s+secret:\s*(\S+)/);
const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
const b64url = (b) => b.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
const now = Date.now();
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority: hostPort, issuedAt: now, expiresAt: now + 3_600_000 }), 'utf8'));
const sig = b64url(createHmac('sha256', secret).update(body).digest());
const cookie = `dsh-auth-${b64url(createHash('sha256').update(hostPort).digest())}=v1.${body}.${sig}`;

const discovery = await (await fetch(`http://${hostPort}/agent-browser/discovery`, { headers: { cookie } })).json();
const logs = await (await fetch(`http://127.0.0.1:${discovery.port}/dsh-agent-browser/logs`, { headers: { authorization: `Bearer ${discovery.token}` } })).json();
const entries = Array.isArray(logs) ? logs : (logs.logs ?? logs.entries ?? []);
for (const entry of entries.slice(-tail)) console.log(typeof entry === 'string' ? entry : JSON.stringify(entry));
