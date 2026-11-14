// นำเข้า MKT cost (รายเพจ + แยกสินค้า) จากไฟล์ JSON เข้า database ของแดชบอร์ด เป็นรอบข้อมูลใหม่ (owner 14 พ.ย. 69)
//
//   node tools/ads_import.mjs private/ads_import_20261114.json            ดูอย่างเดียว: เทียบกับรอบล่าสุด (ไม่บันทึก)
//   node tools/ads_import.mjs private/ads_import_20261114.json --apply    บันทึกเป็นรอบใหม่
//
// JSON = {last_date, ads:[{date, page, cost, inq}], productAds:[{date, product, cost}]}
//   (ทำจากไฟล์ "Healme_2026_Report_Ads+ยอดขาย_MKT x SALE (เติมข้อมูล).xlsx")
// - แถวในไฟล์แทนแถวเดิมที่ วันที่|เพจ (วันที่|สินค้า) เดียวกัน · วันหลัง last_date ไม่แตะ
// - ยอดทักว่างในไฟล์ = ใช้ยอดทักเดิมใน database
// - ไฟล์ออเดอร์ / การแก้ออเดอร์ / ตีคืน และข้อมูลจริงที่เข้ารหัส ใช้ของรอบล่าสุดทั้งหมด (ไม่ถอด ไม่แก้)
// - at = เวลาที่นำเข้า -> ชนะสำเนาเก่าที่ค้างใน localStorage ของแต่ละเครื่อง
// - มีรอบใหม่เข้ามาระหว่างทำ (เช่น Pancake sync) = ไม่บันทึก ให้รันใหม่
import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'index.html');
const CFG = path.join(ROOT, 'private', 'neon.json');
const KEYF = path.join(ROOT, 'private', 'sync_key.json');
const LOG = path.join(ROOT, 'private', 'ads_import.log');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SRC = args.find((a) => !a.startsWith('--'));
const b64 = (s) => Buffer.from(s, 'base64');

function loadVault(html) {        // เฉพาะ HYLME VAULT ของหน้าเว็บ (token / gzip) — แบบเดียวกับ pancake_sync.mjs
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
async function publishSnapshot(cfg, body, token) {   // เหมือน pancake_sync.mjs: เกิน 8 MB ส่งเป็นชิ้นละ 4 MB
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
async function log(line) {
  const t = new Date(Date.now() + 7 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
  console.log(line);
  try { await appendFile(LOG, `${t} ${line}\n`, 'utf8'); } catch {}
}

const PAGES = ['Hylme', 'ไขมัน', 'นอน', 'ผิว'];
const PRODUCTS = ['Daily Oils', 'Mag 30', 'Gluta', 'EVOO(ข)', 'GABA', 'Mag 60', 'EVOO(ซ)', 'D3K2', 'Fiber'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const money = (v) => Math.round(v).toLocaleString('en-US');

async function main() {
  if (!SRC) throw new Error('ใส่ไฟล์ JSON ด้วย เช่น node tools/ads_import.mjs private/ads_import_20261114.json');
  const inp = JSON.parse(await readFile(path.resolve(SRC), 'utf8'));
  const last = String(inp.last_date || '');
  if (!DAY.test(last)) throw new Error('JSON ไม่มี last_date');
  // ตรวจไฟล์ก่อน: ชื่อเพจ/สินค้า วันที่ ตัวเลข และยอดรวมสองแบบต้องเท่ากันทุกวัน
  for (const r of inp.ads) if (!PAGES.includes(r.page) || !DAY.test(r.date) || !(r.cost >= 0) || r.date > last || (r.inq != null && !(r.inq >= 0))) throw new Error('แถวรายเพจไม่ถูกต้อง: ' + JSON.stringify(r));
  for (const r of inp.productAds) if (!PRODUCTS.includes(r.product) || !DAY.test(r.date) || !(r.cost >= 0) || r.date > last) throw new Error('แถวแยกสินค้าไม่ถูกต้อง: ' + JSON.stringify(r));
  const dayP = {}, dayQ = {};
  inp.ads.forEach((r) => { dayP[r.date] = (dayP[r.date] || 0) + r.cost; });
  inp.productAds.forEach((r) => { dayQ[r.date] = (dayQ[r.date] || 0) + r.cost; });
  const off = Object.keys({ ...dayP, ...dayQ }).filter((d) => Math.abs((dayP[d] || 0) - (dayQ[d] || 0)) >= 0.05);
  if (off.length) throw new Error('ยอดรายเพจกับแยกสินค้าไม่เท่ากัน ' + off.length + ' วัน เช่น ' + off.slice(0, 3).join(', '));

  const cfg = JSON.parse(await readFile(CFG, 'utf8')); cfg.api = String(cfg.api || '').replace(/\/+$/, '');
  const B = loadVault(await readFile(PAGE, 'utf8'));
  const saved = JSON.parse(await readFile(KEYF, 'utf8'));
  const key = await crypto.subtle.importKey('raw', b64(saved.k), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  const token = await B.authToken(key);

  const snaps = (await api(cfg, '/snapshots', { token })).snapshots || [];
  if (!snaps.length) throw new Error('ยังไม่มีข้อมูลใน database');
  const cur = snaps[0];
  const pubJ = await api(cfg, '/public?id=' + cur.id, { token });
  const full = await api(cfg, '/full?id=' + cur.id, { token });
  const pub = await B.gunzipJSON(pubJ.public_gz);
  const now = Date.now();

  const oldAds = pub.ads || [], oldProd = pub.productAds || [];
  const adsMap = new Map(oldAds.map((r) => [r.date + '|' + r.page, r]));
  let adsNew = 0, adsChanged = 0;
  for (const r of inp.ads) {
    const k = r.date + '|' + r.page, o = adsMap.get(k);
    const inq = r.inq != null ? r.inq : (o && o.inq != null ? o.inq : null);
    if (!o) adsNew++; else if (Math.abs(o.cost - r.cost) > 0.005 || (o.inq ?? null) !== inq) adsChanged++;
    const n = { date: r.date, page: r.page, cost: r.cost, at: now }; if (inq != null) n.inq = inq;
    adsMap.set(k, n);
  }
  const prodMap = new Map(oldProd.map((r) => [r.date + '|' + r.product, r]));
  let prodNew = 0, prodChanged = 0;
  for (const r of inp.productAds) {
    const k = r.date + '|' + r.product, o = prodMap.get(k);
    if (!o) prodNew++; else if (Math.abs(o.cost - r.cost) > 0.005) prodChanged++;
    prodMap.set(k, { date: r.date, product: r.product, cost: r.cost, at: now });
  }
  const ads = [...adsMap.values()].sort((a, b) => a.date.localeCompare(b.date) || a.page.localeCompare(b.page));
  const productAds = [...prodMap.values()].sort((a, b) => a.date.localeCompare(b.date) || a.product.localeCompare(b.product));

  // สรุปรายเดือน ก่อน -> หลัง
  const sumBy = (rows, f) => rows.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + r.cost; return m; }, {});
  const pb = sumBy(oldAds, (r) => r.date.slice(0, 7)), pa = sumBy(ads, (r) => r.date.slice(0, 7));
  const qb = sumBy(oldProd, (r) => r.date.slice(0, 7)), qa = sumBy(productAds, (r) => r.date.slice(0, 7));
  console.log(`รอบล่าสุดใน database: ${cur.id} (${cur.created_at})`);
  console.log('เดือน     รายเพจ ก่อน -> หลัง              แยกสินค้า ก่อน -> หลัง');
  for (const m of [...new Set([...Object.keys(pa), ...Object.keys(qa)])].sort())
    console.log(`${m}  ${money(pb[m] || 0).padStart(10)} -> ${money(pa[m] || 0).padStart(10)}   ${money(qb[m] || 0).padStart(10)} -> ${money(qa[m] || 0).padStart(10)}`);
  const pp = (rows) => sumBy(rows.filter((r) => r.date.startsWith('2026-11')), (r) => r.page || r.product);
  console.log('พ.ย. แยกสินค้า ก่อน', JSON.stringify(Object.fromEntries(Object.entries(pp(oldProd)).map(([k, v]) => [k, Math.round(v)]))));
  console.log('พ.ย. แยกสินค้า หลัง', JSON.stringify(Object.fromEntries(Object.entries(pp(productAds)).map(([k, v]) => [k, Math.round(v)]))));
  const summary = `MKT cost จากไฟล์เติมข้อมูล (ถึง ${last}) — รายเพจ ใหม่ ${adsNew} / เปลี่ยน ${adsChanged} แถว · แยกสินค้า ใหม่ ${prodNew} / เปลี่ยน ${prodChanged} แถว`;
  console.log(summary);
  if (!APPLY) { console.log('\nยังไม่ได้บันทึก — ถ้าตัวเลขถูกต้อง รันอีกครั้งพร้อม --apply'); return 0; }

  pub.ads = ads; pub.productAds = productAds;
  const after = (await api(cfg, '/snapshots', { token })).snapshots || [];
  if (!after.length || after[0].id !== cur.id) { await log('↷ ไม่บันทึก — มีรอบใหม่เข้ามาระหว่างทำ (รันใหม่อีกครั้ง)'); return 2; }
  const body = { source: 'build', public_gz: await B.gzipB64(pub), full_enc: full.full_enc,
    file_count: cur.file_count, order_count: cur.order_count, note: summary };
  const res = await publishSnapshot(cfg, body, token);
  await log(`✅ บันทึกรอบ ${res.snapshot.id} — ${summary}`);
  return 0;
}
main().then((c) => process.exit(c || 0)).catch(async (e) => { await log('❌ ' + e.message); process.exit(1); });
