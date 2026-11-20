// node tools/test_returning_line.mjs — Returning Customer card: which channel returning customers buy through, % via LINE
// (owner 20 Nov 2026: wants old customers to come back through LINE instead of Facebook, which costs ads)
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
let bad = 0;
const ok = (c, m) => { if (!c) { bad++; console.log('FAIL', m); } else console.log('ok  ', m); };
const grab = (start, end) => { const i = html.indexOf(start); if (i < 0) return ''; const j = html.indexOf(end, i); return html.slice(i, j); };
const code = grab('const RET_CH_GROUPS', '\n/* ==') ;
const pct = grab('const retLinePct', '\nfunction retChLine');
ok(!!code && /function retChGroup/.test(code) && /function retByCh/.test(code), 'channel grouping helpers present');
ok(/data-metric="line"/.test(html) && /% ซื้อทาง LINE<\/th>/.test(html), 'chart button + table column');
ok(/byCh: retByCh\(retOrders\)/.test(html), 'each period carries returning orders by channel');
ok(/\+ retChLine\(R\)/.test(html), 'summary line shows the split for the selected period');
const ctx = { CRM_CH_LABEL: 'CRM (LINE)', TELESALES_CH_LABEL: 'Telesales (โทร)', withVat: (v) => +v * 1.07,
  channelLabel: (l) => l.ch, retPctTxt: (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%'), fmtNum: String };
vm.createContext(ctx);
vm.runInContext(code.replace(/^const /gm, 'var ') + '\n' + pct.replace(/^const /gm, 'var ') +
  '\nvar retSafe = p => p.returning; this.g=retChGroup; this.by=retByCh; this.pct=retLinePct;', ctx);
ok(ctx.g({ ch: 'CRM (LINE)' }) === 'LINE', 'CRM (LINE) = LINE');
ok(ctx.g({ ch: 'Facebook Hylme ครบจบเรื่องไขมัน' }) === 'Facebook' && ctx.g({ ch: 'Facebook Hylme' }) === 'Facebook' && ctx.g({ ch: 'Instagram' }) === 'Facebook', 'every Facebook page + Instagram = Facebook');
ok(ctx.g({ ch: 'Telesales (โทร)' }) === 'Telesales', 'Telesales');
ok(['Shopee', 'Website', 'ไม่ระบุช่องทาง', 'CRM'].every((c) => ctx.g({ ch: c }) === 'อื่น ๆ'), 'marketplace / website / unrecorded / old "CRM" = อื่น ๆ');
const b = ctx.by([{ ch: 'CRM (LINE)', 'Lead Value': 100 }, { ch: 'Facebook Hylme', 'Lead Value': 200 }, { ch: 'Facebook Hylme', 'Lead Value': 100 }]);
ok(b.LINE.orders === 1 && b.Facebook.orders === 2 && b.Telesales.orders === 0 && Math.abs(b.Facebook.sales - 321) < 0.01, 'orders and baht (with VAT) per channel');
ok(Math.abs(ctx.pct({ returning: { orders: 4, byCh: { LINE: { orders: 1 }, 'อื่น ๆ': { orders: 1 } } } }) - 0.25) < 1e-9, '% LINE = LINE orders ÷ returning orders');
ok(ctx.pct({ returning: { orders: 0, byCh: {} } }) === null, 'no returning orders: —');
ok(ctx.pct({ returning: { orders: 10, byCh: { LINE: { orders: 1 }, 'อื่น ๆ': { orders: 6 } } } }) === null, 'month with mostly unrecorded channel (before Jun 2026): —');
console.log(bad ? `${bad} FAILED` : 'all passed');
process.exit(bad ? 1 : 0);
