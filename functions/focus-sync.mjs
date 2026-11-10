// The server half of the web leg's cloud sync (method B): the page never holds a key, it posts finished
// sessions here and this Function - which keeps the Firebase service account in a platform Secret -
// writes them to the SAME Firestore collection the phone and the camera already use.
//
// Deliberately dependency-free. firebase-admin would need an npm install on whatever hosts this; a
// service account can sign its own OAuth JWT with the crypto that ships in Node, and Firestore has a
// plain REST API. Fewer moving parts is the point: one file, no lockfile, deploys anywhere.
//
// Trust boundary: this endpoint is reachable by anyone who can load the page, so it only ever writes to
// the sessions collection under a "-web-" key and never reads or lists credentials. Tightening it to
// signed-in teachers is a later step, not this one.
import crypto from 'node:crypto';
import fs from 'node:fs';

const SCOPE = 'https://www.googleapis.com/auth/datastore';
const FS_BASE = 'https://firestore.googleapis.com/v1';

let sa = null;          // parsed service account
let token = null;       // { value, expiresAtMs }

function serviceAccount() {
  if (sa) return sa;
  const raw = process.env.FIREBASE_SA_JSON
    || (process.env.FIREBASE_SA_PATH ? fs.readFileSync(process.env.FIREBASE_SA_PATH, 'utf8') : '');
  if (!raw) throw new Error('no service account: set FIREBASE_SA_JSON or FIREBASE_SA_PATH');
  sa = JSON.parse(raw);
  return sa;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** A signed RS256 assertion the service account vouches for; Firestore trades it for an access token. */
export function signAssertion(account, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: account.client_email, scope: SCOPE, aud: account.token_uri, iat, exp: iat + 3600,
  }));
  const signingInput = header + '.' + claims;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), account.private_key);
  return signingInput + '.' + b64url(sig);
}

async function accessToken(fetchImpl) {
  if (token && token.expiresAtMs > Date.now() + 60_000) return token.value;
  const account = serviceAccount();
  const res = await fetchImpl(account.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion='
      + encodeURIComponent(signAssertion(account)),
  });
  if (!res.ok) throw new Error('token ' + res.status);
  const body = await res.json();
  token = { value: body.access_token, expiresAtMs: Date.now() + (body.expires_in || 3600) * 1000 };
  return token.value;
}

// Firestore Value encoding: integers stay integers, everything numeric-but-fractional is a double, and a
// missing measurement is simply not sent by the page so it never becomes a stored zero here either.
function toValue(v) {
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  return { stringValue: String(v) };
}

function fromValue(v) {
  if (!v) return null;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('stringValue' in v) return v.stringValue;
  return null;
}

function docFields(payload) {
  const fields = {};
  for (const [k, v] of Object.entries(payload)) fields[k] = toValue(v);
  return fields;
}

function docPath(projectId, path) {
  return `${FS_BASE}/projects/${projectId}/databases/(default)/documents/${path}`;
}

/** Replace one document, the REST twin of the admin SDK's set(). */
export async function setDocument(path, payload, fetchImpl = globalThis.fetch) {
  const account = serviceAccount();
  const res = await fetchImpl(docPath(account.project_id, path), {
    method: 'PATCH',
    headers: {
      authorization: 'Bearer ' + await accessToken(fetchImpl),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ fields: docFields(payload) }),
  });
  return res.ok;
}

/** Every session row for one child, across phone / camera / web, newest first. */
export async function querySessions(studentId, fetchImpl = globalThis.fetch) {
  const account = serviceAccount();
  const res = await fetchImpl(docPath(account.project_id, 'sessions') + ':runQuery', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + await accessToken(fetchImpl),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'sessions' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'student_id' }, op: 'EQUAL', value: { stringValue: studentId },
          },
        },
      },
    }),
  });
  if (!res.ok) return [];
  const body = await res.json();
  return (Array.isArray(body) ? body : [])
    .filter((r) => r.document)
    .map((r) => {
      const out = { doc: (r.document.name || '').split('/').pop() };
      for (const [k, v] of Object.entries(r.document.fields || {})) out[k] = fromValue(v);
      return out;
    })
    .sort((a, b) => (b.ended_at_wall_ms || 0) - (a.ended_at_wall_ms || 0));
}

/**
 * The HTTP entry point. POST {doc,payload} stores one finished session; GET ?student_id= reads one
 * child's rows back. Anything else is a 404 so a stray probe learns nothing.
 */
export async function handler(req, res, fetchImpl = globalThis.fetch) {
  const send = (code, body) => {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === 'POST') {
      let rec = {};
      for await (const chunk of req) rec = JSON.parse(chunk.toString() || '{}');
      if (!rec.doc || !rec.payload) return send(400, { error: 'doc and payload required' });
      // Only the sessions collection, only a -web- key: this endpoint must not become a general write
      // hole into the phone's or the camera's rows.
      if (!/-web-\d+$/.test(rec.doc)) return send(400, { error: 'refused doc key' });
      const ok = await setDocument('sessions/' + rec.doc, rec.payload, fetchImpl);
      return send(ok ? 200 : 502, { ok });
    }
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://local');
      const id = url.searchParams.get('student_id');
      if (!id) return send(400, { error: 'student_id required' });
      return send(200, { sessions: await querySessions(id, fetchImpl) });
    }
    return send(404, { error: 'not found' });
  } catch (e) {
    return send(500, { error: String(e && e.message || e) });
  }
}
