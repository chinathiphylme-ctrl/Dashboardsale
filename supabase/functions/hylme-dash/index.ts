// Hylme Dashboard API — Supabase Edge Function (moved from the Neon Function api/index.mjs on 17 Nov 2026,
// when Neon's Free plan Functions allowance ran out). Same endpoints, same auth, same answers.
// Data: schema hylme_dash in project hylme-admin (not exposed through the public REST API).
//
// ข้อมูลแต่ละรอบเก็บในตาราง snapshots (เก็บล่าสุด KEEP รอบ):
//   public_gz  ชื่อ/เบอร์/ที่อยู่ลูกค้าเป็นค่าปลอมแล้ว
//   full_enc   ข้อมูลจริงเข้ารหัส AES-256-GCM ฝั่งเบราว์เซอร์ — server ถอดไม่ได้ ส่งให้เฉพาะ token ผู้ดูแล
// token = HMAC(PBKDF2(รหัส, salt), "hylme-api-auth-v1") · server เก็บแค่ sha256(token) ในตาราง vault
//
//   GET  /meta  · POST /login · GET /latest · GET /public[?id=] · GET /full[?id=] · GET /snapshots
//   POST /publish-part · POST /publish · POST /viewer · GET|POST /return-notes · POST /setup · POST /chunks
//
// deploy: Supabase MCP deploy_edge_function (verify_jwt: false — the function checks its own Bearer token)
import postgres from 'npm:postgres@3.4.5';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

const KEEP = 12;
const MAX_BODY = 40 * 1024 * 1024;
const PART_MAX = 6 * 1024 * 1024;
const MAX_FAILS_IP = 20;
const MAX_FAILS_ALL = 300;
const PREFIX = /^\/hylme-dash(?=\/|$)/;      // Supabase passes /hylme-dash/<path>

const db = postgres(Deno.env.get('SUPABASE_DB_URL') || '', { prepare: false, max: 3, idle_timeout: 20 });
// every value comes back as text (like Neon's raw-text mode) — cast in SQL, convert where used.
// JSON params go in as text and are cast with ::text::jsonb — a bare ::jsonb makes postgres.js encode the string twice
const sql = async (query: string, params: unknown[] = []) => (await db.unsafe(query, params as never[])) as Record<string, string>[];
const sqlTx = (queries: [string, unknown[]?][]) =>
  db.begin(async (t) => { const out = []; for (const [q, p] of queries) out.push(await t.unsafe(q, (p || []) as never[])); return out; }) as Promise<Record<string, string>[][]>;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey, x-client-info',
  'Access-Control-Max-Age': '86400',
};
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
});
const fail = (status: number, error: string) => json({ ok: false, error }, status);
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

// ---------- รอบแบบแบ่งก้อน (17 พ.ย. 69 — ประหยัด egress ของ Supabase Free) ----------
// ผู้บันทึกส่ง public_gz / full_enc.ct เป็น "HYC1|seg|seg|..."  seg = tag:id:base64
//   tag = f (ไฟล์ 1 ไฟล์ใน files) หรือ k.<ชื่อ> (ค่าอื่นระดับบนสุด) · id = HMAC ของเนื้อข้อมูล (ข้อมูลเดิม = id เดิม)
// server เก็บก้อนในตาราง chunks (ซ้ำกันเก็บครั้งเดียว) และเก็บใน snapshots แค่ "HYC1M|id,id,..."
//   GET /public, /full           ประกอบกลับเป็น "HYC1|..." (เครื่องมือเดิม)
//   GET /public?m=1, /full?m=1   ส่งแค่รายการ id — เบราว์เซอร์โหลดเฉพาะก้อนที่ยังไม่มีผ่าน POST /chunks
const SEG = /^(f|k\.[A-Za-z0-9_]{1,40}):([A-Za-z0-9_-]{22}):([A-Za-z0-9+/]+={0,2})$/;
const CHUNK_ID = /^[A-Za-z0-9_-]{22}$/;
const CHUNK_RESP_MAX = 8 * 1024 * 1024;
const isChunked = (s: unknown) => typeof s === 'string' && s.startsWith('HYC1|');
const isManifest = (s: unknown) => typeof s === 'string' && s.startsWith('HYC1M|');
const okData = (s: unknown) => typeof s === 'string' && s.length > 0 && (isChunked(s) || B64.test(s));
const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });
function splitSegs(s: string) {
  const ids: string[] = [], rows: [string, string][] = [], seen = new Set<string>();
  for (const seg of s.slice(5).split('|')) {
    const m = SEG.exec(seg);
    if (!m) throw bad('ข้อมูลแบบแบ่งก้อนไม่ถูกต้อง');
    ids.push(m[2]);
    if (!seen.has(m[2])) { seen.add(m[2]); rows.push([m[2], seg]); }
  }
  if (!ids.length) throw bad('ข้อมูลแบบแบ่งก้อนว่าง');
  return { ids, rows };
}
async function expand(s: string) {
  if (!isManifest(s)) return s;
  const ids = s.slice(6).split(',');
  const rows = await sql('SELECT id, seg FROM hylme_dash.chunks WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb))',
    [JSON.stringify([...new Set(ids)])]);
  const m = new Map(rows.map((r) => [r.id, r.seg]));
  const out = ids.map((id) => m.get(id));
  if (out.some((x) => x == null)) throw Object.assign(new Error('ข้อมูลรอบนี้ไม่ครบ (ก้อนข้อมูลหาย)'), { status: 500 });
  return 'HYC1|' + out.join('|');
}
const META = 'id, created_at::text AS created_at, source, bytes, file_count, order_count, note';
const num = (v: unknown) => (v == null ? null : Number(v));
const meta = (r: Record<string, string>) => r && {
  id: Number(r.id), created_at: r.created_at, source: r.source, bytes: Number(r.bytes),
  file_count: num(r.file_count), order_count: num(r.order_count), note: r.note,
};

type Vault = { salt: string; iter: number; verifier: string; viewerSalt: string | null; viewerVerifier: string | null };
async function getVault(): Promise<Vault | null> {
  const [v] = await sql('SELECT salt, iter, verifier, viewer_salt, viewer_verifier FROM hylme_dash.vault WHERE id = 1');
  return v ? { salt: v.salt, iter: Number(v.iter), verifier: v.verifier, viewerSalt: v.viewer_salt || null, viewerVerifier: v.viewer_verifier || null } : null;
}
const sameHex = (a?: string | null, b?: string | null) => !!a && !!b && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const roleOf = (token: string | null, vault: Vault) => {
  if (!token) return null;
  const h = sha256hex(token);
  if (sameHex(h, vault.verifier)) return 'admin';
  if (sameHex(h, vault.viewerVerifier)) return 'viewer';
  return null;
};
const clientIp = (req: Request) => (req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || '').split(',')[0].trim();
async function log(action: string, ok: boolean, req: Request) {
  try { await sql('INSERT INTO hylme_dash.auth_log (action, ok, ip) VALUES ($1, $2, $3)', [action, ok, clientIp(req)]); }
  catch (e) { console.warn('auth_log:', (e as Error).message); }
}
async function throttled(req: Request) {
  const [f] = await sql(
    "SELECT count(*) FILTER (WHERE ip = $1) AS mine, count(*) AS total FROM hylme_dash.auth_log WHERE NOT ok AND at > now() - interval '15 minutes'",
    [clientIp(req)]);
  return Number(f.mine) >= MAX_FAILS_IP || Number(f.total) >= MAX_FAILS_ALL;
}
const TOKEN_RE = /^[A-Za-z0-9+/=_-]{20,200}$/;
const bearer = (req: Request) => { const m = /^Bearer (\S+)$/.exec(req.headers.get('authorization') || ''); return m && TOKEN_RE.test(m[1]) ? m[1] : null; };
async function authorize(req: Request, action: string, vault: Vault | null, roles = ['admin']) {
  if (!vault) return { error: fail(503, 'ยังไม่ได้ตั้งรหัสผ่านของระบบ') };
  if (await throttled(req)) return { error: fail(429, 'ลองรหัสผิดหลายครั้งเกินไป — รอ 15 นาทีแล้วลองใหม่') };
  const role = roleOf(bearer(req), vault);
  const ok = !!role && roles.includes(role);
  await log(action, ok, req);
  if (ok) return { role };
  return { error: role ? fail(403, 'รหัสพนักงานใช้ส่วนนี้ไม่ได้ — ต้องใช้รหัสผู้ดูแล') : fail(401, 'รหัสผ่านไม่ถูกต้อง') };
}
async function readJson(req: Request) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_BODY) throw Object.assign(new Error('ข้อมูลใหญ่เกิน ' + MAX_BODY / 1048576 + ' MB'), { status: 413 });
  const text = await req.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error('ข้อมูลใหญ่เกิน'), { status: 413 });
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('JSON ไม่ถูกต้อง'), { status: 400 }); }
}
// deno-lint-ignore no-explicit-any
const isEnvelope = (e: any, salt: string) => e && typeof e === 'object' && e.hylmeEnc === 1 && okData(e.ct)
  && typeof e.iv === 'string' && e.salt === salt;
const snapshotId = (url: URL) => { const v = url.searchParams.get('id'); return v && /^\d{1,18}$/.test(v) ? v : null; };
async function pick(column: string, url: URL) {
  const id = snapshotId(url);
  const [row] = id
    ? await sql(`SELECT ${META}, ${column} FROM hylme_dash.snapshots WHERE id = $1`, [id])
    : await sql(`SELECT ${META}, ${column} FROM hylme_dash.snapshots ORDER BY id DESC LIMIT 1`);
  return row || null;
}
const PRUNE = `DELETE FROM hylme_dash.snapshots WHERE id NOT IN (SELECT id FROM hylme_dash.snapshots ORDER BY id DESC LIMIT ${KEEP})`;
const PRUNE_LOG = "DELETE FROM hylme_dash.auth_log WHERE at < now() - interval '180 days'";
const PRUNE_CHUNKS = `DELETE FROM hylme_dash.chunks c WHERE NOT EXISTS (
  SELECT 1 FROM hylme_dash.snapshots s WHERE c.id = ANY(s.pub_refs) OR c.id = ANY(s.full_refs))`;
const UPSERT_CHUNKS = `INSERT INTO hylme_dash.chunks (id, kind, seg) SELECT e->>0, $1, e->>1 FROM jsonb_array_elements($2::text::jsonb) e
  ON CONFLICT (id) DO UPDATE SET seg = EXCLUDED.seg WHERE hylme_dash.chunks.seg IS DISTINCT FROM EXCLUDED.seg`;

// บันทึกรอบ (ทั้งแบบส่งก้อนเดียวและแบบ /publish-part) — แบบแบ่งก้อนแยกเก็บลง chunks
// deno-lint-ignore no-explicit-any
async function storeSnapshot(o: { source: string; pub: string; env: any; ct: string; file_count: unknown; order_count: unknown; note: string | null; uploadId?: string }) {
  const P = isChunked(o.pub) ? splitSegs(o.pub) : null;
  const F = isChunked(o.ct) ? splitSegs(o.ct) : null;
  const env = { ...o.env, ct: F ? 'HYC1M|' + F.ids.join(',') : o.ct };
  const q: [string, unknown[]?][] = [['SELECT pg_advisory_xact_lock(74210117)', []]];
  if (P) q.push([UPSERT_CHUNKS, ['p', JSON.stringify(P.rows)]]);
  if (F) q.push([UPSERT_CHUNKS, ['f', JSON.stringify(F.rows)]]);
  const at = q.length;
  q.push([`INSERT INTO hylme_dash.snapshots (source, public_gz, full_enc, public_sha256, bytes, file_count, order_count, note, pub_refs, full_refs)
    VALUES ($1, $2, $3::text::jsonb, $4, $5, $6, $7, $8,
      ARRAY(SELECT jsonb_array_elements_text($9::text::jsonb)), ARRAY(SELECT jsonb_array_elements_text($10::text::jsonb))) RETURNING ${META}`,
    [o.source, P ? 'HYC1M|' + P.ids.join(',') : o.pub, JSON.stringify(env), sha256hex(o.pub), o.pub.length + o.ct.length,
      o.file_count, o.order_count, o.note, JSON.stringify(P ? P.ids : []), JSON.stringify(F ? F.ids : [])]]);
  if (o.uploadId) q.push(["DELETE FROM hylme_dash.publish_parts WHERE upload_id = $1 OR created_at < now() - interval '1 day'", [o.uploadId]]);
  q.push([PRUNE], [PRUNE_CHUNKS], [PRUNE_LOG]);
  const res = await sqlTx(q);
  return res[at][0];
}

async function route(req: Request) {
  const url = new URL(req.url);
  const path = url.pathname.replace(PREFIX, '').replace(/\/+$/, '') || '/';
  const method = req.method;
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const vault = await getVault();
  if (method === 'GET' && (path === '/meta' || path === '/')) {
    return json({ ok: true, ready: !!vault, salt: vault && vault.salt, iter: vault && vault.iter,
      viewer_salt: vault && vault.viewerVerifier ? vault.viewerSalt : null });
  }
  if (method === 'POST' && path === '/login') {
    if (!vault) return fail(503, 'ยังไม่ได้ตั้งรหัสผ่านของระบบ');
    if (await throttled(req)) return fail(429, 'ลองรหัสผิดหลายครั้งเกินไป — รอ 15 นาทีแล้วลองใหม่');
    const b = await readJson(req);
    const tokens = Array.isArray(b.tokens) ? b.tokens.filter((t: unknown) => typeof t === 'string' && TOKEN_RE.test(t)).slice(0, 2) : [];
    const roles = tokens.map((t: string) => roleOf(t, vault));
    const role = roles.includes('admin') ? 'admin' : roles.includes('viewer') ? 'viewer' : null;
    await log('login', !!role, req);
    return role ? json({ ok: true, role, index: roles.indexOf(role) }) : fail(401, 'รหัสผ่านไม่ถูกต้อง');
  }
  if (method === 'GET' && path === '/latest') {
    if (!vault) return fail(503, 'ยังไม่ได้ตั้งรหัสผ่านของระบบ');
    if (await throttled(req)) return fail(429, 'ลองรหัสผิดหลายครั้งเกินไป — รอ 15 นาทีแล้วลองใหม่');
    if (!roleOf(bearer(req), vault)) { await log('latest', false, req); return fail(401, 'รหัสผ่านไม่ถูกต้อง'); }
    const [row] = await sql('SELECT id, created_at::text AS created_at FROM hylme_dash.snapshots ORDER BY id DESC LIMIT 1');
    return row ? json({ ok: true, id: Number(row.id), created_at: row.created_at }) : fail(404, 'ยังไม่มีข้อมูล');
  }
  if (method === 'GET' && path === '/public') {
    const a = await authorize(req, 'public', vault, ['admin', 'viewer']); if (a.error) return a.error;
    const row = await pick('public_gz', url);
    if (!row) return fail(404, 'ยังไม่มีข้อมูล');
    return json({ ok: true, ...meta(row), public_gz: url.searchParams.get('m') === '1' ? row.public_gz : await expand(row.public_gz) });
  }
  if (method === 'POST' && path === '/chunks') {
    const b = await readJson(req);
    const kind = b.kind === 'p' || b.kind === 'f' ? b.kind : null;
    if (!kind) return fail(400, 'kind ไม่ถูกต้อง');
    const a = await authorize(req, 'chunks', vault, kind === 'f' ? ['admin'] : ['admin', 'viewer']); if (a.error) return a.error;
    const ids: string[] = Array.isArray(b.ids) ? [...new Set<string>(b.ids.filter((x: unknown) => typeof x === 'string' && CHUNK_ID.test(x)))].slice(0, 5000) : [];
    if (!ids.length) return fail(400, 'ids ไม่ถูกต้อง');
    const sizes = await sql('SELECT id, length(seg) AS n FROM hylme_dash.chunks WHERE kind = $1 AND id IN (SELECT jsonb_array_elements_text($2::text::jsonb))',
      [kind, JSON.stringify(ids)]);
    const sz = new Map(sizes.map((r) => [r.id, Number(r.n)]));
    const take: string[] = []; let total = 0;
    for (const id of ids) {
      const n = sz.get(id); if (n == null) continue;
      if (take.length && total + n > CHUNK_RESP_MAX) break;
      take.push(id); total += n;
    }
    const rows = take.length ? await sql('SELECT id, seg FROM hylme_dash.chunks WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb))', [JSON.stringify(take)]) : [];
    const chunks: Record<string, string> = {};
    rows.forEach((r) => { chunks[r.id] = r.seg; });
    return json({ ok: true, chunks, missing: ids.filter((id) => !sz.has(id)), more: ids.length - take.length - ids.filter((id) => !sz.has(id)).length });
  }
  if (method === 'GET' && path === '/return-notes') {
    const a = await authorize(req, 'rnotes', vault, ['admin', 'viewer']); if (a.error) return a.error;
    const rows = await sql('SELECT mc, cat, note, by_name, updated_at::text AS updated_at FROM hylme_dash.return_notes');
    const notes: Record<string, unknown> = {};
    rows.forEach((r) => { notes[r.mc] = { cat: r.cat, note: r.note, by: r.by_name, at: r.updated_at }; });
    return json({ ok: true, notes });
  }
  if (method === 'POST' && path === '/return-notes') {
    const a = await authorize(req, 'rnote-set', vault, ['admin', 'viewer']); if (a.error) return a.error;
    const b = await readJson(req);
    const mc = typeof b.mc === 'string' ? b.mc.trim().toUpperCase() : '';
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    if (!/^[A-Z0-9_-]{4,40}$/.test(mc)) return fail(400, 'เลข MC ไม่ถูกต้อง');
    const cat = str(b.cat, 60), note = str(b.note, 1000), by = str(b.by, 60);
    if (!cat && !note) {
      await sql('DELETE FROM hylme_dash.return_notes WHERE mc = $1', [mc]);
      return json({ ok: true, mc, deleted: true });
    }
    const [row] = await sql(
      `INSERT INTO hylme_dash.return_notes (mc, cat, note, by_name, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (mc) DO UPDATE SET cat = EXCLUDED.cat, note = EXCLUDED.note, by_name = EXCLUDED.by_name, updated_at = now()
       RETURNING mc, cat, note, by_name, updated_at::text AS updated_at`, [mc, cat, note, by]);
    return json({ ok: true, mc, note: { cat: row.cat, note: row.note, by: row.by_name, at: row.updated_at } });
  }
  if (method === 'POST' && path === '/viewer') {
    const a = await authorize(req, 'viewer-set', vault); if (a.error) return a.error;
    const b = await readJson(req);
    if (typeof b.viewer_salt !== 'string' || !B64.test(b.viewer_salt) || b.viewer_salt === vault!.salt
      || typeof b.viewer_verifier !== 'string' || !/^[0-9a-f]{64}$/.test(b.viewer_verifier)) return fail(400, 'viewer_salt / viewer_verifier ไม่ถูกต้อง');
    await sql('UPDATE hylme_dash.vault SET viewer_salt = $1, viewer_verifier = $2, updated_at = now() WHERE id = 1', [b.viewer_salt, b.viewer_verifier]);
    return json({ ok: true });
  }
  if (method === 'GET' && path === '/full') {
    const a = await authorize(req, 'full', vault); if (a.error) return a.error;
    const row = await pick('full_enc::text AS full_enc', url);
    if (!row) return fail(404, 'ยังไม่มีข้อมูล');
    // full_enc is already JSON text — splice it in instead of parse + stringify (several MB)
    const head = JSON.stringify({ ok: true, ...meta(row) });
    let envText = row.full_enc;
    if (envText.includes('"HYC1M|') && url.searchParams.get('m') !== '1') {
      const env = JSON.parse(envText);
      env.ct = await expand(env.ct);
      envText = JSON.stringify(env);
    }
    return new Response(head.slice(0, -1) + ',"full_enc":' + envText + '}', {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
    });
  }
  if (method === 'GET' && path === '/snapshots') {
    const a = await authorize(req, 'list', vault); if (a.error) return a.error;
    const rows = await sql(`SELECT ${META}, public_sha256 FROM hylme_dash.snapshots ORDER BY id DESC LIMIT ${KEEP}`);
    return json({ ok: true, snapshots: rows.map((r) => ({ ...meta(r), public_sha256: r.public_sha256 })) });
  }
  if (method === 'POST' && path === '/publish-part') {
    const a = await authorize(req, 'publish-part', vault); if (a.error) return a.error;
    const b = await readJson(req);
    if (typeof b.upload_id !== 'string' || !/^[a-z0-9-]{8,64}$/.test(b.upload_id)) return fail(400, 'upload_id ไม่ถูกต้อง');
    if (!['public_gz', 'full_ct'].includes(b.field)) return fail(400, 'field ไม่ถูกต้อง');
    if (!Number.isInteger(b.part) || b.part < 0 || b.part > 199) return fail(400, 'part ไม่ถูกต้อง');
    if (typeof b.data !== 'string' || !b.data.length || b.data.length > PART_MAX || !/^[A-Za-z0-9+/=|:._-]+$/.test(b.data)) return fail(400, 'data ไม่ถูกต้อง');
    await sql(`INSERT INTO hylme_dash.publish_parts (upload_id, field, part, data) VALUES ($1, $2, $3, $4)
               ON CONFLICT (upload_id, field, part) DO UPDATE SET data = EXCLUDED.data, created_at = now()`, [b.upload_id, b.field, b.part, b.data]);
    return json({ ok: true, part: b.part });
  }
  if (method === 'POST' && path === '/publish') {
    const a = await authorize(req, 'publish', vault); if (a.error) return a.error;
    const b = await readJson(req);
    const source = ['dashboard', 'build', 'migrate'].includes(b.source) ? b.source : 'dashboard';
    const int = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? v : null);
    const note = typeof b.note === 'string' ? b.note.slice(0, 500) : null;
    if (b.parts) {
      const p = b.parts;
      if (typeof p.upload_id !== 'string' || !/^[a-z0-9-]{8,64}$/.test(p.upload_id) || !Number.isInteger(p.public) || !Number.isInteger(p.full)
        || p.public < 1 || p.full < 1) return fail(400, 'parts ไม่ถูกต้อง');
      const env = b.full_enc;
      if (!(env && typeof env === 'object' && env.hylmeEnc === 1 && typeof env.iv === 'string' && env.salt === vault!.salt && env.ct === undefined))
        return fail(400, 'full_enc ไม่ได้เข้ารหัสด้วยรหัสผ่านปัจจุบัน');
      const got = await sql(`SELECT field, count(*) AS n, max(part) AS mx, string_agg(data, '' ORDER BY part) AS d
        FROM hylme_dash.publish_parts WHERE upload_id = $1 GROUP BY field`, [p.upload_id]);
      const has = (f: string, n: number) => got.find((r) => r.field === f && Number(r.n) === n && Number(r.mx) === n - 1);
      const gp = has('public_gz', p.public), gf = has('full_ct', p.full);
      if (!gp || !gf) return fail(400, 'ได้รับข้อมูลไม่ครบทุกชิ้น — ลองบันทึกใหม่');
      if (!okData(gp.d) || !okData(gf.d)) return fail(400, 'ข้อมูลที่ส่งมาไม่ถูกต้อง');
      const row = await storeSnapshot({ source, pub: gp.d, env, ct: gf.d, file_count: int(b.file_count), order_count: int(b.order_count),
        note, uploadId: p.upload_id });
      return json({ ok: true, snapshot: meta(row) });
    }
    if (!okData(b.public_gz)) return fail(400, 'public_gz ไม่ถูกต้อง');
    if (!isEnvelope(b.full_enc, vault!.salt)) return fail(400, 'full_enc ไม่ได้เข้ารหัสด้วยรหัสผ่านปัจจุบัน');
    const env = { ...b.full_enc }; delete env.ct;
    const row = await storeSnapshot({ source, pub: b.public_gz, env, ct: b.full_enc.ct, file_count: int(b.file_count),
      order_count: int(b.order_count), note });
    return json({ ok: true, snapshot: meta(row) });
  }
  if (method === 'POST' && path === '/setup') {
    const b = await readJson(req);
    if (vault) {
      const a = await authorize(req, 'rotate', vault); if (a.error) return a.error;
    } else {
      const code = Deno.env.get('SETUP_CODE') || '';
      const ok = code.length >= 20 && typeof b.setup_code === 'string' && b.setup_code.length === code.length
        && timingSafeEqual(Buffer.from(b.setup_code), Buffer.from(code));
      await log('setup', ok, req);
      if (!ok) return fail(401, 'SETUP_CODE ไม่ถูกต้อง');
    }
    if (typeof b.salt !== 'string' || !B64.test(b.salt) || !Number.isInteger(b.iter) || b.iter < 100000
      || typeof b.verifier !== 'string' || !/^[0-9a-f]{64}$/.test(b.verifier)) return fail(400, 'salt / iter / verifier ไม่ถูกต้อง');
    await sql(
      `INSERT INTO hylme_dash.vault (id, salt, iter, verifier, updated_at) VALUES (1, $1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET salt = EXCLUDED.salt, iter = EXCLUDED.iter, verifier = EXCLUDED.verifier, updated_at = now()`,
      [b.salt, b.iter, b.verifier]);
    return json({ ok: true, rotated: !!vault });
  }
  return fail(404, 'ไม่พบ ' + method + ' ' + path);
}

Deno.serve(async (req) => {
  try { return await route(req); }
  catch (e) {
    console.error(e);
    const err = e as Error & { status?: number };
    return fail(err.status || 500, err.status ? err.message : 'server error');
  }
});
