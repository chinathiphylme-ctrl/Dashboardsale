# Hylme Dashboard

ใครมีลิงก์ก็เปิดดูได้เลย ไม่ต้องใส่รหัส แต่**ชื่อ / เบอร์ / ที่อยู่ลูกค้าเป็นค่าปลอม**
- ค่าปลอมคงที่ต่อคน (ลูกค้าคนเดิม = ค่าปลอมเดิม) ยอดขาย ลูกค้าใหม่/เก่า ออเดอร์ยกเลิก ทุกตัวเลขจึงเท่าข้อมูลจริง
- กด 🔒 มุมบนซ้าย แล้วใส่รหัส จะสลับเป็นข้อมูลจริง ถึงจะ **ดาวน์โหลด / export Excel / เข้าหลังบ้าน** ได้

## ข้อมูลอยู่ที่ไหน
ข้อมูลอยู่ใน **database (Neon Postgres)** ไม่ได้ฝังใน `index.html` และไม่ได้ commit ลง git

| ส่วน | อยู่ที่ | ใครเปิดได้ |
|---|---|---|
| ข้อมูลที่ปิดชื่อ/เบอร์แล้ว | ตาราง `snapshots.public_gz` | ทุกคน |
| ข้อมูลจริง | ตาราง `snapshots.full_enc` — เข้ารหัส AES-256-GCM ในเบราว์เซอร์ก่อนส่ง | คนที่รู้รหัสผ่าน (database เองก็ถอดไม่ได้) |
| ค่าตรวจรหัส | ตาราง `vault` — เก็บแค่ sha256 ของ token ที่คำนวณจากรหัส | — |

- เก็บย้อนหลัง 20 รอบล่าสุด · ใส่รหัสผิด 20 ครั้งใน 15 นาที IP นั้นจะถูกพัก 15 นาที
- ตัวกลางระหว่างหน้าเว็บกับ database = Neon Function `api/index.mjs` (project `hylme-dashboard`)

| ไฟล์ | ขึ้น git? | คืออะไร |
|---|---|---|
| `index.html` | ✅ | หน้าเว็บ (โค้ดอย่างเดียว ~1.6 MB) |
| `vendor/` | ✅ | SheetJS 0.20.3 (อ่าน/เขียน Excel) — เก็บไว้ใน repo ไม่ดึงจาก CDN |
| `api/` | ✅ | โค้ด Neon Function |
| `tools/build.mjs` | ✅ | สคริปต์สร้าง index.html / ส่งข้อมูลเข้า database |
| `private/` | ❌ | ไฟล์ต้นฉบับที่มีข้อมูลจริง + `neon.json` (ที่อยู่ database) — **ห้ามอัปขึ้น git** |

## อัปเดตข้อมูลประจำวัน (ไม่ต้องใช้คำสั่ง)
1. เปิดหน้าเว็บ → กด 🔒 → ใส่รหัส
2. เข้าหลังบ้าน → อัปโหลดไฟล์ → กด **⬆ บันทึกลง Database**
   - ระบบปิดชื่อ/เบอร์ + **สแกนหาข้อมูลจริงที่หลุด** ก่อนส่งทุกครั้ง (เจอ = ไม่ส่ง)
   - ทุกคนเห็นข้อมูลใหม่ทันทีที่ refresh ไม่ต้อง push git

## คำสั่ง (ต้องมี Node.js 18 ขึ้นไป — รันใน PowerShell / Terminal ของตัวเอง)
```
node tools/build.mjs                    # ข้อมูลใน private/dashboard.html -> database + index.html
node tools/build.mjs --from data.json   # ใช้ data.json (เข้ารหัสแล้ว) เป็นข้อมูลแทน
node tools/build.mjs --no-publish       # แก้โค้ดหน้าเว็บ: สร้าง index.html อย่างเดียว
node tools/build.mjs --unlock           # ข้อมูลจริงรอบล่าสุดจาก database -> private/dashboard.html
```
ก่อนส่ง/บันทึก build จะสแกนหาเบอร์/ชื่อจริงที่หลุด ถ้าเจอจะไม่ส่งและไม่เขียนไฟล์

## แก้โค้ด Function
```
cd api && npm install && npm run build      # ได้ dist/index.mjs
```
แล้ว zip `dist/index.mjs` เป็น `index.mjs` ไฟล์เดียว และ deploy ขึ้น function `hylme` ของ branch `main`
(Neon Console / Neon CLI `neon functions deploy hylme --src dist/index.mjs --no-bundle`)
