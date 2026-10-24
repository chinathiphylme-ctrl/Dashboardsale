// สร้าง index.html สำหรับขึ้น GitHub จากไฟล์ต้นฉบับ private/dashboard.html
//   - ทุกคนเปิดดูได้โดยไม่ต้องใส่รหัส แต่ชื่อ/เบอร์/ที่อยู่ลูกค้าเป็นค่าปลอม (คนเดิม = ค่าปลอมเดิม ตัวเลขทุกหน้าเท่าเดิม)
//   - ข้อมูลจริงทั้งหมดเข้ารหัสด้วยรหัสผ่าน (AES-256-GCM / PBKDF2-SHA256) ฝังอยู่ในไฟล์ — กดแม่กุญแจแล้วใส่รหัสเพื่อเปิด
//
//   node tools/build.mjs            private/dashboard.html  ->  index.html
//   node tools/build.mjs --unlock   index.html (หรือไฟล์ที่ระบุ)  ->  private/dashboard.html (ข้อมูลจริง)
//
// รหัสผ่าน: พิมพ์ตอนรัน (ไม่แสดงบนจอ) หรือตั้งตัวแปร HYLME_PASSWORD ไว้ก่อนรัน
// ถ้า index.html เดิมเปิดได้ด้วยรหัสเดียวกัน จะใช้ salt เดิม -> ค่าปลอม, data.json และเครื่องที่ "จำรหัส" ไว้ ยังใช้ต่อได้
// ก่อนบันทึกจะสแกนหาเบอร์/ชื่อจริงที่หลุด ถ้าเจอจะไม่เขียนไฟล์

import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'private', 'dashboard.html');
const OUT = path.join(ROOT, 'index.html');
const MIN_PW = 10;

// ---------- อ่าน / เขียน slot ในไฟล์ ----------
const SLOTS = {
  files:           [/^const EMBEDDED_DATA = (.*); \/\*__HYLME_EMBED_SLOT__\*\/$/m, 'const EMBEDDED_DATA', '__HYLME_EMBED_SLOT__'],
  returnDecisions: [/^let RETURN_REVIEW_DECISIONS = (.*); \/\*__RR_DECISIONS_SLOT__\*\/$/m],
  returnAdditions: [/^let RETURN_REVIEW_ADDITIONS = (.*); \/\*__RR_ADDITIONS_SLOT__\*\/$/m],
  full:            [/^const HYLME_FULL = (.*); \/\*__HYLME_FULL_SLOT__\*\/$/m],
};
function readSlot(html, name) {
  const m = html.match(SLOTS[name][0]);
  if (!m) throw new Error('ไม่พบช่องข้อมูล ' + name + ' ในไฟล์');
  return JSON.parse(m[1]);
}
const esc = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
function writeEmbedded(html, files) {
  return html.replace(SLOTS.files[0], () => 'const EMBEDDED_DATA = ' + esc(files) + '; /*__HYLME_EMBED_SLOT__*/');
}

// ---------- โหลดโค้ดปิดชื่อ/เบอร์ตัวเดียวกับในหน้าเว็บ (HYLME VAULT) ----------
function loadVault(html) {
  const vault = html.match(/<script>\s*(\/\* =+ HYLME VAULT[\s\S]*?)<\/script>/);
  const prov = html.match(/^const THAI_PROVINCES = [\s\S]*?\.sort\([^\n]*\);?$/m);
  const findProv = html.match(/^function findProvinceInText\(text\)\{[\s\S]*?\n\}/m);
  if (!vault || !prov || !findProv) throw new Error('ไม่พบโค้ด HYLME VAULT / THAI_PROVINCES ในไฟล์ต้นฉบับ');
  const ctx = vm.createContext({
    crypto, TextEncoder, TextDecoder, Blob, Response, CompressionStream, DecompressionStream, atob, btoa, console,
  });
  ctx.window = ctx;
  vm.runInContext(prov[0] + '\n' + findProv[0] + '\nglobalThis.findProvinceInText = findProvinceInText;', ctx);
  vm.runInContext(vault[1], ctx);
  return ctx.HylmeVault;
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
function scanLeaks(outHtml, maskedData, real, fakeTails) {
  const { phones, names, staff, places } = collectReal(real);
  // เบอร์: ทุกชุดตัวเลขที่หน้าตาเหมือนเบอร์ในไฟล์ผลลัพธ์ (รวมรูปแบบ 9 หลักของ __cxPhone)
  const phoneHits = [];
  for (const m of outHtml.matchAll(/(?<!\d)(?:\+?66[ \-.]?|0)?[2-9](?:[ \-.]?\d){7,8}(?!\d)/g)) {
    const d = m[0].replace(/\D/g, '');
    if (d.length >= 9 && phones.has(d.slice(-9)) && !fakeTails.has(d.slice(-7))) phoneHits.push(m[0]);
  }
  // ชื่อ: ค่าข้อความในข้อมูลที่ปิดแล้วต้องไม่ตรงกับชื่อลูกค้าจริง + ไล่หาคำในชื่อจริงที่แฝงในข้อความอิสระ
  const nameHits = [];
  const tokenHits = new Map();
  const skipTokens = new Set([...staff, ...places].flatMap((s) => s.split(/\s+/)));
  const nameTokens = new Set();
  for (const n of names) for (const t of n.split(/[\s,]+/)) if (t.length >= 5 && !skipTokens.has(t)) nameTokens.add(t);
  // ชื่อลูกค้าเต็ม (มีวรรค) ที่อาจแปะไว้ในคอมเมนต์ / โค้ด นอกช่องข้อมูล
  const codePairs = new Set();
  for (const line of outHtml.split('\n')) {
    if (line.length >= 20000) continue;            // บรรทัดข้อมูลตรวจแยกด้านบนแล้ว
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

// ---------- build ----------
async function build() {
  if (!existsSync(SRC)) throw new Error('ไม่พบไฟล์ต้นฉบับ ' + SRC);
  const src = await readFile(SRC, 'utf8');
  if (readSlot(src, 'full') !== null) throw new Error('private/dashboard.html เป็นไฟล์ที่ build แล้ว — ใช้ --unlock เพื่อได้ไฟล์ต้นฉบับ');
  const HV = loadVault(src);
  const B = HV._build;
  const pw = await getPassword(true);
  if (pw.length < MIN_PW) throw new Error(`รหัสผ่านต้องยาวอย่างน้อย ${MIN_PW} ตัวอักษร (ไฟล์อยู่บนเน็ต ใครก็ลองเดารหัสได้ไม่จำกัด)`);

  // ใช้ salt เดิมถ้ารหัสผ่านยังเหมือนเดิม
  let saltB64 = null, iter = B.ITER;
  if (existsSync(OUT)) {
    const old = (await readFile(OUT, 'utf8')).match(SLOTS.full[0]);
    const env = old && JSON.parse(old[1]);
    if (env) {
      try {
        await B.decryptEnv(env, await B.deriveKey(pw, Buffer.from(env.salt, 'base64'), env.iter));
        saltB64 = env.salt; iter = env.iter;
      } catch { console.log('ℹ รหัสผ่านต่างจาก index.html เดิม -> สร้างกุญแจใหม่ (data.json เดิมจะใช้ไม่ได้ ต้องกด "ส่งข้อมูลขึ้น GitHub" ใหม่)'); }
    }
  }
  if (!saltB64) saltB64 = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const key = await B.deriveKey(pw, Buffer.from(saltB64, 'base64'), iter);

  const real = { files: readSlot(src, 'files'), returnDecisions: readSlot(src, 'returnDecisions'), returnAdditions: readSlot(src, 'returnAdditions') };
  const t0 = Date.now();
  const masker = B.makeMasker(await B.macKeyFor(key));
  const masked = masker.walk(real);
  const full = await B.encryptJSON(real, key, saltB64, iter);
  let html = writeEmbedded(src, masked.files);
  html = HV.fillSlots(html, { returnDecisions: masked.returnDecisions, returnAdditions: masked.returnAdditions, full });
  console.log(`ปิดชื่อ/เบอร์ + เข้ารหัส ${((Date.now() - t0) / 1000).toFixed(1)} วินาที`);

  const r = scanLeaks(html, masked, real, masker.fakes());
  console.log(`ตรวจหาข้อมูลหลุด: เบอร์จริง ${r.realPhones} เบอร์, ชื่อจริง ${r.realNames} ชื่อ`);
  if (r.tokenHits.size) console.log('  ℹ คำที่ซ้ำกับส่วนของชื่อลูกค้า (มักเป็นคำทั่วไป ตรวจด้วยตา):', [...r.tokenHits].slice(0, 15).map(([t, n]) => `${t}×${n}`).join(', '));
  if (r.phoneHits.length || r.nameHits.length) {
    console.error('❌ เจอข้อมูลจริงหลุดในไฟล์ผลลัพธ์ — ไม่บันทึกไฟล์');
    if (r.phoneHits.length) console.error('  เบอร์:', r.phoneHits.length, r.phoneHits.slice(0, 5));
    if (r.nameHits.length) console.error('  ชื่อที่ไม่ถูกแปลง:', r.nameHits.length, r.nameHits.slice(0, 5));
    process.exit(2);
  }
  await writeFile(OUT, html, 'utf8');
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  console.log(`✅ สร้าง index.html แล้ว (${mb(Buffer.byteLength(html))}) — ไม่พบข้อมูลจริงหลุด`);
}

async function unlock(file) {
  const target = path.resolve(file || OUT);
  const html = await readFile(target, 'utf8');
  const env = readSlot(html, 'full');
  if (!env) throw new Error(path.basename(target) + ' ไม่มีข้อมูลจริงที่เข้ารหัส (เป็นไฟล์ต้นฉบับอยู่แล้ว?)');
  const HV = loadVault(html);
  const B = HV._build;
  const pw = await getPassword(false);
  let real;
  try { real = JSON.parse(await B.decryptEnv(env, await B.deriveKey(pw, Buffer.from(env.salt, 'base64'), env.iter))); }
  catch { throw new Error('รหัสผ่านไม่ถูกต้อง'); }
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
  console.log(`✅ ถอดข้อมูลจริงแล้ว: ${path.relative(ROOT, target) || target} -> ${path.relative(ROOT, SRC)}`);
}

const args = process.argv.slice(2);
try {
  if (args[0] === '--unlock') await unlock(args[1]);
  else await build();
} catch (e) {
  console.error('❌ ' + e.message);
  process.exit(1);
}
