// เข้ารหัส / ถอดรหัส แดชบอร์ด Hylme ด้วยรหัสผ่าน (AES-256-GCM, กุญแจจาก PBKDF2-SHA256)
//
//   node tools/lock.mjs            เข้ารหัส private/dashboard.html  ->  index.html   (ไฟล์ที่อัปขึ้น GitHub)
//   node tools/lock.mjs --unlock   ถอดรหัส index.html               ->  private/dashboard.html
//   node tools/lock.mjs --unlock some.html      ถอดรหัสไฟล์อื่น (เช่น index.html ที่ดาวน์โหลดจากปุ่ม "สร้างไฟล์เว็บ")
//
// รหัสผ่าน: พิมพ์ตอนรัน (ไม่แสดงบนจอ) หรือตั้งตัวแปร HYLME_PASSWORD ไว้ก่อนรัน
// ถ้า index.html เดิมเปิดได้ด้วยรหัสเดียวกัน จะใช้ salt เดิม -> เครื่องที่ "จำรหัส" ไว้ และ data.json เดิม ยังใช้ได้

import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';

const { subtle } = globalThis.crypto;
const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'private', 'dashboard.html');
const OUT = path.join(ROOT, 'index.html');
const TPL = path.join(ROOT, 'tools', 'loader.html');
const PLACEHOLDER = '/*__HYLME_PAYLOAD__*/';
const ITER = 600000;
const MIN_PW = 10;

const b64e = (u8) => Buffer.from(u8).toString('base64');
const b64d = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function deriveKey(pw, salt, iter) {
  const base = await subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

function readPayload(html) {
  const m = html.match(/<script type="application\/json" id="hylme-payload">([\s\S]*?)<\/script>/);
  if (!m || m[1] === PLACEHOLDER) return null;
  return JSON.parse(m[1]);
}

async function decryptEnv(env, pw) {
  const key = await deriveKey(pw, b64d(env.salt), env.iter);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: b64d(env.iv) }, key, b64d(env.ct));
  return gunzipSync(Buffer.from(plain)).toString('utf8');
}

function ask(question, hidden) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let answered = false;
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.on('close', () => { if (!answered) reject(new Error('ยกเลิก — ไม่ได้ใส่รหัสผ่าน')); });
    rl.question(question, (ans) => { answered = true; rl.close(); if (hidden) process.stdout.write('\n'); resolve(ans); });
  });
}

async function getPassword(confirm) {
  if (process.env.HYLME_PASSWORD) return process.env.HYLME_PASSWORD;
  if (!process.stdin.isTTY) {
    throw new Error('ไม่มีหน้าจอให้พิมพ์รหัสผ่าน — เปิด PowerShell / Terminal เอง แล้วรันคำสั่งนี้ในโฟลเดอร์โปรเจกต์');
  }
  const pw = await ask('รหัสผ่าน: ', true);
  if (confirm) {
    const again = await ask('ยืนยันรหัสผ่านอีกครั้ง: ', true);
    if (pw !== again) throw new Error('รหัสผ่านสองครั้งไม่ตรงกัน');
  }
  return pw;
}

async function lock() {
  if (!existsSync(SRC)) throw new Error('ไม่พบไฟล์ต้นฉบับ ' + SRC);
  const pw = await getPassword(true);
  if (pw.length < MIN_PW) throw new Error(`รหัสผ่านต้องยาวอย่างน้อย ${MIN_PW} ตัวอักษร (ไฟล์ที่เข้ารหัสอยู่บนเน็ต ใครก็ลองเดารหัสได้ไม่จำกัด)`);

  // ใช้ salt เดิมถ้ารหัสผ่านยังเหมือนเดิม
  let salt = null, iter = ITER;
  if (existsSync(OUT)) {
    const old = readPayload(await readFile(OUT, 'utf8'));
    if (old) {
      try { await decryptEnv(old, pw); salt = b64d(old.salt); iter = old.iter; }
      catch { console.log('ℹ รหัสผ่านต่างจาก index.html เดิม -> สร้างกุญแจใหม่ (data.json เดิมจะเปิดไม่ได้ ต้องกด "ส่งข้อมูลขึ้น GitHub" ใหม่)'); }
    }
  }
  if (!salt) salt = randomBytes(16);

  const html = await readFile(SRC, 'utf8');
  const key = await deriveKey(pw, salt, iter);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, gzipSync(Buffer.from(html, 'utf8'), { level: 9 })));
  const env = { hylmeEnc: 1, kdf: 'PBKDF2-SHA256', iter, salt: b64e(salt), iv: b64e(iv), gz: true, ct: b64e(ct) };

  const tpl = await readFile(TPL, 'utf8');
  if (!tpl.includes(PLACEHOLDER)) throw new Error('loader.html ไม่มีจุดใส่ข้อมูล ' + PLACEHOLDER);
  await writeFile(OUT, tpl.replace(PLACEHOLDER, () => JSON.stringify(env)), 'utf8');
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  console.log(`✅ เข้ารหัสแล้ว: ${path.relative(ROOT, SRC)} (${mb(Buffer.byteLength(html))}) -> index.html (${mb((await readFile(OUT)).length)})`);
}

async function unlock(file) {
  const target = path.resolve(file || OUT);
  const env = readPayload(await readFile(target, 'utf8'));
  if (!env) throw new Error(path.basename(target) + ' ไม่ใช่ไฟล์ที่เข้ารหัสไว้');
  const pw = await getPassword(false);
  let html;
  try { html = await decryptEnv(env, pw); } catch { throw new Error('รหัสผ่านไม่ถูกต้อง'); }
  if (existsSync(SRC)) {   // กันทับไฟล์ต้นฉบับที่อาจแก้ไว้ — สำรองไว้ก่อน
    const bak = path.join(ROOT, 'private', 'backup', 'dashboard-' + new Date().toISOString().replace(/[:.]/g, '-') + '.html');
    await mkdir(path.dirname(bak), { recursive: true });
    await copyFile(SRC, bak);
    console.log('ℹ สำรองไฟล์ต้นฉบับเดิมไว้ที่ ' + path.relative(ROOT, bak));
  }
  await writeFile(SRC, html, 'utf8');
  console.log(`✅ ถอดรหัสแล้ว: ${path.relative(ROOT, target) || target} -> ${path.relative(ROOT, SRC)}`);
}

const args = process.argv.slice(2);
try {
  if (args[0] === '--unlock') await unlock(args[1]);
  else await lock();
} catch (e) {
  console.error('❌ ' + e.message);
  process.exit(1);
}
