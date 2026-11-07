// Hylme Dashboard API — Neon Function (Node.js 24, ไม่มี dependency)  ·  deploy: ดู README
//
// ข้อมูลแต่ละรอบเก็บในตาราง snapshots (เก็บล่าสุด 20 รอบ):
//   public_gz  ชื่อ/เบอร์/ที่อยู่ลูกค้าเป็นค่าปลอมแล้ว — ใครก็อ่านได้ (หน้าเว็บสาธารณะ)
//   full_enc   ข้อมูลจริงเข้ารหัส AES-256-GCM ฝั่งเบราว์เซอร์ — server ถอดไม่ได้ และส่งให้เฉพาะคนที่พิสูจน์ว่ารู้รหัสผ่าน
//
// พิสูจน์รหัสผ่าน: เบราว์เซอร์ได้กุญแจจาก PBKDF2(รหัส, salt) แล้วส่ง token = HMAC(กุญแจ, "hylme-api-auth-v1")
// server เก็บแค่ sha256(token) ในตาราง vault -> ต่อให้ฐานข้อมูลหลุดก็ปลอม token / ถอดข้อมูลไม่ได้
//
// ทั้งเว็บล็อก (6 พ.ย. 69): ต้อง login ก่อนเห็นอะไร มี 2 รหัส
//   รหัสพนักงาน (viewer)  เห็นข้อมูลที่ปิดชื่อ/เบอร์แล้ว — token แบบเดียวกันแต่ใช้ viewer_salt ของตัวเอง
//   รหัสผู้ดูแล (admin)    รหัสเดิม — เห็นทุกอย่าง + ข้อมูลจริง / บันทึก / ตั้งรหัสพนักงาน
//   ยังไม่ได้ตั้งรหัสพนักงาน = เข้าได้เฉพาะรหัสผู้ดูแล (ไม่เปิดให้ใครเข้าโดยไม่มีรหัส)
//
//   GET  /meta              salt, iter, viewer_salt (ไว้คำนวณ token)   (สาธารณะ — ไม่มีข้อมูลขาย)
//   POST /login             {tokens:[...]} -> role ของ token ที่ถูก   (นับเป็นการลองรหัส 1 ครั้ง)
//   GET  /public[?id=]      ข้อมูลที่ปิดชื่อ/เบอร์แล้ว                    (token พนักงาน หรือ ผู้ดูแล)
//   GET  /full[?id=]        ข้อมูลจริงที่เข้ารหัส                         (token ผู้ดูแล)
//   GET  /snapshots         รายการ 20 รอบล่าสุด                         (token ผู้ดูแล)
//   POST /publish           บันทึกรอบใหม่                               (token ผู้ดูแล)
//                           ก้อนใหญ่: POST /publish-part {upload_id, field: public_gz|full_ct, part, data} ทีละชิ้น (≤ 4 MB)
//                           แล้ว POST /publish {parts:{upload_id, public, full}, full_enc: (ไม่มี ct), …} — คำขอเดียวเกิน 10 MB ไม่ได้
//   POST /viewer            ตั้ง/เปลี่ยนรหัสพนักงาน {viewer_salt, viewer_verifier}   (token ผู้ดูแล)
//   GET  /return-notes      เหตุผลตีคืนที่ทีมใส่ {mc: {cat, note, by, at}}           (token พนักงาน หรือ ผู้ดูแล)
//   POST /return-notes      ใส่/แก้เหตุผลตีคืน 1 ออเดอร์ {mc, cat, note, by} — cat+note ว่าง = ลบ   (token พนักงาน หรือ ผู้ดูแล)
//   POST /setup             ตั้งรหัสครั้งแรก (ต้องมี SETUP_CODE) / เปลี่ยนรหัส (ต้องมี token เดิม)
//
// คุยกับ Postgres ผ่าน SQL-over-HTTP ของ Neon (โปรโตคอลเดียวกับ @neondatabase/serverless) — ไม่ต้อง bundle ไลบรารี

import { createHash, timingSafeEqual } from 'node:crypto';

const KEEP = 20;
const MAX_BODY = 40 * 1024 * 1024;
const PART_MAX = 6 * 1024 * 1024;   // ชิ้นละไม่เกินนี้ (หน้าเว็บส่งชิ้นละ 4 MB) — คำขอทั้งก้อนต้องไม่เกิน 10 MB ของ Neon Functions
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
  const [v] = await sql('SELECT salt, iter, verifier, viewer_salt, viewer_verifier FROM vault WHERE id = 1');
  return v ? { salt: v.salt, iter: Number(v.iter), verifier: v.verifier, viewerSalt: v.viewer_salt || null, viewerVerifier: v.viewer_verifier || null } : null;
}
const sameHex = (a, b) => !!a && !!b && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const roleOf = (token, vault) => {          // admin ชนะ viewer
  if (!token) return null;
  const h = sha256hex(token);
  if (sameHex(h, vault.verifier)) return 'admin';
  if (sameHex(h, vault.viewerVerifier)) return 'viewer';
  return null;
};
const clientIp = (req) => (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
async function log(action, ok, req) {
  try { await sql('INSERT INTO auth_log (action, ok, ip) VALUES ($1, $2, $3)', [action, ok, clientIp(req)]); }
  catch (e) { console.warn('auth_log:', e.message); }
}
async function throttled(req) {
  const [f] = await sql(
    "SELECT count(*) FILTER (WHERE ip = $1) AS mine, count(*) AS total FROM auth_log WHERE NOT ok AND at > now() - interval '15 minutes'",
    [clientIp(req)]);
  return Number(f.mine) >= MAX_FAILS_IP || Number(f.total) >= MAX_FAILS_ALL;
}
const TOKEN_RE = /^[A-Za-z0-9+/=_-]{20,200}$/;
// roles = role ที่ใช้ทางนี้ได้ (ค่าเริ่มต้น: ผู้ดูแลเท่านั้น)
async function authorize(req, action, vault, roles = ['admin']) {
  if (!vault) return { error: fail(503, 'ยังไม่ได้ตั้งรหัสผ่านของระบบ') };
  if (await throttled(req)) return { error: fail(429, 'ลองรหัสผิดหลายครั้งเกินไป — รอ 15 นาทีแล้วลองใหม่') };
  const m = /^Bearer (\S+)$/.exec(req.headers.get('authorization') || '');
  const role = m && TOKEN_RE.test(m[1]) ? roleOf(m[1], vault) : null;
  const ok = !!role && roles.includes(role);
  await log(action, ok, req);
  if (ok) return { role };
  return { error: role ? fail(403, 'รหัสพนักงานใช้ส่วนนี้ไม่ได้ — ต้องใช้รหัสผู้ดูแล') : fail(401, 'รหัสผ่านไม่ถูกต้อง') };
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

  const vault = await getVault();
  if (method === 'GET' && (path === '/meta' || path === '/')) {
    return json({ ok: true, ready: !!vault, salt: vault && vault.salt, iter: vault && vault.iter,
      viewer_salt: vault && vault.viewerVerifier ? vault.viewerSalt : null });
  }
  if (method === 'POST' && path === '/login') {
    if (!vault) return fail(503, 'ยังไม่ได้ตั้งรหัสผ่านของระบบ');
    if (await throttled(req)) return fail(429, 'ลองรหัสผิดหลายครั้งเกินไป — รอ 15 นาทีแล้วลองใหม่');
    const b = await readJson(req);
    const tokens = Array.isArray(b.tokens) ? b.tokens.filter((t) => typeof t === 'string' && TOKEN_RE.test(t)).slice(0, 2) : [];
    const roles = tokens.map((t) => roleOf(t, vault));
    const role = roles.includes('admin') ? 'admin' : roles.includes('viewer') ? 'viewer' : null;
    await log('login', !!role, req);
    return role ? json({ ok: true, role, index: roles.indexOf(role) }) : fail(401, 'รหัสผ่านไม่ถูกต้อง');
  }
  if (method === 'GET' && path === '/public') {
    const a = await authorize(req, 'public', vault, ['admin', 'viewer']); if (a.error) return a.error;
    const row = await pick('public_gz', url);
    return row ? json({ ok: true, ...meta(row), public_gz: row.public_gz }) : fail(404, 'ยังไม่มีข้อมูล');
  }
  // เหตุผลตีคืน (หน้า "ตีคืน MC") — ทีมใส่ได้ทันทีไม่ต้องรอผู้ดูแลกดบันทึกรอบข้อมูล
  if (method === 'GET' && path === '/return-notes') {
    const a = await authorize(req, 'rnotes', vault, ['admin', 'viewer']); if (a.error) return a.error;
    const rows = await sql('SELECT mc, cat, note, by_name, updated_at FROM return_notes');
    const notes = {};
    rows.forEach((r) => { notes[r.mc] = { cat: r.cat, note: r.note, by: r.by_name, at: r.updated_at }; });
    return json({ ok: true, notes });
  }
  if (method === 'POST' && path === '/return-notes') {
    const a = await authorize(req, 'rnote-set', vault, ['admin', 'viewer']); if (a.error) return a.error;
    const b = await readJson(req);
    const mc = typeof b.mc === 'string' ? b.mc.trim().toUpperCase() : '';
    const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    if (!/^[A-Z0-9_-]{4,40}$/.test(mc)) return fail(400, 'เลข MC ไม่ถูกต้อง');
    const cat = str(b.cat, 60), note = str(b.note, 1000), by = str(b.by, 60);
    if (!cat && !note) {
      await sql('DELETE FROM return_notes WHERE mc = $1', [mc]);
      return json({ ok: true, mc, deleted: true });
    }
    const [row] = await sql(
      `INSERT INTO return_notes (mc, cat, note, by_name, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (mc) DO UPDATE SET cat = EXCLUDED.cat, note = EXCLUDED.note, by_name = EXCLUDED.by_name, updated_at = now()
       RETURNING mc, cat, note, by_name, updated_at`, [mc, cat, note, by]);
    return json({ ok: true, mc, note: { cat: row.cat, note: row.note, by: row.by_name, at: row.updated_at } });
  }
  if (method === 'POST' && path === '/viewer') {
    const a = await authorize(req, 'viewer-set', vault); if (a.error) return a.error;
    const b = await readJson(req);
    if (typeof b.viewer_salt !== 'string' || !B64.test(b.viewer_salt) || b.viewer_salt === vault.salt
      || typeof b.viewer_verifier !== 'string' || !/^[0-9a-f]{64}$/.test(b.viewer_verifier)) return fail(400, 'viewer_salt / viewer_verifier ไม่ถูกต้อง');
    await sql('UPDATE vault SET viewer_salt = $1, viewer_verifier = $2, updated_at = now() WHERE id = 1', [b.viewer_salt, b.viewer_verifier]);
    return json({ ok: true });
  }

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
  // ส่งเป็นชิ้น (7 พ.ย. 69): Neon Functions รับคำขอได้ไม่เกิน 10 MB (เกิน = 413 ก่อนถึงโค้ดนี้ เบราว์เซอร์เห็นเป็น "ติดต่อไม่ได้")
  // รอบข้อมูลโตถึง 9.9 MB แล้ว -> หน้าเว็บ / ตัวอัปเดตอัตโนมัติส่ง public_gz และ full_enc.ct เป็นชิ้นละ ≤ 4 MB มาก่อน
  // แล้ว POST /publish ด้วย parts:{upload_id, public, full} — database ประกอบชิ้นเองใน SQL (ไม่ส่งก้อนใหญ่กลับไปมา)
  if (method === 'POST' && path === '/publish-part') {
    const a = await authorize(req, 'publish-part', vault); if (a.error) return a.error;
    const b = await readJson(req);
    if (typeof b.upload_id !== 'string' || !/^[a-z0-9-]{8,64}$/.test(b.upload_id)) return fail(400, 'upload_id ไม่ถูกต้อง');
    if (!['public_gz', 'full_ct'].includes(b.field)) return fail(400, 'field ไม่ถูกต้อง');
    if (!Number.isInteger(b.part) || b.part < 0 || b.part > 199) return fail(400, 'part ไม่ถูกต้อง');
    if (typeof b.data !== 'string' || !b.data.length || b.data.length > PART_MAX || !B64.test(b.data)) return fail(400, 'data ไม่ถูกต้อง');
    await sql(`INSERT INTO publish_parts (upload_id, field, part, data) VALUES ($1, $2, $3, $4)
               ON CONFLICT (upload_id, field, part) DO UPDATE SET data = EXCLUDED.data, created_at = now()`, [b.upload_id, b.field, b.part, b.data]);
    return json({ ok: true, part: b.part });
  }
  if (method === 'POST' && path === '/publish') {
    const a = await authorize(req, 'publish', vault); if (a.error) return a.error;
    const b = await readJson(req);
    const source = ['dashboard', 'build', 'migrate'].includes(b.source) ? b.source : 'dashboard';
    const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
    const note = typeof b.note === 'string' ? b.note.slice(0, 500) : null;
    if (b.parts) {
      const p = b.parts;
      if (typeof p.upload_id !== 'string' || !/^[a-z0-9-]{8,64}$/.test(p.upload_id) || !Number.isInteger(p.public) || !Number.isInteger(p.full)
        || p.public < 1 || p.full < 1) return fail(400, 'parts ไม่ถูกต้อง');
      const env = b.full_enc;
      if (!(env && typeof env === 'object' && env.hylmeEnc === 1 && typeof env.iv === 'string' && env.salt === vault.salt && env.ct === undefined))
        return fail(400, 'full_enc ไม่ได้เข้ารหัสด้วยรหัสผ่านปัจจุบัน');
      const got = await sql('SELECT field, count(*) AS n, max(part) AS mx FROM publish_parts WHERE upload_id = $1 GROUP BY field', [p.upload_id]);
      const has = (f, n) => got.some((r) => r.field === f && Number(r.n) === n && Number(r.mx) === n - 1);
      if (!has('public_gz', p.public) || !has('full_ct', p.full)) return fail(400, 'ได้รับข้อมูลไม่ครบทุกชิ้น — ลองบันทึกใหม่');
      const [[row]] = await sqlTx([
        [`INSERT INTO snapshots (source, public_gz, full_enc, public_sha256, bytes, file_count, order_count, note)
          SELECT $1, pub.d, $2::jsonb || jsonb_build_object('ct', ful.d), encode(sha256(convert_to(pub.d, 'UTF8')), 'hex'),
                 length(pub.d) + length(ful.d), $3, $4, $5
          FROM (SELECT string_agg(data, '' ORDER BY part) AS d FROM publish_parts WHERE upload_id = $6 AND field = 'public_gz') pub,
               (SELECT string_agg(data, '' ORDER BY part) AS d FROM publish_parts WHERE upload_id = $6 AND field = 'full_ct') ful
          RETURNING ${META}`,
          [source, JSON.stringify(env), int(b.file_count), int(b.order_count), note, p.upload_id]],
        ["DELETE FROM publish_parts WHERE upload_id = $1 OR created_at < now() - interval '1 day'", [p.upload_id]],
        [`DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT ${KEEP})`],
        ["DELETE FROM auth_log WHERE at < now() - interval '180 days'"],
      ]);
      return json({ ok: true, snapshot: meta(row) });
    }
    if (typeof b.public_gz !== 'string' || !B64.test(b.public_gz)) return fail(400, 'public_gz ไม่ถูกต้อง');
    // ข้อมูลจริงต้องเข้ารหัสด้วยรหัสผ่านชุดปัจจุบัน (salt ตรงกัน) ไม่อย่างนั้นจะไม่มีใครเปิดได้
    if (!isEnvelope(b.full_enc, vault.salt)) return fail(400, 'full_enc ไม่ได้เข้ารหัสด้วยรหัสผ่านปัจจุบัน');
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
