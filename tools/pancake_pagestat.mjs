// สถิติหน้าเพจจาก Pancake API แทนการ export ไฟล์ "สถิติหน้า" ทุกเช้า (owner 19 พ.ย. 69)
// ตรวจแล้ว: 11–18 พ.ย. ทุกคอลัมน์ตรงกับไฟล์ pages_statistics_page_*.xlsx (ลูกค้าใหม่ / แชทใหม่ 24/24 วัน-เพจ)
//   /pages/{id}/statistics/page?date_range=dd/mm/yyyy 00:00:00 - dd/mm/yyyy 23:59:59  -> รายชั่วโมง (บวกเป็นรายวัน)
//   /pages/{id}/statistics/customer_engagements (date_range เดียวกัน)               -> order_count ของแอดมิน = "ยอดออเดอร์"
// ได้ไฟล์ kind 'pagestat' หนึ่งไฟล์ต่อเพจ Facebook (เหมือนไฟล์ที่เจ้าของดึง: 3 เพจ FB) — หน้าเว็บใช้ยอดรายวันรายเพจ
// รอบละ: ถามใหม่ 3 วันล่าสุดเสมอ (ตัวเลขยังขยับ) + เติมวันที่ยังไม่มีไม่เกิน maxNew วันต่อเพจ (ใหม่ -> เก่า)
// อ่านอย่างเดียว (GET) · ใช้ token ตัวเดียวกับ HYLME_CRM_V3\tools\pancake_chats.py · ไม่มีข้อมูลลูกค้า
export const STAT_NAME = 'Pancake API สถิติหน้า (อัตโนมัติ)';
const API = 'https://pages.fm/api/v1';
const FIELDS = { newCust: 'new_customer_count', phoneAll: 'phone_number_count', phoneNew: 'uniq_phone_number_count',
  cmtCust: 'customer_comment_count', chatCust: 'customer_inbox_count', cmtPage: 'page_comment_count', chatPage: 'page_inbox_count',
  chatNew: 'new_inbox_count', chatOld: 'inbox_interactive_count' };
const blank = () => ({ newCust: 0, phoneAll: 0, phoneNew: 0, cmtCust: 0, chatCust: 0, cmtPage: 0, chatPage: 0, chatNew: 0, chatOld: 0, orders: 0 });
// ชื่อเพจ -> key เดียวกับ psPageKey ของหน้าเว็บ
export function pageKey(name) {
  const n = String(name || '');
  if (n.includes('ไขมัน')) return 'fb_kaimun';
  if (n.includes('ผิว')) return 'fb_piw';
  if (n.includes('นอน')) return 'fb_non';
  return 'fb_hylme';
}
const ymd = (d) => d.toISOString().slice(0, 10);
const dmy = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
function daysBetween(from, to) {
  const out = [];
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 864e5) out.push(ymd(new Date(t)));
  return out;
}

export async function defaultGet(url, params) {
  const q = new URLSearchParams(params).toString();
  try {
    const r = await fetch(url + '?' + q, { headers: { 'User-Agent': 'hylme-dashboard-sync' }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// -> { files, warn, asked }  (files = prevFiles เมื่ออ่านไม่ได้เลย)
export async function pageStatFiles({ get = defaultGet, token, prevFiles = [], from, today, maxNew = 40, pause = 250 }) {
  if (!token) return { files: prevFiles, warn: 'ไม่มี token ของ Pancake (HYLME_CRM_V3\\private\\Access Token.txt)', asked: 0 };
  const j = await get(API + '/pages', { access_token: token });
  const pages = (((j || {}).categorized || {}).activated || []).filter((p) => String(p.platform) === 'facebook');
  if (!pages.length) return { files: prevFiles, warn: 'อ่านรายชื่อเพจไม่ได้ — token อาจหมดอายุ (ใส่ใหม่ใน HYLME_CRM_V3\\private\\Access Token.txt)', asked: 0 };
  const prevBy = {};
  for (const f of prevFiles || []) if (f && f.autoSync === 'pancake-pagestat' && f.pageStat) prevBy[f.pageStat.pages[0].id] = f.pageStat.byTime || {};
  const all = daysBetween(from, today), recent = new Set(all.slice(-3));
  const out = []; let asked = 0, failed = 0;
  for (const p of pages) {
    const byTime = Object.assign({}, prevBy[p.id] || {});
    const want = all.filter((d) => recent.has(d) || !byTime[d]);
    const todo = want.filter((d) => recent.has(d)).concat(want.filter((d) => !recent.has(d)).reverse().slice(0, maxNew));
    for (const d of todo) {
      const dr = `${dmy(d)} 00:00:00 - ${dmy(d)} 23:59:59`;
      const s = await get(`${API}/pages/${p.id}/statistics/page`, { access_token: token, date_range: dr });
      const e = await get(`${API}/pages/${p.id}/statistics/customer_engagements`, { access_token: token, date_range: dr });
      asked++;
      if (!s || !Array.isArray(s.data) || !e) { failed++; continue; }    // keep the old number for that day
      const m = blank();
      for (const h of s.data) for (const k in FIELDS) m[k] += Number(h[FIELDS[k]]) || 0;
      m.orders = (e.users_engagements || []).reduce((n, u) => n + (Number(u.order_count) || 0), 0);
      byTime[d] = m;
      if (pause) await new Promise((r) => setTimeout(r, pause));
    }
    const dateList = Object.keys(byTime).sort();
    const key = pageKey(p.name), name = `${STAT_NAME} · ${p.name}`;
    out.push({ name, kind: 'pagestat', autoSync: 'pancake-pagestat',
      pageStat: { file: name, pages: [{ id: p.id, name: p.name, key }], byTime, byPage: {}, dateList,
        from: dateList[0] || null, to: dateList[dateList.length - 1] || null, rangeText: 'Pancake API', setId: key } });
  }
  return { files: out, warn: failed ? `ดึงสถิติหน้าไม่ได้ ${failed} วัน-เพจ (ใช้ตัวเลขเดิมไว้)` : '', asked };
}
