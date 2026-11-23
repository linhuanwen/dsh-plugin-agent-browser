// tmp/h3-auth-probe.mjs — H3：桥/静态鉴权与双实例隔离的机器可判测试
import fs from 'node:fs';
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';

const hostPort = process.argv[2] ?? '127.0.0.1:9522';
const yaml = fs.readFileSync('C:/Users/林焕文/.dsh/.credentials.yaml', 'utf8');
const m = yaml.match(/client-connection\/browser-session:\s*\n(?:.*\n)*?\s+secret:\s*(\S+)/);
const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
const b64url = (b) => b.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
const cookieFor = (authority) => {
  const now = Date.now();
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 3_600_000 }), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}=v1.${body}.${sig}`;
};

const request = (url, { method = 'GET', headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' — ' + detail}`);
};

// ---- 1. 桥鉴权 ----
const discovery = await (await fetch(`http://${hostPort}/agent-browser/discovery`, {
  headers: { cookie: cookieFor(hostPort) },
})).json();
const bridgeBase = `http://127.0.0.1:${discovery.port}/dsh-agent-browser`;
check('discovery returns a 43-char token', /^[A-Za-z0-9_-]{43}$/u.test(discovery.token), `port=${discovery.port}`);

const noToken = await request(`${bridgeBase}/health`);
check('bridge /health without token → 403', noToken.status === 403, `status=${noToken.status}`);
check('bridge 403 body carries code unauthorized', /"code":"unauthorized"/u.test(noToken.body));

const wrongToken = await request(`${bridgeBase}/health`, { headers: { authorization: 'Bearer ' + 'A'.repeat(43) } });
check('bridge /health with wrong token → 403', wrongToken.status === 403, `status=${wrongToken.status}`);

const forgedHost = await request(`${bridgeBase}/health`, {
  headers: { authorization: `Bearer ${discovery.token}`, host: 'evil.example' },
});
check('bridge forged Host with valid token → 403 untrusted host',
  forgedHost.status === 403 && /untrusted host/u.test(forgedHost.body), `status=${forgedHost.status}`);

const good = await request(`${bridgeBase}/health`, { headers: { authorization: `Bearer ${discovery.token}` } });
check('bridge /health with token → 200', good.status === 200 && /"ok":true/u.test(good.body), `status=${good.status}`);

// ---- 2. 静态服务鉴权（独立实例，同生产类）----
const { StaticSites, urlForPath } = await import('file:///C:/Users/%E6%9E%97%E7%84%95%E6%96%87/.dsh/profiles/desktop/node_modules/dsh-plugin-agent-browser/static.js');
const sites = new StaticSites({});
const site = await sites.ensure(process.cwd());
const okUrl = urlForPath(site.url, site.root, 'tmp/h7-page.html', site.token);
const doc = await request(okUrl);
check('static token URL → 302 to token-free path', doc.status === 302 && /^\/t\/tmp\/h7-page\.html$/u.test(String(doc.headers.location)), `status=${doc.status} location=${doc.headers.location}`);
check('static 302 sets HttpOnly token cookie',
  /^ab=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax$/u.test(String(doc.headers['set-cookie'])), String(doc.headers['set-cookie']).slice(0, 80));
const cookie = String(doc.headers['set-cookie']).split(';')[0];
const withCookie = await request(`${site.url}/t/tmp/h7-page.html`, { headers: { cookie } });
check('static redirect target with cookie → 200', withCookie.status === 200 && /Hardening fixture/u.test(withCookie.body), `status=${withCookie.status}`);
const bare = await request(`${site.url}/t/tmp/h7-page.html`);
check('static token-free URL without cookie → 403', bare.status === 403, `status=${bare.status}`);
const badToken = await request(`${site.url}/t/${'B'.repeat(43)}/tmp/h7-page.html`);
check('static wrong token → 403', badToken.status === 403, `status=${badToken.status}`);
await sites.dispose();

// ---- 3. 双实例隔离 ----
const { Bridge } = await import('file:///C:/Users/%E6%9E%97%E7%84%95%E6%96%87/.dsh/profiles/desktop/node_modules/dsh-plugin-agent-browser/bridge.js');
const silent = () => {};
const a = new Bridge({ port: 0, logger: silent });
const b = new Bridge({ port: 0, logger: silent });
await a.start();
await b.start();
check('two bridges listen on different ports', a.port !== b.port, `${a.port} vs ${b.port}`);
check('two bridges mint different tokens', a.token !== b.token, `${a.token.slice(0, 6)}… vs ${b.token.slice(0, 6)}…`);
const crossAB = await request(`http://127.0.0.1:${b.port}/dsh-agent-browser/health`, { headers: { authorization: `Bearer ${a.token}` } });
check("bridge B rejects bridge A's token", crossAB.status === 403, `status=${crossAB.status}`);
const crossBA = await request(`http://127.0.0.1:${a.port}/dsh-agent-browser/health`, { headers: { authorization: `Bearer ${b.token}` } });
check("bridge A rejects bridge B's token", crossBA.status === 403, `status=${crossBA.status}`);
const selfA = await request(`http://127.0.0.1:${a.port}/dsh-agent-browser/health`, { headers: { authorization: `Bearer ${a.token}` } });
check('bridge A accepts its own token', selfA.status === 200, `status=${selfA.status}`);
await a.close();
await b.close();

console.log(failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
