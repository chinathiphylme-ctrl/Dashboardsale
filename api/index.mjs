// Hylme Dashboard API — Neon Function (Node.js 24, ไม่มี dependency)  ·  deploy: ดู README
//
// ข้อมูลแต่ละรอบเก็บในตาราง snapshots (เก็บล่าสุด 20 รอบ):
//   public_gz  ชื่อ/เบอร์/ที่อยู่ลูกค้าเป็นค่าปลอมแล้ว — ใครก็อ่านได้ (หน้าเว็บสาธารณะ)
//   full_enc   ข้อมูลจริงเข้ารหัส AES-256-GCM ฝั่งเบราว์เซอร์ — server ถอดไม่ได้ และส่งให้เฉพาะคนที่พิสูจน์ว่ารู้รหัสผ่าน
//
// พิสูจน์รหัสผ่าน: เบราว์เซอร์ได้กุญแจจาก PBKDF2(รหัส, salt) แล้วส่ง token = HMAC(กุญแจ, "hylme-api-auth-v1")
// server เก็บแค่ sha256(token) ในตาราง vault -> ต่อให้ฐานข้อมูลหลุดก็ปลอม token / ถอดข้อมูลไม่ได้
//
//   GET  /meta              salt, iter, รอบล่าสุด                     (สาธารณะ)
//   GET  /public[?id=]      ข้อมูลที่ปิดชื่อ/เบอร์แล้ว                    (สาธารณะ)
//   GET  /full[?id=]        ข้อมูลจริงที่เข้ารหัส                         (ต้องมี token)
//   GET  /snapshots         รายการ 20 รอบล่าสุด                         (ต้องมี token)
//   POST /publish           บันทึกรอบใหม่                               (ต้องมี token)
//   POST /setup             ตั้งรหัสครั้งแรก (ต้องมี SETUP_CODE) / เปลี่ยนรหัส (ต้องมี token เดิม)
//
// คุยกับ Postgres ผ่าน SQL-over-HTTP ของ Neon (โปรโตคอลเดียวกับ @neondatabase/serverless) — ไม่ต้อง bundle ไลบรารี

import { createHash, timingSafeEqual } from 'node:crypto';

const KEEP = 20;
const MAX_BODY = 40 * 1024 * 1024;
const MAX_FAILS_IP = 20;         // รหัสผิดเกินนี้ใน 15 นาทีจาก IP เดียว -> ปฏิเสธ IP นั้นจนกว่าจะพ้นช่วง
const MAX_FAILS_ALL = 300;       // รวมทุก IP (กันการไล่เดารหัสจากหลายเครื่อง)

const DB_URL = process.env.DATABASE_URL || '';
const SQL_ENDPOINT = DB_URL ? `https://${new URL(DB_URL).hostname}/sql` : '';
const SQL_HEADERS = {
  'Neon-Connection-String': DB_URL, 'Neon-Raw-Text-Output': 'true', 'Neon-Array-Mode': 'false', 'Content-Type': 'application/json',
};
// ค่าทุกช่องกลับมาเป็นข้อความ (raw text) — แปลงชนิดเองตรงที่ใช้
async function sql(query, params = []) {
  const r = await fetch(SQL_ENDPOINT, { method: 'POST', headers: SQL_HEADERS, body: JSON.stringify({ query, params }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('db: ' + (body.message || r.status));
  return body.rows || [];
}
async function sqlTx(queries) {          // หลายคำสั่งใน transaction เดียว
  const r = await fetch(SQL_ENDPOINT, {
    method: 'POST', headers: { ...SQL_HEADERS, 'Neon-Batch-Isolation-Level': 'ReadCommitted' },
    body: JSON.stringify({ queries: queries.map(([query, params]) => ({ query, params: params || [] })) }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('db: ' + (body.message || r.status));
  return (body.results || []).map((x) => x.rows || []);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',          // ยืนยันตัวตนด้วย Bearer token ไม่ใช้ cookie จึงไม่มีปัญหา CSRF
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
});
const fail = (status, error) => json({ ok: false, error }, status);
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const META = 'id, created_at, source, bytes, file_count, order_count, note';
const meta = (r) => r && {
  id: Number(r.id), created_at: r.created_at, source: r.source, bytes: Number(r.bytes),
  file_count: r.file_count == null ? null : Number(r.file_count), order_count: r.order_count == null ? null : Number(r.order_count), note: r.note,
};

async function getVault() {
  const [v] = await sql('SELECT salt, iter, verifier FROM vault WHERE id = 1');
  return v ? { salt: v.salt, iter: Number(v.iter), verifier: v.verifier } : null;
}
const clientIp = (req) => (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
async function log(action, ok, req) {
  try { await sql('INSERT INTO auth_log (action, ok, ip) VALUES ($1, $2, $3)', [action, ok, clientIp(req)]); }
  catch (e) { console.warn('auth_log:', e.message); }
}
async function authorize(req, action, vault) {
  if (!vault) return { error: fail(503, 'ยังไม่ได้ตั้งรหัสผ่านของระบบ') };
  const [f] = await sql(
    "SELECT count(*) FILTER (WHERE ip = $1) AS mine, count(*) AS total FROM auth_log WHERE NOT ok AND at > now() - interval '15 minutes'",
    [clientIp(req)]);
  if (Number(f.mine) >= MAX_FAILS_IP || Number(f.total) >= MAX_FAILS_ALL) return { error: fail(429, 'ลองรหัสผิดหลายครั้งเกินไป — รอ 15 นาทีแล้วลองใหม่') };
  const m = /^Bearer ([A-Za-z0-9+/=_-]{20,200})$/.exec(req.headers.get('authorization') || '');
  const ok = !!m && timingSafeEqual(Buffer.from(sha256hex(m[1])), Buffer.from(vault.verifier));
  await log(action, ok, req);
  return ok ? {} : { error: fail(401, 'รหัสผ่านไม่ถูกต้อง') };
}
async function readJson(req) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_BODY) throw Object.assign(new Error('ข้อมูลใหญ่เกิน ' + MAX_BODY / 1048576 + ' MB'), { status: 413 });
  const text = await req.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error('ข้อมูลใหญ่เกิน'), { status: 413 });
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('JSON ไม่ถูกต้อง'), { status: 400 }); }
}
const isEnvelope = (e, salt) => e && typeof e === 'object' && e.hylmeEnc === 1 && typeof e.ct === 'string' && B64.test(e.ct)
  && typeof e.iv === 'string' && e.salt === salt;
const snapshotId = (url) => { const v = url.searchParams.get('id'); return v && /^\d{1,18}$/.test(v) ? v : null; };
async function pick(column, url) {
  const id = snapshotId(url);
  const [row] = id
    ? await sql(`SELECT ${META}, ${column} FROM snapshots WHERE id = $1`, [id])
    : await sql(`SELECT ${META}, ${column} FROM snapshots ORDER BY id DESC LIMIT 1`);
  return row || null;
}

async function route(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (method === 'GET' && (path === '/meta' || path === '/')) {
    const vault = await getVault();
    const [latest] = await sql(`SELECT ${META} FROM snapshots ORDER BY id DESC LIMIT 1`);
    return json({ ok: true, ready: !!vault, salt: vault && vault.salt, iter: vault && vault.iter, latest: meta(latest) || null });
  }
  if (method === 'GET' && path === '/public') {
    const row = await pick('public_gz', url);
    return row ? json({ ok: true, ...meta(row), public_gz: row.public_gz }) : fail(404, 'ยังไม่มีข้อมูล');
  }

  const vault = await getVault();
  if (method === 'GET' && path === '/full') {
    const a = await authorize(req, 'full', vault); if (a.error) return a.error;
    const row = await pick('full_enc', url);
    return row ? json({ ok: true, ...meta(row), full_enc: JSON.parse(row.full_enc) }) : fail(404, 'ยังไม่มีข้อมูล');
  }
  if (method === 'GET' && path === '/snapshots') {
    const a = await authorize(req, 'list', vault); if (a.error) return a.error;
    const rows = await sql(`SELECT ${META}, public_sha256 FROM snapshots ORDER BY id DESC LIMIT ${KEEP}`);
    return json({ ok: true, snapshots: rows.map((r) => ({ ...meta(r), public_sha256: r.public_sha256 })) });
  }
  if (method === 'POST' && path === '/publish') {
    const a = await authorize(req, 'publish', vault); if (a.error) return a.error;
    const b = await readJson(req);
    if (typeof b.public_gz !== 'string' || !B64.test(b.public_gz)) return fail(400, 'public_gz ไม่ถูกต้อง');
    // ข้อมูลจริงต้องเข้ารหัสด้วยรหัสผ่านชุดปัจจุบัน (salt ตรงกัน) ไม่อย่างนั้นจะไม่มีใครเปิดได้
    if (!isEnvelope(b.full_enc, vault.salt)) return fail(400, 'full_enc ไม่ได้เข้ารหัสด้วยรหัสผ่านปัจจุบัน');
    const source = ['dashboard', 'build', 'migrate'].includes(b.source) ? b.source : 'dashboard';
    const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
    const [[row]] = await sqlTx([
      [`INSERT INTO snapshots (source, public_gz, full_enc, public_sha256, bytes, file_count, order_count, note)
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8) RETURNING ${META}`,
        [source, b.public_gz, JSON.stringify(b.full_enc), sha256hex(b.public_gz), b.public_gz.length + b.full_enc.ct.length,
          int(b.file_count), int(b.order_count), typeof b.note === 'string' ? b.note.slice(0, 500) : null]],
      [`DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT ${KEEP})`],
      ["DELETE FROM auth_log WHERE at < now() - interval '180 days'"],
    ]);
    return json({ ok: true, snapshot: meta(row) });
  }
  if (method === 'POST' && path === '/setup') {
    const b = await readJson(req);
    if (vault) {
      const a = await authorize(req, 'rotate', vault); if (a.error) return a.error;        // เปลี่ยนรหัส: ต้องรู้รหัสเดิม
    } else {
      const code = process.env.SETUP_CODE || '';
      const ok = code.length >= 20 && typeof b.setup_code === 'string' && b.setup_code.length === code.length
        && timingSafeEqual(Buffer.from(b.setup_code), Buffer.from(code));
      await log('setup', ok, req);
      if (!ok) return fail(401, 'SETUP_CODE ไม่ถูกต้อง');
    }
    if (typeof b.salt !== 'string' || !B64.test(b.salt) || !Number.isInteger(b.iter) || b.iter < 100000
      || typeof b.verifier !== 'string' || !/^[0-9a-f]{64}$/.test(b.verifier)) return fail(400, 'salt / iter / verifier ไม่ถูกต้อง');
    await sql(
      `INSERT INTO vault (id, salt, iter, verifier, updated_at) VALUES (1, $1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET salt = EXCLUDED.salt, iter = EXCLUDED.iter, verifier = EXCLUDED.verifier, updated_at = now()`,
      [b.salt, b.iter, b.verifier]);
    return json({ ok: true, rotated: !!vault });
  }
  return fail(404, 'ไม่พบ ' + method + ' ' + path);
}

export default {
  async fetch(req) {
    try { return await route(req); }
    catch (e) {
      console.error(e);
      return fail(e.status || 500, e.status ? e.message : 'server error');
    }
  },
};
