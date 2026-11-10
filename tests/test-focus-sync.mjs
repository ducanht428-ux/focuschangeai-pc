// Local proof for the sync Function: the JWT it signs really verifies, the Firestore encoding is right,
// and the endpoint refuses to become a general write hole. A throwaway RSA key stands in for the real
// service account, which never appears in a test.
import crypto from 'node:crypto';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = {
  client_email: 'sync@demo.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token',
  project_id: 'demo-project',
};
process.env.FIREBASE_SA_JSON = JSON.stringify(sa);

const F = await import('../functions/focus-sync.mjs');

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  -> ' + JSON.stringify(got));
};

// A fetch that records calls and answers like Google: a token, then an ack.
const calls = [];
const mockFetch = async (url, opts = {}) => {
  calls.push({ url, opts });
  if (String(url).includes('oauth2')) {
    return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
  }
  if (String(url).includes(':runQuery')) {
    return {
      ok: true,
      json: async () => [{
        document: {
          name: 'projects/demo/databases/(default)/documents/sessions/hs1-web-7',
          fields: {
            student_id: { stringValue: 'hs1' }, valid_ms: { integerValue: '600000' },
            face_ratio: { doubleValue: 0.9123 }, eligible: { booleanValue: true },
          },
        },
      }],
    };
  }
  return { ok: true, json: async () => ({}) };
};

// ---------------------------------------------------------------------------
const jwt = F.signAssertion(sa, 1762000000000);
const [h, c, sig] = jwt.split('.');
check('assertion signature verifies with the public key',
  crypto.verify('RSA-SHA256', Buffer.from(h + '.' + c), publicKey, Buffer.from(sig, 'base64url')), true);
const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
check('claims name the service account and the datastore scope',
  [claims.iss, claims.aud, claims.scope],
  ['sync@demo.iam.gserviceaccount.com', 'https://oauth2.googleapis.com/token',
    'https://www.googleapis.com/auth/datastore']);

// ---------------------------------------------------------------------------
calls.length = 0;
const okSet = await F.setDocument('sessions/hs1-web-7', {
  student_id: 'hs1', valid_ms: 600000, face_ratio: 0.9123, eligible: true, source: 'web-pc',
}, mockFetch);
check('set resolves ok', okSet, true);
const patch = calls.find((x) => x.opts.method === 'PATCH');
check('PATCH targets the sessions doc in the right project',
  patch.url, 'https://firestore.googleapis.com/v1/projects/demo-project/databases/(default)/documents/sessions/hs1-web-7');
check('ints stay ints, fractions stay doubles, flags stay flags',
  JSON.parse(patch.opts.body).fields, {
    student_id: { stringValue: 'hs1' }, valid_ms: { integerValue: '600000' },
    face_ratio: { doubleValue: 0.9123 }, eligible: { booleanValue: true },
    source: { stringValue: 'web-pc' },
  });
check('the bearer token from the assertion is used',
  patch.opts.headers.authorization, 'Bearer tok');

// ---------------------------------------------------------------------------
const rows = await F.querySessions('hs1', mockFetch);
check('runQuery rows decode back to plain values',
  rows[0], { doc: 'hs1-web-7', student_id: 'hs1', valid_ms: 600000, face_ratio: 0.9123, eligible: true });

// ---------------------------------------------------------------------------
const mkReqRes = (method, url, body) => {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  const req = Object.assign((async function* () { for (const ch of chunks) yield ch; })(), { method, url });
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = s; } };
  return { req, res };
};

{
  const { req, res } = mkReqRes('POST', '/api/focus-sync', { doc: 'hs1-7', payload: { a: 1 } });
  await F.handler(req, res, mockFetch);
  check('a phone/camera-shaped key is refused, not proxied', res.statusCode, 400);
}
{
  const { req, res } = mkReqRes('POST', '/api/focus-sync', { doc: 'hs1-web-7', payload: { student_id: 'hs1' } });
  await F.handler(req, res, mockFetch);
  check('a -web- key is accepted', res.statusCode, 200);
}
{
  const { req, res } = mkReqRes('GET', '/api/focus-sync?student_id=hs1', null);
  await F.handler(req, res, mockFetch);
  check('GET returns the child rows as json', [res.statusCode, res.headers['content-type']],
    [200, 'application/json']);
}
{
  const { req, res } = mkReqRes('DELETE', '/api/focus-sync', null);
  await F.handler(req, res, mockFetch);
  check('anything else is a 404', res.statusCode, 404);
}

console.log(fails ? '\n' + fails + ' FAIL(S)' : '\nALL PASS');
process.exit(fails ? 1 : 0);
