// สร้าง index.html (หน้าเว็บ) + บันทึกข้อมูลลง database (Neon) จากไฟล์ต้นฉบับ private/dashboard.html
//   - หน้าเว็บไม่มีข้อมูลฝังในไฟล์ — โหลดจาก database ตอนเปิด
//   - ทุกคนเห็นยอดขายครบ แต่ชื่อ/เบอร์/ที่อยู่ลูกค้าเป็นค่าปลอม (คนเดิม = ค่าปลอมเดิม ตัวเลขทุกหน้าเท่าเดิม)
//   - ข้อมูลจริงเข้ารหัส (AES-256-GCM / PBKDF2-SHA256) ก่อนออกจากเครื่อง — database เก็บได้แต่ถอดไม่ได้
//
//   node tools/build.mjs                      ข้อมูลใน private/dashboard.html -> database + index.html
//   node tools/build.mjs --from data.json     ใช้ data.json (ที่เข้ารหัสแล้ว — ไฟล์ในเครื่องหรือ URL) เป็นข้อมูลจริงแทน
//   node tools/build.mjs --no-publish         สร้าง index.html อย่างเดียว (เช่น แก้โค้ดหน้าเว็บ) ไม่ส่งข้อมูล
//   node tools/build.mjs --unlock             ข้อมูลจริงรอบล่าสุดจาก database -> private/dashboard.html
//
// ตั้งค่า database อยู่ใน private/neon.json ({api, setup_code}) — ห้ามขึ้น git
// รหัสผ่าน: พิมพ์ตอนรัน (ไม่แสดงบนจอ) หรือตั้งตัวแปร HYLME_PASSWORD ไว้ก่อนรัน
// ครั้งแรกจะตั้งรหัสให้ database เอง (ใช้ salt เดิมของเว็บ -> เครื่องที่ "จำรหัส" ไว้ยังใช้ต่อได้)
// ก่อนส่ง/บันทึกจะสแกนหาเบอร์/ชื่อจริงที่หลุด ถ้าเจอจะไม่ส่งและไม่เขียนไฟล์

import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'private', 'dashboard.html');
const OUT = path.join(ROOT, 'index.html');
const CFG = path.join(ROOT, 'private', 'neon.json');
const MIN_PW = 10;

// ---------- อ่าน / เขียน slot ในไฟล์ ----------
const SLOTS = {
  files:           /^const EMBEDDED_DATA = (.*); \/\*__HYLME_EMBED_SLOT__\*\/$/m,
  returnDecisions: /^let RETURN_REVIEW_DECISIONS = (.*); \/\*__RR_DECISIONS_SLOT__\*\/$/m,
  returnAdditions: /^let RETURN_REVIEW_ADDITIONS = (.*); \/\*__RR_ADDITIONS_SLOT__\*\/$/m,
  full:            /^const HYLME_FULL = (.*); \/\*__HYLME_FULL_SLOT__\*\/$/m,
};
function readSlot(html, name) {
  const m = html.match(SLOTS[name]);
  if (!m) throw new Error('ไม่พบช่องข้อมูล ' + name + ' ในไฟล์');
  return JSON.parse(m[1]);
}
const esc = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
const writeEmbedded = (html, files) => html.replace(SLOTS.files, () => 'const EMBEDDED_DATA = ' + esc(files) + '; /*__HYLME_EMBED_SLOT__*/');

// ---------- โหลดโค้ดปิดชื่อ/เบอร์ตัวเดียวกับในหน้าเว็บ (HYLME VAULT) ----------
function loadVault(html) {
  const vault = html.match(/<script>\s*(\/\* =+ HYLME VAULT[\s\S]*?)<\/script>/);
  const prov = html.match(/^const THAI_PROVINCES = [\s\S]*?\.sort\([^\n]*\);?$/m);
  const findProv = html.match(/^function findProvinceInText\(text\)\{[\s\S]*?\n\}/m);
  if (!vault || !prov || !findProv) throw new Error('ไม่พบโค้ด HYLME VAULT / THAI_PROVINCES ในไฟล์');
  const ctx = vm.createContext({ crypto, TextEncoder, TextDecoder, Blob, Response, CompressionStream, DecompressionStream, atob, btoa, console });
  ctx.window = ctx;
  vm.runInContext(prov[0] + '\n' + findProv[0] + '\nglobalThis.findProvinceInText = findProvinceInText;', ctx);
  vm.runInContext(vault[1], ctx);
  return ctx.HylmeVault;
}

// ---------- database ----------
async function loadConfig() {
  if (!existsSync(CFG)) throw new Error('ไม่พบ private/neon.json (ที่อยู่ database)');
  const cfg = JSON.parse(await readFile(CFG, 'utf8'));
  if (!cfg.api) throw new Error('private/neon.json ไม่มี "api"');
  cfg.api = cfg.api.replace(/\/+$/, '');
  return cfg;
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

// ---------- รหัสผ่าน ----------
function ask(question) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let answered = false;
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.on('close', () => { if (!answered) reject(new Error('ยกเลิก — ไม่ได้ใส่รหัสผ่าน')); });
    rl.question(question, (ans) => { answered = true; rl.close(); process.stdout.write('\n'); resolve(ans); });
  });
}
async function getPassword(confirm) {
  if (process.env.HYLME_PASSWORD) return process.env.HYLME_PASSWORD;
  if (!process.stdin.isTTY) throw new Error('ไม่มีหน้าจอให้พิมพ์รหัสผ่าน — เปิด PowerShell / Terminal เอง แล้วรันคำสั่งนี้ในโฟลเดอร์โปรเจกต์');
  const pw = await ask('รหัสผ่าน: ');
  if (confirm && pw !== await ask('ยืนยันรหัสผ่านอีกครั้ง: ')) throw new Error('รหัสผ่านสองครั้งไม่ตรงกัน');
  return pw;
}
const b64 = (s) => Buffer.from(s, 'base64');

// เปิด database ด้วยรหัสผ่าน: ตั้งรหัสให้ database ครั้งแรก หรือเช็กว่ารหัสถูกกับ database เดิม
async function openVault(cfg, B, oldEnv) {
  const meta = await api(cfg, '/meta');
  if (meta.ready) {
    const pw = await getPassword(false);
    const key = await B.deriveKey(pw, b64(meta.salt), meta.iter);
    const token = await B.authToken(key);
    try { await api(cfg, '/full', { token }); }
    catch (e) { if (e.status === 401) throw new Error('รหัสผ่านไม่ถูกต้อง'); if (e.status !== 404) throw e; }
    return { key, token, salt: meta.salt, iter: meta.iter };
  }
  // ครั้งแรก: ใช้ salt เดิมของเว็บ (ถ้ามี) และต้องเปิดข้อมูลเดิมได้ด้วยรหัสนี้ — กันพิมพ์รหัสผิดแล้วตั้งค่าไปเลย
  console.log('ℹ database ยังไม่ได้ตั้งรหัส — จะตั้งด้วยรหัสที่ใส่ตอนนี้');
  const pw = await getPassword(true);
  if (pw.length < MIN_PW) throw new Error(`รหัสผ่านต้องยาวอย่างน้อย ${MIN_PW} ตัวอักษร`);
  let salt = oldEnv && oldEnv.salt, iter = (oldEnv && oldEnv.iter) || B.ITER;
  if (!salt) salt = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const key = await B.deriveKey(pw, b64(salt), iter);
  if (oldEnv && oldEnv.ct) {
    try { await B.decryptEnv(oldEnv, key); } catch { throw new Error('รหัสผ่านไม่ตรงกับเว็บเดิม (index.html) — ใช้รหัสเดิม'); }
  }
  if (!cfg.setup_code) throw new Error('private/neon.json ไม่มี "setup_code" สำหรับตั้งรหัสครั้งแรก');
  const token = await B.authToken(key);
  await api(cfg, '/setup', { method: 'POST', body: { setup_code: cfg.setup_code, salt, iter, verifier: createHash('sha256').update(token).digest('hex') } });
  console.log('✅ ตั้งรหัสให้ database แล้ว');
  return { key, token, salt, iter };
}

// ---------- สแกนหาข้อมูลจริงที่หลุด ----------
const PHONE_KEYS = new Set(['Phone', 'Secondary Phone', 'GoSell Phone', 'phone', '__cxPhone']);
const STAFF_KEYS = new Set(['Current User Name', '__person', 'user', 'userMapped']);
// ช่องที่มีข้อมูลส่วนตัว — ค่าในช่องอื่น (สถานะ, อำเภอ, ชื่อพนักงาน…) ที่บังเอิญตรงกับชื่อลูกค้า
// เช่น นามสกุล "พานทอง" = อำเภอพานทอง หรือชื่อ "สำเร็จ" = สถานะสำเร็จ ไม่นับว่าหลุด
const PII_KEYS = new Set(['Lead Name', 'Account Name', 'name', 'First Name', 'Last Name', ...PHONE_KEYS,
  'Address Line 1', 'Address Line 2', 'GoSell Address', 'address', 'Email', 'Facebook', 'Line ID', 'Note', 'Internal Notes',
  'Lead Intro', 'reason', 'note', 'chan', 'Company', 'Tax ID']);
function collectReal(real) {
  const phones = new Set(), names = new Set(), staff = new Set(), places = new Set();
  const addName = (s) => {
    s = String(s == null ? '' : s).trim();
    if (!s || /\*|deleted|^ออเดอร์ /i.test(s) || /^[A-Z][A-Z0-9]*-[A-Za-z0-9-]*\d{3,}$/.test(s)) return;   // ไม่ใช่ชื่อคน
    if (s.replace(/[\s​]/g, '').length >= 4) names.add(s);
  };
  (function walk(v) {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const person = 'phone' in v || 'confirmed' in v || ('gross' in v && 'date' in v);
    for (const [k, x] of Object.entries(v)) {
      if (PHONE_KEYS.has(k) && (typeof x === 'string' || typeof x === 'number')) {
        const d = String(x).replace(/\D/g, '');
        if (d.length >= 9 && !/\*/.test(String(x))) phones.add(d.slice(-9));
      } else if (k === 'Lead Name' || k === 'Account Name' || (person && k === 'name')) addName(x);
      else if ((k === 'First Name' || k === 'Last Name') && 'Contact ID' in v) {
        addName(x);
        addName([v['First Name'], v['Last Name']].filter(Boolean).join(' '));
      } else if (STAFF_KEYS.has(k) && typeof x === 'string') staff.add(x.trim());
      else if (!PII_KEYS.has(k) && typeof x === 'string') places.add(x.trim());
      else if (x && typeof x === 'object') walk(x);
    }
  })(real);
  for (const s of [...staff, ...places]) names.delete(s);
  return { phones, names, staff, places };
}
// fakeTails = 7 หลักท้ายปลอมทุกค่าที่ตัวปิดเบอร์สร้าง (เบอร์จริงที่บังเอิญเท่ากับค่าปลอมของคนอื่น ไม่นับว่าหลุด)
function scanLeaks(outText, maskedData, real, fakeTails) {
  const { phones, names, staff, places } = collectReal(real);
  const phoneHits = [];
  for (const m of outText.matchAll(/(?<!\d)(?:\+?66[ \-.]?|0)?[2-9](?:[ \-.]?\d){7,8}(?!\d)/g)) {
    const d = m[0].replace(/\D/g, '');
    if (d.length >= 9 && phones.has(d.slice(-9)) && !fakeTails.has(d.slice(-7))) phoneHits.push(m[0]);
  }
  const nameHits = [];
  const tokenHits = new Map();
  const skipTokens = new Set([...staff, ...places].flatMap((s) => s.split(/\s+/)));
  const nameTokens = new Set();
  for (const n of names) for (const t of n.split(/[\s,]+/)) if (t.length >= 5 && !skipTokens.has(t)) nameTokens.add(t);
  // ชื่อลูกค้าเต็ม (มีวรรค) ที่อาจแปะไว้ในคอมเมนต์ / โค้ด นอกช่องข้อมูล
  const codePairs = new Set();
  for (const line of outText.split('\n')) {
    if (line.length >= 20000) continue;            // บรรทัดข้อมูลตรวจแยกด้านล่าง
    const w = line.split(/[\s"'`,()<>]+/);
    for (let i = 0; i + 1 < w.length; i++) codePairs.add(w[i] + ' ' + w[i + 1]);
  }
  const codeHits = [...names].filter((n) => { const w = n.split(/\s+/); return w.length >= 2 && codePairs.has(w[0] + ' ' + w[1]); });
  (function walk(v) {
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === 'string') {
      const s = v.trim();
      if (names.has(s)) nameHits.push(s);
      else if (s.length > 4) for (const t of s.split(/[\s,|:;()\/]+/)) if (nameTokens.has(t)) tokenHits.set(t, (tokenHits.get(t) || 0) + 1);
      return;
    }
    if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(maskedData);
  return { realPhones: phones.size, realNames: names.size, phoneHits, nameHits: nameHits.concat(codeHits), tokenHits };
}

// ---------- แหล่งข้อมูลจริง ----------
async function readFrom(from, B, key, src) {
  const text = /^https?:\/\//.test(from) ? await (await fetch(from, { cache: 'no-store' })).text() : await readFile(path.resolve(from), 'utf8');
  let files;
  if (/^\s*\{/.test(text)) {                     // data.json (hylmePub 1/2)
    const pub = JSON.parse(text);
    if (!pub.enc) throw new Error(from + ' ไม่มีข้อมูลจริงที่เข้ารหัส (enc)');
    try { files = JSON.parse(await B.decryptEnv(pub.enc, key)).files; } catch { throw new Error('ถอดรหัส ' + from + ' ไม่ได้ (เข้ารหัสด้วยรหัส/salt อื่น)'); }
  } else {                                       // index.html แบบเก่าที่ฝังข้อมูลเข้ารหัสไว้
    const env = readSlot(text, 'full');
    files = JSON.parse(await B.decryptEnv(env, key)).files;
  }
  if (!Array.isArray(files) || !files.length) throw new Error(from + ' ไม่มีข้อมูล');
  return { files, returnDecisions: readSlot(src, 'returnDecisions'), returnAdditions: readSlot(src, 'returnAdditions') };
}

// ---------- build ----------
async function build(args) {
  if (!existsSync(SRC)) throw new Error('ไม่พบไฟล์ต้นฉบับ ' + SRC);
  const src = await readFile(SRC, 'utf8');
  if (readSlot(src, 'full') !== null) throw new Error('private/dashboard.html เป็นไฟล์ที่ build แล้ว — ใช้ --unlock เพื่อได้ไฟล์ต้นฉบับ');
  const cfg = await loadConfig();
  const HV = loadVault(src);
  const B = HV._build;
  const fromIdx = args.indexOf('--from');
  const from = fromIdx >= 0 ? args[fromIdx + 1] : null;
  const publish = !args.includes('--no-publish');

  let oldEnv = null;
  if (existsSync(OUT)) { try { oldEnv = readSlot(await readFile(OUT, 'utf8'), 'full'); } catch {} }
  const v = await openVault(cfg, B, oldEnv);

  const real = from ? await readFrom(from, B, v.key, src)
    : { files: readSlot(src, 'files'), returnDecisions: readSlot(src, 'returnDecisions'), returnAdditions: readSlot(src, 'returnAdditions') };
  const t0 = Date.now();
  const masker = B.makeMasker(await B.macKeyFor(v.key));
  const masked = masker.walk(real);

  // หน้าเว็บ: ไม่มีข้อมูลฝัง (โหลดจาก database) — HYLME_FULL เหลือแค่ salt / iter / ที่อยู่ database
  const page = { hylmeEnc: 1, kdf: 'PBKDF2-SHA256', iter: v.iter, salt: v.salt, api: cfg.api + '/' };
  let html = writeEmbedded(src, []);
  html = HV.fillSlots(html, { returnDecisions: masked.returnDecisions, returnAdditions: masked.returnAdditions, full: page });

  const r = scanLeaks(html + '\n' + JSON.stringify(masked), masked, real, masker.fakes());
  console.log(`ตรวจหาข้อมูลหลุด: เบอร์จริง ${r.realPhones} เบอร์, ชื่อจริง ${r.realNames} ชื่อ`);
  if (r.tokenHits.size) console.log('  ℹ คำที่ซ้ำกับส่วนของชื่อลูกค้า (มักเป็นคำทั่วไป ตรวจด้วยตา):', [...r.tokenHits].slice(0, 15).map(([t, n]) => `${t}×${n}`).join(', '));
  if (r.phoneHits.length || r.nameHits.length) {
    console.error('❌ เจอข้อมูลจริงหลุด — ไม่ส่งข้อมูลและไม่บันทึกไฟล์');
    if (r.phoneHits.length) console.error('  เบอร์:', r.phoneHits.length, r.phoneHits.slice(0, 5));
    if (r.nameHits.length) console.error('  ชื่อที่ไม่ถูกแปลง:', r.nameHits.length, r.nameHits.slice(0, 5));
    process.exit(2);
  }

  if (publish) {
    const body = {
      source: from ? 'migrate' : 'build', public_gz: await B.gzipB64(masked),
      full_enc: await B.encryptJSON(real, v.key, v.salt, v.iter),
      file_count: real.files.length, order_count: real.files.reduce((n, f) => n + ((f.leadsRows || []).length), 0),
      note: from ? 'ย้ายจาก ' + path.basename(from) : 'tools/build.mjs',
    };
    const res = await api(cfg, '/publish', { method: 'POST', body, token: v.token });
    console.log(`✅ บันทึกลง database แล้ว: รอบที่ ${res.snapshot.id} · ออเดอร์ ${body.order_count} · ${((body.public_gz.length + body.full_enc.ct.length) / 1048576).toFixed(1)} MB`);
  }
  await writeFile(OUT, html, 'utf8');
  console.log(`✅ สร้าง index.html แล้ว (${(Buffer.byteLength(html) / 1048576).toFixed(1)} MB, ไม่มีข้อมูลฝัง) — ${((Date.now() - t0) / 1000).toFixed(1)} วินาที`);
}

async function unlock(file) {
  const target = path.resolve(file || OUT);
  const html = await readFile(target, 'utf8');
  const env = readSlot(html, 'full');
  if (!env) throw new Error(path.basename(target) + ' เป็นไฟล์ต้นฉบับอยู่แล้ว');
  const HV = loadVault(html);
  const B = HV._build;
  let real;
  if (env.api) {                                   // หน้าเว็บแบบ database -> ดึงข้อมูลจริงรอบล่าสุด
    const cfg = { api: env.api.replace(/\/+$/, '') };
    const key = await B.deriveKey(await getPassword(false), b64(env.salt), env.iter);
    let j;
    try { j = await api(cfg, '/full', { token: await B.authToken(key) }); }
    catch (e) { throw new Error(e.status === 401 ? 'รหัสผ่านไม่ถูกต้อง' : e.message); }
    real = JSON.parse(await B.decryptEnv(j.full_enc, key));
    console.log(`ℹ ข้อมูลจาก database รอบที่ ${j.id} (${j.created_at})`);
  } else {                                         // หน้าเว็บแบบเก่าที่ฝังข้อมูลเข้ารหัส
    const key = await B.deriveKey(await getPassword(false), b64(env.salt), env.iter);
    try { real = JSON.parse(await B.decryptEnv(env, key)); } catch { throw new Error('รหัสผ่านไม่ถูกต้อง'); }
  }
  let out = writeEmbedded(html, real.files);
  out = HV.fillSlots(out, { returnDecisions: real.returnDecisions, returnAdditions: real.returnAdditions, full: null });
  if (existsSync(SRC)) {   // กันทับไฟล์ต้นฉบับที่อาจแก้ไว้ — สำรองไว้ก่อน
    const bak = path.join(ROOT, 'private', 'backup', 'dashboard-' + new Date().toISOString().replace(/[:.]/g, '-') + '.html');
    await mkdir(path.dirname(bak), { recursive: true });
    await copyFile(SRC, bak);
    console.log('ℹ สำรองไฟล์ต้นฉบับเดิมไว้ที่ ' + path.relative(ROOT, bak));
  }
  await mkdir(path.dirname(SRC), { recursive: true });
  await writeFile(SRC, out, 'utf8');
  console.log(`✅ ถอดข้อมูลจริงแล้ว -> ${path.relative(ROOT, SRC)}`);
}

const args = process.argv.slice(2);
try {
  if (args[0] === '--unlock') await unlock(args[1]);
  else await build(args);
} catch (e) {
  console.error('❌ ' + e.message);
  process.exit(1);
}
