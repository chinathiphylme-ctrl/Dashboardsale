// ย้ายแดชบอร์ดจาก Neon -> Supabase (17 พ.ย. 69 — Neon Free plan หมดโควตา อ่านข้อมูลเดิมไม่ได้จนถึง 1 ธ.ค.)
//
//   node tools/supabase_seed.mjs --verifier   แสดง salt / iter / verifier ของรหัสผู้ดูแลเดิม (จาก private/sync_key.json)
//                                             verifier = sha256(token) — ค่าที่ server เก็บ ไม่ใช่ความลับ ใช้ปลอม token ไม่ได้
//   node tools/supabase_seed.mjs              ดูอย่างเดียว: สร้างรอบแรกจากสำเนาใน CRM V3 แล้วตรวจข้อมูลหลุด (ไม่บันทึก)
//   node tools/supabase_seed.mjs --apply      บันทึกเป็นรอบแรกใน database ใหม่ (ทำได้เฉพาะตอน database ยังว่าง)
//
// ที่มาของรอบแรก: HYLME_CRM_V3/data/dash_feed/real.json.gz = รอบล่าสุดที่ CRM ดึง + ถอดรหัสไว้ (ข้อมูลจริงทั้งก้อน)
// ส่วนที่ทุกคนเห็นสร้างใหม่ด้วยตัวปิดชื่อ/เบอร์ของหน้าเว็บ (เหมือนปุ่ม "บันทึกลง Database") · ต้นทุน Ads ใส่ทีหลังด้วย ads_import
import { readFile, appendFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = path.join(ROOT, 'private', 'neon.json');
const KEYF = path.join(ROOT, 'private', 'sync_key.json');
const LOG = path.join(ROOT, 'private', 'pancake_sync.log');
const V3 = process.env.HYLME_V3_DIR || 'C:\\Users\\HP05\\Downloads\\HYLME_CRM_V3';
const REAL = path.join(V3, 'data', 'dash_feed', 'real.json.gz');
const SNAP = path.join(V3, 'data', 'dash_feed', 'snapshot.json');
const args = new Set(process.argv.slice(2));
const b64 = (s) => Buffer.from(s, 'base64');

async function log(line) {
  const t = new Date(Date.now() + 7 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
  console.log(line);
  try { await appendFile(LOG, `${t} ${line}\n`, 'utf8'); } catch {}
}
function loadVault(html) {
  const m = html.match(/<script>\s*(\/\* =+ HYLME VAULT[\s\S]*?)<\/script>/);
  if (!m) throw new Error('ไม่พบ HYLME VAULT ใน index.html');
  const ctx = vm.createContext({ crypto, TextEncoder, TextDecoder, Blob, Response, CompressionStream, DecompressionStream, atob, btoa, console });
  ctx.window = ctx; ctx.self = ctx;
  vm.runInContext(m[1], ctx);
  return ctx.HylmeVault._build;
}
async function api(cfg, p, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(cfg.api + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j.error || 'database ตอบ ' + r.status) + ` (${method} ${p})`), { status: r.status });
  return j;
}
async function publishSnapshot(cfg, body, token) {
  const PART = 4 * 1024 * 1024;
  if (body.public_gz.length + body.full_enc.ct.length < 8 * 1024 * 1024) return api(cfg, '/publish', { method: 'POST', body, token });
  const id = 'u' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const cut = (s) => { const out = []; for (let i = 0; i < s.length; i += PART) out.push(s.slice(i, i + PART)); return out; };
  const pub = cut(body.public_gz), ful = cut(body.full_enc.ct);
  for (const [field, list] of [['public_gz', pub], ['full_ct', ful]])
    for (let i = 0; i < list.length; i++) await api(cfg, '/publish-part', { method: 'POST', token, body: { upload_id: id, field, part: i, data: list[i] } });
  const env = { ...body.full_enc }; delete env.ct;
  return api(cfg, '/publish', { method: 'POST', token, body: { source: body.source, file_count: body.file_count, order_count: body.order_count,
    note: body.note, full_enc: env, parts: { upload_id: id, public: pub.length, full: ful.length } } });
}
// = orderEditsPublic() ในหน้าเว็บ: ส่วนที่ทุกคนเห็นไม่มีเหตุผล / ชื่อ / เบอร์
function orderEditsPublic(src) {
  src = src || {};
  const out = { edits: {}, log: [] };
  Object.entries(src.edits || {}).forEach(([k, e]) => {
    out.edits[k] = { pay: e.pay || null, date: e.date || null, count: typeof e.count === 'boolean' ? e.count : null, cust: !!(e.phone || e.name), at: e.at };
    if (e.amt > 0) { out.edits[k].amt = e.amt; out.edits[k].amtFrom = e.amtFrom ?? null; }
    if (e.qty) { out.edits[k].qty = e.qty; out.edits[k].qtyFrom = e.qtyFrom || null; }
  });
  out.log = (src.log || []).map((x) => ({ id: x.id, action: x.action, pay: x.pay || null, date: x.date || null, count: typeof x.count === 'boolean' ? x.count : null, at: x.at }));
  return out;
}

async function main() {
  const cfg = JSON.parse(await readFile(CFG, 'utf8'));
  cfg.api = String(cfg.api || '').replace(/\/+$/, '');
  const B = loadVault(await readFile(path.join(ROOT, 'index.html'), 'utf8'));
  const saved = JSON.parse(await readFile(KEYF, 'utf8'));
  const key = await crypto.subtle.importKey('raw', b64(saved.k), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  const token = await B.authToken(key);
  if (args.has('--verifier')) {
    console.log(JSON.stringify({ salt: saved.salt, iter: saved.iter, verifier: createHash('sha256').update(token).digest('hex') }));
    return 0;
  }
  if (!/supabase\.co/.test(cfg.api)) throw new Error('private/neon.json ยังชี้ไปที่ ' + cfg.api + ' — เปลี่ยน api เป็น Supabase ก่อน');
  const meta = await api(cfg, '/meta');
  if (!meta.ready) throw new Error('database ใหม่ยังไม่ได้ตั้งรหัสผู้ดูแล');
  if (meta.salt !== saved.salt || meta.iter !== saved.iter) throw new Error('salt ใน database ใหม่ไม่ตรงกับ sync_key.json');
  const snaps = (await api(cfg, '/snapshots', { token })).snapshots || [];
  if (snaps.length && !args.has('--force')) throw new Error(`database ใหม่มีข้อมูลแล้ว ${snaps.length} รอบ (ล่าสุด ${snaps[0].id}) — ไม่ต้องย้ายซ้ำ`);

  const src = JSON.parse(await readFile(SNAP, 'utf8'));
  const real = JSON.parse(gunzipSync(await readFile(REAL)));
  if (!Array.isArray(real.files) || !real.files.length) throw new Error('สำเนาใน CRM V3 ไม่มีไฟล์ข้อมูล');
  const base = { files: real.files, returnDecisions: real.returnDecisions, returnAdditions: real.returnAdditions };
  if (real.returns) base.returns = real.returns;
  const masker = B.makeMasker(await B.macKeyFor(key));
  const masked = masker.walk(base);
  const leaks = B.findLeaks(base, masked, masker.fakes());
  if (leaks.length) throw new Error('เจอข้อมูลจริงที่ยังไม่ถูกปิด ' + leaks.length + ' จุด — ไม่บันทึก');
  masked.orderEdits = orderEditsPublic(real.orderEdits);
  const realOut = { ...base, orderEdits: real.orderEdits };
  const orders = real.files.reduce((n, f) => n + ((f.leadsRows || []).length), 0);
  const body = {
    source: 'migrate', public_gz: await B.gzipB64(masked), full_enc: await B.encryptJSON(realOut, key, saved.salt, saved.iter),
    file_count: real.files.length, order_count: orders,
    note: `ย้ายจาก Neon -> Supabase: รอบ ${src.snapshot_id} (${src.created_at}) จากสำเนาใน CRM V3`,
  };
  const mb = ((body.public_gz.length + body.full_enc.ct.length) / 1048576).toFixed(1);
  console.log(`รอบต้นทาง: ${src.snapshot_id} · ${src.created_at} · ไฟล์ ${real.files.length} · ออเดอร์ ${orders.toLocaleString('en-US')} · ขนาด ~${mb} MB · ตรวจข้อมูลหลุด: ผ่าน`);
  if (!args.has('--apply')) { console.log('ยังไม่ได้บันทึก — รันอีกครั้งพร้อม --apply'); return 0; }
  const res = await publishSnapshot(cfg, body, token);
  await log(`✅ ย้ายไป Supabase — บันทึกรอบ ${res.snapshot.id} (จากรอบ Neon ${src.snapshot_id})`);
  return 0;
}
main().then((c) => process.exit(c || 0)).catch(async (e) => { await log('❌ supabase_seed: ' + e.message); process.exit(1); });
