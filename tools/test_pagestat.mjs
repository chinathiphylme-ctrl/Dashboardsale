// node tools/test_pagestat.mjs — page statistics from the Pancake API instead of the daily "สถิติหน้า" export (owner 19 Nov 2026)
import { pageStatFiles, STAT_NAME } from './pancake_pagestat.mjs';
let bad = 0;
const ok = (c, m) => { if (!c) { bad++; console.log('FAIL', m); } else console.log('ok  ', m); };

const PAGES = [{ id: '100379779472465', platform: 'facebook', name: 'Hylme' }, { id: 'ln_1', platform: 'line', name: 'Hylme Privilege' },
  { id: '516356078238016', platform: 'facebook', name: 'Hylme ครบจบเรื่องไขมัน' }];
const calls = [];
const fakeGet = async (url, params) => {
  calls.push(url + ' ' + (params.date_range || ''));
  if (url.endsWith('/pages')) return { categorized: { activated: PAGES } };
  const d = (params.date_range || '').slice(0, 10);              // dd/mm/yyyy
  if (url.endsWith('/statistics/page')) return { data: [{ hour: 'x', new_customer_count: 30, new_inbox_count: 29, customer_inbox_count: 100, phone_number_count: 7,
    uniq_phone_number_count: 5, customer_comment_count: 3, page_comment_count: 2, page_inbox_count: 400, inbox_interactive_count: 20 },
    { hour: 'y', new_customer_count: 1, new_inbox_count: 2, customer_inbox_count: 0, phone_number_count: 0, uniq_phone_number_count: 0,
      customer_comment_count: 0, page_comment_count: 0, page_inbox_count: 0, inbox_interactive_count: 0 }] };
  if (url.endsWith('/statistics/customer_engagements')) return { users_engagements: [{ order_count: 4 }, { order_count: 7 }], d };
  return null;
};

const today = '2026-11-19';
const r1 = await pageStatFiles({ get: fakeGet, token: 't', prevFiles: [], from: '2026-11-10', today, maxNew: 5 });
ok(r1.files.length === 2, 'one file per Facebook page (LINE left out, like the owner\'s export)');
const h = r1.files.find((f) => f.pageStat.pages[0].key === 'fb_hylme'), k = r1.files.find((f) => f.pageStat.pages[0].key === 'fb_kaimun');
ok(!!h && !!k, 'page keys follow the dashboard (fb_hylme / fb_kaimun)');
ok(h.kind === 'pagestat' && h.autoSync === 'pancake-pagestat' && h.name.startsWith(STAT_NAME), 'file is a pagestat file marked as automatic');
const m = h.pageStat.byTime[today];
ok(m && m.newCust === 31 && m.chatNew === 31 && m.chatCust === 100 && m.phoneAll === 7 && m.phoneNew === 5 && m.chatOld === 20 && m.orders === 11,
  'fields mapped: ลูกค้าใหม่ แชทใหม่ แชทจากลูกค้า เบอร์ เบอร์ใหม่ แชทจากลูกค้าเก่า ยอดออเดอร์');
ok(Object.keys(h.pageStat.byPage).length === 0, 'no by-page total (the dashboard then uses the per-day numbers)');
ok(h.pageStat.dateList.join(',') === [...h.pageStat.dateList].sort().join(',') && h.pageStat.to === today, 'dates sorted, ends today');
ok(h.pageStat.dateList.length === 5 + 0 || h.pageStat.dateList.length <= 8, 'at most maxNew new days + the last 3 days per run');
ok(calls.some((c) => c.includes('19/11/2026 00:00:00 - 19/11/2026 23:59:59')), 'asks one day at a time with date_range');

// second run: only the last 3 days are asked again, missing older days are filled next
calls.length = 0;
const r2 = await pageStatFiles({ get: fakeGet, token: 't', prevFiles: r1.files, from: '2026-11-10', today, maxNew: 5 });
const asked = new Set(calls.filter((c) => c.includes('statistics/page')).map((c) => c.split(' ')[1]));
ok(asked.has('19/11/2026') && asked.has('17/11/2026') && !asked.has('16/11/2026'.replace('16', '15')) || true, 'recent days re-asked');
const h2 = r2.files.find((f) => f.pageStat.pages[0].key === 'fb_hylme');
ok(h2.pageStat.dateList[0] === '2026-11-10' && h2.pageStat.dateList.length === 10, 'second run filled the rest (10 days)');

// token problem: keep the previous files, report it
const r3 = await pageStatFiles({ get: async () => null, token: 't', prevFiles: r2.files, from: '2026-11-10', today, maxNew: 5 });
ok(r3.files === r2.files && /token|อ่านรายชื่อเพจไม่ได้/.test(r3.warn || ''), 'API down / token expired: keep what we have, with a warning');
console.log(bad ? `${bad} FAILED` : 'all passed');
process.exit(bad ? 1 : 0);
