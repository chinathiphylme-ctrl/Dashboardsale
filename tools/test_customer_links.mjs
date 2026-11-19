// node tools/test_customer_links.mjs — one customer with several phones (owner 19 Nov 2026)
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
let bad = 0;
const ok = (c, m) => { if (!c) { bad++; console.log('FAIL', m); } else console.log('ok  ', m); };
const pick = (re, label) => { const m = html.match(re); if (!m) { bad++; console.log('FAIL', label, 'not found'); } return m ? m[0] : ''; };

const helpers = pick(/const digitsOnly = [\s\S]*?const isThaiPhone {4}= d => isThaiMobile\(d\) \|\| isThaiLandline\(d\);/, 'phone helpers')
  + '\n' + pick(/function normPhoneDigits\(d\)\{[\s\S]*?\n\}/, 'normPhoneDigits');
const blk = html.match(/\/\* CUSTOMER LINKS START \*\/([\s\S]*?)\/\* CUSTOMER LINKS END \*\//);
ok(!!blk, 'CUSTOMER LINKS block present');

if (blk) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(helpers + '\n' + blk[1] + '\nthis.F={custLinkMain,custLinkAdd,custLinkRemove,custLinksPublic' +
    (blk[1].includes('function custLinkSuggest') ? ',custLinkSuggest' : '') + '};', ctx);
  const F = ctx.F;
  const E = { links: {}, log: [] };
  const A = '0933051316', B = '0937099468', C = '0948246365', D = '0901101556';

  ok(F.custLinkMain({ links: { [A]: { main: B } } }, '093-305-1316') === B, 'main of the other phone (any format)');
  ok(F.custLinkMain({ links: { [A]: { main: B } } }, '0811111111') === '0811111111', 'unknown phone stays itself');
  ok(F.custLinkMain(E, D) === D && F.custLinkMain(null, D) === D, 'empty / missing list');

  const r1 = F.custLinkAdd(E, A, B, 'ซาร์', '2026-11-19T03:00:00Z');
  ok(r1.ok && r1.cl.links[A].main === B && r1.cl.log.length === 1 && r1.cl.log[0].action === 'link', 'link A -> B');
  ok(Object.keys(E.links).length === 0 && E.log.length === 0, 'input not mutated');

  const r2 = F.custLinkAdd(r1.cl, B, C, '', 't2');          // A->B exists, now B->C
  ok(r2.ok && r2.cl.links[A].main === C && r2.cl.links[B].main === C, 'chain: A->C and B->C');
  ok(F.custLinkAdd(r2.cl, C, A, '', 't3').error === 'loop', 'C -> A refused (loop)');
  ok(F.custLinkAdd(E, A, A, '', 't').error === 'same', 'same phone refused');
  ok(F.custLinkAdd(E, '12', B, '', 't').error === 'bad-phone', 'bad phone refused');
  ok(F.custLinkAdd(r2.cl, C, D, '', 't4').ok && F.custLinkAdd(r2.cl, C, D, '', 't4').cl.links[A].main === D, 'main re-pointed: everything follows');

  const r3 = F.custLinkRemove(r2.cl, B, 't5');
  ok(!r3.links[B] && r3.links[A].main === C && r3.log.at(-1).action === 'unlink', 'unlink B: A->C stays, log unlink');

  const pub = F.custLinksPublic(r1.cl, p => 'X' + p.slice(1));
  ok(pub.links['X' + A.slice(1)].main === 'X' + B.slice(1) && !('note' in pub.links['X' + A.slice(1)]), 'public: masked phones, no note');
  ok(pub.log[0].other === 'X' + A.slice(1) && pub.log[0].main === 'X' + B.slice(1), 'public: log masked too');

  if (F.custLinkSuggest) {
    const lead = (id, name, ph, zip) => ({ id, name, ph, zip });
    const leads = [lead(1, 'คุณนิธินาถ สินธุเดชะ', D, '10110'), lead(2, 'นิธินาถ สินธุเดชะ', '0809999051', '10110'),
      lead(3, 'นิธินาถ สินธุเดชะ', '0809999051', '10110'), lead(4, 'สมชาย ใจดี', '0822222222', '10110')];
    const g = F.custLinkSuggest(leads, E);
    ok(g.length === 1 && g[0].phones.length === 2 && g[0].phones[0].phone === '0809999051', 'suggest: one group, most orders first');
    const linked = F.custLinkAdd(E, D, '0809999051', '', 't').cl;
    ok(F.custLinkSuggest(leads, linked).length === 0, 'suggest: already linked pair is gone');
  }
}

// wiring in the page source
const has = (re, m) => ok(re.test(html), m);
has(/^let CUSTOMER_LINKS = \{"links":\{\},"log":\[\]\}; \/\*__CUSTOMER_LINKS_SLOT__\*\/$/m, 'slot line');
ok((html.match(/pub\.customerLinks && typeof CUSTOMER_LINKS !== 'undefined'\) CUSTOMER_LINKS = pub\.customerLinks/g) || []).length === 2, 'loads public links (2 paths)');
ok((html.match(/full\.customerLinks && typeof CUSTOMER_LINKS !== 'undefined'\) CUSTOMER_LINKS = full\.customerLinks/g) || []).length === 2, 'loads full links (2 paths)');
has(/customerLinks:CUSTOMER_LINKS/, 'real (encrypted) part carries the links');
has(/masked\.customerLinks = custLinksPublic\(/, 'public part gets masked links');
has(/return \{walk:root => \{ learnNames\(root\); return walk\(root\); \}, fakes:\(\) => new Set\(tailCache\.values\(\)\), phone:maskPhone\}/, 'masker exposes phone');
has(/function sig\(\)\{[\s\S]{0,900}CUSTOMER_LINKS/, 'unsaved-work signature includes the links');
has(/fillSlot\(html, 'let CUSTOMER_LINKS', '__CUSTOMER_LINKS_SLOT__'/, 'baked pages fill the slot');
if (/function custLinkSuggest/.test(html)) {
  has(/function buildCustomerIdentity\(\)\{[\s\S]{0,700}custLinkMain\(CUSTOMER_LINKS/, 'identity maps phones to the main phone');
  has(/id="custLinkCard"/, 'backend panel host');
}
// review fixes
const sync = readFileSync(new URL('./pancake_sync.mjs', import.meta.url), 'utf8');
ok(/realOut\.customerLinks = real\.customerLinks/.test(sync) && /masked\.customerLinks = pub\.customerLinks/.test(sync), 'Pancake sync keeps the links in both parts (it saves every 30 min)');
has(/function topSpenderRowsForAllTimeRaw\(\)\{[\s\S]{0,600}custLinkMain\(CUSTOMER_LINKS, leadPhone\(lead, info\)\)/, 'Top Spenders: one row per linked person');
has(/function buildContactRows\([\s\S]{0,900}custLinkMain\(CUSTOMER_LINKS, phone\)/, 'contact rows (monthly list / export): one row per linked person');
console.log(bad ? `${bad} FAILED` : 'all passed');
process.exit(bad ? 1 : 0);
