const http = require('http');
const crypto = require('crypto');
const store = require('./store');
function loadToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  try { return require('fs').readFileSync(__dirname + '/bridge.token', 'utf8').trim(); } catch { return null; }
}
const TOKEN = loadToken();
// Length-mismatch guard is required: timingSafeEqual throws when buffer lengths differ, and a
// thrown error inside the async handler would surface as a 500/socket hang instead of 401.
function tokenOk(given) {
  if (!TOKEN || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const EXT_ORIGIN = process.env.BRIDGE_EXT_ORIGIN || '';
function send(res, code, body, origin) {
  const headers = { 'content-type': 'application/json' };
  if (origin && origin === EXT_ORIGIN) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-headers'] = 'content-type, x-bridge-token';
    headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
  }
  res.writeHead(code, headers);
  res.end(body == null ? '' : JSON.stringify(body));
}
// Request bodies are capped: readBody used to accumulate an unbounded string, so one 64MB POST
// ballooned RSS by ~430MB. On overflow the socket is destroyed and null resolves - handlers must
// not write to a destroyed response, they just return.
const MAX_BODY_BYTES = 1024 * 1024;
function readBody(req) {
  return new Promise((resolve) => {
    let d = '', n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > MAX_BODY_BYTES) { req.destroy(); resolve(null); return; }
      d += c;
    });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'OPTIONS') return send(res, 204, null, origin);
  if (!tokenOk(req.headers['x-bridge-token'])) return send(res, 401, { error: 'bad token' }, origin);
  if (req.method === 'POST' && url.pathname === '/jobs') {
    const body = await readBody(req);
    if (body === null) return;
    if (!body.query && !body.kind) return send(res, 400, { error: 'query or kind required' }, origin);
    const job = store.createJob(body);
    return send(res, 201, { id: job.id }, origin);
  }
  if (req.method === 'GET' && url.pathname === '/jobs/next') {
    const job = store.claimNext();
    if (!job) return send(res, 204, null, origin);
    return send(res, 200, { id: job.id, query: job.query, mode: job.mode, kind: job.kind, payload: job.payload }, origin);
  }
  let m = url.pathname.match(/^\/jobs\/([^/]+)\/result$/);
  if (req.method === 'POST' && m) {
    const body = await readBody(req);
    if (body === null) return;
    const job = store.setResult(m[1], body);
    if (!job) {
      // Distinguish "no such job" from "job exists but is not in a claimable/resolvable state".
      if (!store.get(m[1])) return send(res, 404, { error: 'no job' }, origin);
      return send(res, 409, { error: 'job not in claimed state' }, origin);
    }
    return send(res, 200, { ok: true }, origin);
  }
  m = url.pathname.match(/^\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && m) {
    const job = store.get(m[1]);
    if (!job) return send(res, 404, { error: 'no job' }, origin);
    return send(res, 200, { status: job.status, result: job.result, error: job.error }, origin);
  }
  return send(res, 404, { error: 'not found' }, origin);
});
if (require.main === module) {
  const port = process.env.BRIDGE_PORT || 8787;
  server.listen(port, '127.0.0.1', () => console.log(`bridge relay on 127.0.0.1:${port}`));
}
module.exports = { server };