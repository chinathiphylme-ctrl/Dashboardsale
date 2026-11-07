// อัปเดตออเดอร์ Pancake เข้า database ของแดชบอร์ดอัตโนมัติ (owner 6 พ.ย. 69 — ทุก 30 นาที)
//
//   node tools/pancake_sync.mjs --setup     ครั้งแรกครั้งเดียว: พิมพ์รหัสผู้ดูแล -> เก็บ "กุญแจ" (ไม่ใช่รหัสผ่าน) ไว้ที่ private/sync_key.json
//   node tools/pancake_sync.mjs             ดึง Pancake API -> แปลงด้วยโค้ดของหน้าเว็บ -> ตรวจ -> บันทึกลง database (เฉพาะเมื่อมีออเดอร์เปลี่ยน)
//   node tools/pancake_sync.mjs --dry-run   ทำทุกขั้น แต่ไม่บันทึก
//
// ข้อมูลเดิมต้องไม่เสีย (owner: "เอาให้ข้อมูลผมไม่เปลี่ยนจนมันเสียก็พอ"):
//   - ไม่ลบไฟล์ใด ๆ — แทนที่เฉพาะไฟล์ "Pancake API (อัตโนมัติ)" ของรอบก่อน แล้ววางไว้ท้ายสุด
//     (ออเดอร์เดียวกัน ไฟล์หลังชนะ ทั้งหัวออเดอร์และรายการสินค้า — ดูกติกา pkProdFile ใน index.html)
//   - ไฟล์ Excel / ads / การแก้ออเดอร์ / ทะเบียนยกเลิก-ตีคืน / ตีคืน MC อยู่ครบเหมือนเดิม
//   - ออเดอร์ที่ยกเลิกใน Pancake ไม่ถูกเขียน -> แดชบอร์ดยังนับตามเดิมจนกว่าผู้ดูแลจะยกเลิกด้วยเครื่องมือเดิม
//   - ตัวกันก่อนบันทึก: ออเดอร์รวมห้ามลด · ยอดรวมของวันที่ผ่านไปแล้ว (เกิน 2 วัน) เปลี่ยนได้ไม่เกิน ฿3,000 และไม่เกิน 1%
//     · ออเดอร์ที่ยอดเปลี่ยนเกิน 50% ไม่เกิน 30 ใบ · สแกนข้อมูลหลุดแบบเดียวกับปุ่ม "บันทึกลง Database" — ไม่ผ่าน = ไม่บันทึก
//   - มีคนกดบันทึกจากหน้าเว็บระหว่างรอบ = ข้ามรอบนี้ (ไม่ทับงานของคนอื่น)
//   - database เก็บ 20 รอบล่าสุด — บันทึกเฉพาะเมื่อออเดอร์เปลี่ยน
// ไฟล์ออเดอร์มาจาก HYLME_CRM_V3\tools\pancake_export.py (ตัวเดียวกับที่ใช้ตรวจเทียบกับข้อมูลเดิม)
import { readFile, writeFile, appendFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'index.html');
const CFG = path.join(ROOT, 'private', 'neon.json');
const KEYF = path.join(ROOT, 'private', 'sync_key.json');
const LOG = path.join(ROOT, 'private', 'pancake_sync.log');
const V3 = process.env.HYLME_V3_DIR || 'C:\\Users\\HP05\\Downloads\\HYLME_CRM_V3';
const AUTO_NAME = 'Pancake API (อัตโนมัติ)';
const DAYS = 45;
const run = promisify(execFile);
const args = new Set(process.argv.slice(2));
const b64 = (s) => Buffer.from(s, 'base64');

async function log(line) {
  const t = new Date(Date.now() + 7 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
  console.log(line);
  try { await mkdir(path.dirname(LOG), { recursive: true }); await appendFile(LOG, `${t} ${line}\n`, 'utf8'); } catch {}
}

// ---------- โค้ดของหน้าเว็บ: VAULT (ปิดชื่อ/เบอร์ + เข้ารหัส) และตัวแปลงไฟล์ Pancake ----------
function loadPage(html) {
  const grab = (re, what) => { const m = html.match(re); if (!m) throw new Error('ไม่พบ ' + what + ' ใน index.html'); return m[1] || m[0]; };
  const vault = grab(/<script>\s*(\/\* =+ HYLME VAULT[\s\S]*?)<\/script>/, 'HYLME VAULT');
  const prov = grab(/^const THAI_PROVINCES = [\s\S]*?\.sort\([^\n]*\);?$/m, 'THAI_PROVINCES');
  const findProv = grab(/^function findProvinceInText\(text\)\{[\s\S]*?\n\}/m, 'findProvinceInText');
  const findZip = html.match(/^function findZipInText\([^)]*\)\s*\{[\s\S]*?\n\}/m);
  const split = grab(/^function splitGross\([\s\S]*?\n\}/m, 'splitGross');
  const pancake = grab(/(\/\* =+ PANCAKE IMPORT =+[\s\S]*?)\/\* =+ MYCLOUD \(MC\) EXPORT CONVERTER/, 'PANCAKE IMPORT');
  const vat = html.match(/^const VAT_RATE = [^;\n]+;/m);
  const r2 = grab(/^const grossR2 = [^\n]+$/m, 'grossR2');
  const ctx = vm.createContext({ crypto, TextEncoder, TextDecoder, Blob, Response, CompressionStream, DecompressionStream, atob, btoa, console });
  ctx.window = ctx; ctx.self = ctx;
  vm.runInContext(readXlsxLib(), ctx);
  vm.runInContext([vat ? vat[0] : 'const VAT_RATE = 0.07;', r2, prov, findProv, findZip ? findZip[0] : '', split, pancake,
    'globalThis.findProvinceInText = findProvinceInText; globalThis.__pk = { isPancakeWorkbook, convertPancakeData };'].join('\n'), ctx);
  vm.runInContext(vault, ctx);
  return { HV: ctx.HylmeVault, pk: ctx.__pk, XLSX: ctx.XLSX };
}
let xlsxSrc = null;
function readXlsxLib() { return xlsxSrc; }

// ---------- database ----------
async function api(cfg, p, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(cfg.api + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j.error || 'database ตอบ ' + r.status) + ` (${method} ${p})`), { status: r.status });
  return j;
}
// Neon Functions รับคำขอได้ไม่เกิน 10 MB -> ก้อนเกิน 8 MB ส่งเป็นชิ้นละ 4 MB แล้วสั่งประกอบ (เหมือนปุ่มในหน้าเว็บ)
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
function ask(question) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let answered = false;
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.on('close', () => { if (!answered) reject(new Error('ยกเลิก — ไม่ได้ใส่รหัสผ่าน')); });
    rl.question(question, (ans) => { answered = true; rl.close(); process.stdout.write('\n'); resolve(ans); });
  });
}

// ---------- สรุปยอดรายวันของออเดอร์ Pancake (ไฟล์หลังชนะ) ไว้เทียบก่อน/หลัง ----------
function pancakeDays(files) {
  const lead = new Map();
  files.forEach((f) => (f.leadsRows || []).forEach((r) => { if (/^PK-/.test(String(r['Lead ID']))) lead.set(String(r['Lead ID']), r); }));
  const days = new Map();
  lead.forEach((r) => {
    const d = String(r['Lead Purchase Date'] || '').slice(0, 10);
    const g = Number(r.__grossIncl ?? (Number(r['Lead Value']) || 0) * 1.07) || 0;
    const x = days.get(d) || { orders: 0, gross: 0 }; x.orders++; x.gross += g; days.set(d, x);
  });
  return { days, lead };
}

async function setup(cfg, HV) {
  const B = HV._build;
  const meta = await api(cfg, '/meta');
  if (!meta.ready) throw new Error('database ยังไม่ได้ตั้งรหัส');
  if (!process.stdin.isTTY) throw new Error('เปิด PowerShell เองแล้วรัน: node tools/pancake_sync.mjs --setup');
  const key = await B.deriveKey(await ask('รหัสผู้ดูแล (แดชบอร์ด): '), b64(meta.salt), meta.iter);
  try { await api(cfg, '/snapshots', { token: await B.authToken(key) }); }
  catch (e) { throw new Error(e.status === 401 || e.status === 403 ? 'รหัสผ่านไม่ถูกต้อง (ต้องเป็นรหัสผู้ดูแล)' : e.message); }
  const raw = Buffer.from(await crypto.subtle.exportKey('raw', key)).toString('base64');
  await mkdir(path.dirname(KEYF), { recursive: true });
  await writeFile(KEYF, JSON.stringify({ salt: meta.salt, iter: meta.iter, k: raw, at: new Date().toISOString() }), 'utf8');
  await log('✅ เก็บกุญแจไว้ที่ private/sync_key.json แล้ว (เปลี่ยนรหัสผู้ดูแลเมื่อไร ต้องรัน --setup ใหม่)');
}

async function sync(cfg, HV, pk, XLSX) {
  const B = HV._build;
  if (!existsSync(KEYF)) throw new Error('ยังไม่ได้ตั้งค่า — รัน node tools/pancake_sync.mjs --setup ก่อน');
  const saved = JSON.parse(await readFile(KEYF, 'utf8'));
  const meta = await api(cfg, '/meta');
  if (meta.salt !== saved.salt || meta.iter !== saved.iter) throw new Error('รหัสผู้ดูแลเปลี่ยนแล้ว — รัน --setup ใหม่');
  const key = await crypto.subtle.importKey('raw', b64(saved.k), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  const token = await B.authToken(key);

  // 1. ออเดอร์จาก Pancake API (ไฟล์แบบ export ของ Pancake)
  const tmp = path.join(os.tmpdir(), `hylme-pancake-${process.pid}.xlsx`);
  const py = path.join(V3, '.runtime', 'python', 'python.exe');
  try {
    await run(py, ['-I', path.join(V3, 'tools', 'pancake_export.py'), '--days', String(DAYS), '--out', tmp],
      { cwd: V3, env: { ...process.env, PYTHONUTF8: '1' }, timeout: 600000, maxBuffer: 1 << 24 });
    var wb = XLSX.read(await readFile(tmp), { type: 'buffer' });
  } finally { await rm(tmp, { force: true }); }
  if (!pk.isPancakeWorkbook(wb)) throw new Error('ไฟล์จาก Pancake API ไม่ใช่รูปแบบ export ของ Pancake');
  const conv = pk.convertPancakeData(wb, AUTO_NAME);
  const fresh = Object.assign(conv.file, { autoSync: 'pancake-api', syncedAt: new Date().toISOString() });
  if (!fresh.leadsRows.length) throw new Error('ไม่มีออเดอร์จาก Pancake API — ไม่บันทึก');

  // 2. ข้อมูลรอบล่าสุดใน database
  const snaps = (await api(cfg, '/snapshots', { token })).snapshots || [];
  const latestId = snaps.length ? snaps[0].id : null;
  const full = await api(cfg, '/full' + (latestId ? '?id=' + latestId : ''), { token });
  const real = JSON.parse(await B.decryptEnv(full.full_enc, key));
  const pubJ = await api(cfg, '/public?id=' + full.id, { token });
  const pub = await B.gunzipJSON(pubJ.public_gz);

  const prev = (real.files || []).find((f) => f.autoSync === 'pancake-api');
  const sig = (f) => createHash('sha256').update(JSON.stringify([f.leadsRows, f.prodRows, f.contactsRows, f.accountsRows])).digest('hex');
  if (prev && sig(prev) === sig(fresh)) { await log(`— ไม่มีออเดอร์เปลี่ยน (รอบ ${full.id}) · ${fresh.leadsRows.length} ออเดอร์`); return 0; }
  const files = (real.files || []).filter((f) => f.autoSync !== 'pancake-api').concat([fresh]);

  // 3. ตัวกัน: เทียบก่อน/หลัง
  const before = pancakeDays(real.files || []), after = pancakeDays(files);
  const cut = new Date(Date.now() + 7 * 3600e3 - 2 * 864e5).toISOString().slice(0, 10);
  let oB = 0, oA = 0, gB = 0, gA = 0, big = 0;
  before.days.forEach((v) => { oB += v.orders; }); after.days.forEach((v) => { oA += v.orders; });
  before.days.forEach((v, d) => { if (d < cut) gB += v.gross; }); after.days.forEach((v, d) => { if (d < cut) gA += v.gross; });
  before.lead.forEach((r, id) => {
    const n = after.lead.get(id); if (!n) return;
    const a = Number(r.__grossIncl ?? r['Lead Value'] * 1.07) || 0, b = Number(n.__grossIncl ?? n['Lead Value'] * 1.07) || 0;
    if (a > 0 && Math.abs(b - a) / a > 0.5) big++;
  });
  const dOld = gA - gB;
  const why = [];
  if (oA < oB) why.push(`ออเดอร์รวมลดลง ${oB} -> ${oA}`);
  if (Math.abs(dOld) > 3000 || (gB > 0 && Math.abs(dOld) / gB > 0.01)) why.push(`ยอดของวันที่ผ่านไปแล้วเปลี่ยน ${dOld.toFixed(0)} บาท`);
  if (big > 30) why.push(`ออเดอร์ที่ยอดเปลี่ยนเกิน 50% มี ${big} ใบ`);
  const summary = `ออเดอร์ Pancake ${oB} -> ${oA} (+${oA - oB}) · ยอดวันก่อน ${cut} เปลี่ยน ${dOld >= 0 ? '+' : ''}${dOld.toFixed(0)} บาท · ยอดเปลี่ยนเกิน 50%: ${big} ใบ`;
  if (why.length) { await log('⛔ ไม่บันทึก — ' + why.join(' · ') + ' | ' + summary); return 3; }

  // 4. ปิดชื่อ/เบอร์ + สแกนข้อมูลหลุด (เหมือนปุ่ม "บันทึกลง Database")
  const base = { files, returnDecisions: real.returnDecisions, returnAdditions: real.returnAdditions };
  if (real.returns) base.returns = real.returns;
  const masker = B.makeMasker(await B.macKeyFor(key));
  const masked = masker.walk(base);
  const leaks = B.findLeaks(base, masked, masker.fakes());
  if (leaks.length) { await log('⛔ ไม่บันทึก — เจอข้อมูลจริงที่ยังไม่ถูกปิด ' + leaks.length + ' จุด'); return 4; }
  // ส่วนที่ทุกคนเห็นซึ่งไม่ได้มาจากไฟล์ (การแก้ออเดอร์แบบสาธารณะ / ads) ใช้ของรอบเดิมทั้งก้อน
  for (const k of ['orderEdits', 'ads', 'productAds']) if (pub[k] !== undefined) masked[k] = pub[k];
  const realOut = { ...base, orderEdits: real.orderEdits };

  if (args.has('--dry-run')) {
    await log('🧪 dry-run (ไม่บันทึก) — ' + summary);
    if (args.has('--detail')) {                   // รายวัน + ออเดอร์ที่ยอด/วันเปลี่ยน (เลขออเดอร์เท่านั้น ไม่มีข้อมูลลูกค้า)
      const ds = [...new Set([...before.days.keys(), ...after.days.keys()])].sort();
      ds.forEach((d) => { const a = before.days.get(d) || { orders: 0, gross: 0 }, b = after.days.get(d) || { orders: 0, gross: 0 };
        if (a.orders !== b.orders || Math.abs(a.gross - b.gross) > 0.5) console.log(`  ${d}  ออเดอร์ ${a.orders} -> ${b.orders}  ยอด ${a.gross.toFixed(0)} -> ${b.gross.toFixed(0)} (${(b.gross - a.gross) >= 0 ? '+' : ''}${(b.gross - a.gross).toFixed(0)})`); });
      const ch = [];
      after.lead.forEach((n, id) => { const o = before.lead.get(id);
        if (!o) { ch.push(`${id} ใหม่ ${String(n['Lead Purchase Date']).slice(0, 10)} ${Number(n.__grossIncl || 0).toFixed(0)}`); return; }
        const a = Number(o.__grossIncl ?? o['Lead Value'] * 1.07) || 0, b = Number(n.__grossIncl ?? n['Lead Value'] * 1.07) || 0;
        const d1 = String(o['Lead Purchase Date']).slice(0, 10), d2 = String(n['Lead Purchase Date']).slice(0, 10);
        if (Math.abs(a - b) > 0.5 || d1 !== d2) ch.push(`${id} ${d1}${d1 !== d2 ? '->' + d2 : ''} ยอด ${a.toFixed(0)} -> ${b.toFixed(0)}`); });
      console.log('  ออเดอร์ที่เปลี่ยน / ใหม่: ' + ch.length); ch.forEach((x) => console.log('   ' + x));
    }
    return 0;
  }
  // 5. มีคนกดบันทึกจากหน้าเว็บระหว่างรอบ -> ข้าม (รอบหน้าค่อยทำใหม่บนข้อมูลล่าสุด)
  const now = (await api(cfg, '/snapshots', { token })).snapshots || [];
  if ((now.length ? now[0].id : null) !== latestId) { await log('↷ ข้ามรอบนี้ — มีการบันทึกจากหน้าเว็บระหว่างรอบ'); return 0; }
  const body = {
    source: 'build', public_gz: await B.gzipB64(masked), full_enc: await B.encryptJSON(realOut, key, saved.salt, saved.iter),
    file_count: files.length, order_count: files.reduce((n, f) => n + ((f.leadsRows || []).length), 0),
    note: 'Pancake API อัตโนมัติ — ' + summary,
  };
  const res = await publishSnapshot(cfg, body, token);
  await log(`✅ บันทึกรอบ ${res.snapshot.id} — ${summary}`);
  return 0;
}

async function main() {
  const cfg = JSON.parse(await readFile(CFG, 'utf8'));
  cfg.api = String(cfg.api || '').replace(/\/+$/, '');
  xlsxSrc = await readFile(path.join(ROOT, 'vendor', 'xlsx-0.20.3.full.min.js'), 'utf8');
  const { HV, pk, XLSX } = loadPage(await readFile(PAGE, 'utf8'));
  if (args.has('--setup')) return setup(cfg, HV).then(() => 0);
  const ti = process.argv.indexOf('--convert-test');     // แปลงไฟล์อย่างเดียว ไม่แตะ database
  if (ti > 0) {
    const conv = pk.convertPancakeData(XLSX.read(await readFile(process.argv[ti + 1]), { type: 'buffer' }), AUTO_NAME);
    const f = conv.file, gross = f.leadsRows.reduce((s, r) => s + (r.__grossIncl || 0), 0);
    console.log(JSON.stringify({ stats: conv.stats, leads: f.leadsRows.length, products: f.prodRows.length, accounts: f.accountsRows.length,
      gross: Math.round(gross), sample: Object.keys(f.leadsRows[0] || {}) }));
    return 0;
  }
  return sync(cfg, HV, pk, XLSX);
}

main().then((code) => process.exit(code || 0)).catch(async (e) => { await log('❌ ' + e.message); process.exit(1); });
