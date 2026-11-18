// node tools/test_thai_zip.mjs — tests the postcode auto-fill block of index.html (between the THAI ZIP markers)
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const prov = html.match(/const THAI_PROVINCES = [\s\S]*?\.sort\(\(a,b\)=>b\.length-a\.length\);/);
const fp = html.match(/function findProvinceInText\(text\)\{[\s\S]*?\n\}/);
const blk = html.match(/\/\* THAI ZIP START \*\/([\s\S]*?)\/\* THAI ZIP END \*\//);
if (!prov || !fp || !blk) { console.error('FAIL: THAI ZIP block (or province helpers) not found in index.html'); process.exit(1); }
const ctx = {};
vm.createContext(ctx);
vm.runInContext(prov[0] + '\n' + fp[0] + '\n' + blk[1] + '\nthis.lookupThaiZip = lookupThaiZip;', ctx);

const cases = [
  // the three real orders from the MC export (18 Nov 2026), names / house numbers trimmed
  ['810/22 เคหะนวมินทร์ ตึก 9 ซอยนวมินทร์ 139, นวลจันทร์/ Nuan Chan, บึงกุ่ม, กรุงเทพมหานคร', 'กรุงเทพมหานคร', '10230', false],
  ['เลขที่ 60 หมู่12, บ้านเลน/ Ban Len, บางปะอิน, พระนครศรีอยุธยา', 'พระนครศรีอยุธยา', '13160', false],
  ['99 หมู่ 3, อุโมงค์/ Umong, เมืองลำพูน, ลำพูน', 'ลำพูน', '51150', false],
  // district named like its province: must not grab the Mueang district just because the province is written
  ['12 ถ.ชีกุน, หัวรอ, พระนครศรีอยุธยา, พระนครศรีอยุธยา', 'พระนครศรีอยุธยา', '13000', false],
  ['5 ม.1, บ้านเลน, บางปะอิน, พระนครศรีอยุธยา', 'พระนครศรีอยุธยา', '13160', false],
  // free-text with prefixes
  ['1 ซ.สุขุมวิท 21 แขวงคลองเตยเหนือ เขตวัฒนา กรุงเทพฯ', 'กรุงเทพมหานคร', '10110', false, 'วัฒนา'],
  // subdistrict name that contains another district's name: the district written last wins
  ['9 แขวงบางซื่อ เขตบางซื่อ กรุงเทพมหานคร', 'กรุงเทพมหานคร', '10800', false, 'บางซื่อ'],
  ['7 แขวงลาดยาว เขตจตุจักร กรุงเทพมหานคร', 'กรุงเทพมหานคร', '10900', false, 'จตุจักร'],
  ['88 ต.ในเมือง อ.เมืองขอนแก่น จ.ขอนแก่น', 'ขอนแก่น', '40000', false],
  // "อ.เมือง" without the province suffix
  ['88 ต.ในเมือง อ.เมือง จ.ขอนแก่น', 'ขอนแก่น', '40000', false],
  // slightly-off addresses (owner 18 Nov: "มันอาจจะเลื่อมกันนิด ๆ") — filled, but fuzzy ones are flagged for a check
  ['10 อ เมือง จ สมุทรปราการ', 'สมุทรปราการ', '10270', false, 'เมืองสมุทรปราการ'],
  ['5 สี่คิ้ว จ นครราชสีมา', 'นครราชสีมา', '30140', false, 'สีคิ้ว', true],
  ['26/98 นวมินทร์ 113 แขวงนวลจันทร์', 'กรุงเทพมหานคร', '10230', false, 'บึงกุ่ม'],
  ['27/4หมู่1ต.ควนชะลิก', 'นครศรีธรรมราช', '80170', false, 'หัวไทร'],
  ['12/3 ม.2 ต.หัวรอ อ.เมือง จ.อยุธยา', null, '13000', false, 'พระนครศรีอยุธยา'],
  ['9 ต.ในเมือง อ.เมือง จ.โคราช', null, '30000', false, 'เมืองนครราชสีมา'],
  ['810/22เคหะนวมินทร์,นวลจันทร์,บึงกุ่ม,กรุงเทพมหานคร', 'กรุงเทพมหานคร', '10230', false, 'บึงกุ่ม'],
  ['99 ม.3 ต.อุโมงค์ อ.เมืองลำพูน', 'ลำพูน', '51150', false, 'เมืองลำพูน'],
  // markers decide: ต.แกลง is a subdistrict here, "อ.เมือง" is the district
  ['12 ต.แกลง อ.เมือง จ.ระยอง', 'ระยอง', '21160', false, 'เมืองระยอง'],
  // a street named after a district is not the district
  ['9 ซ.ลาดพร้าว 1 แขวงจอมพล เขตจตุจักร กรุงเทพมหานคร', 'กรุงเทพมหานคร', '10900', false, 'จตุจักร'],
  ['225 ถนนพญาไท แขวงวังใหม่ เขตปทุมวัน กรุงเทพมหานคร', 'กรุงเทพมหานคร', '10330', false, 'ปทุมวัน'],
  // a 2-letter district name inside another word must not match; written with a marker it does
  ['222 ถนนศรีจันทร์ ซอย16 อเมือง จขอนแก่น', 'ขอนแก่น', '40000', false, 'เมืองขอนแก่น'],
  ['5 ม.2 ต.โนนข่า อ.พล จ.ขอนแก่น', 'ขอนแก่น', '40120', false, 'พล'],
];
const nulls = [
  ['ฉัตรชนิ 197-199 ประจวบ', null],             // no district -> leave to a human
  ['12 หมู่ 4, ไม่มีอำเภอนี้, ขอนแก่น', 'ขอนแก่น'], // unknown district
  ['87 หมู่ 10', 'หนองบัวลำภู'],                 // house + province only
  ['474ซอยบ้านแช่', 'สมุทรปราการ'],
  ['(ตรงข้ามคอนโด) ซ.ลาดพร้าว 1', 'กรุงเทพมหานคร'],   // only a street name -> no district
];
let bad = 0;
for (const [addr, p, want, multi, dist, fuzzy] of cases) {
  const r = ctx.lookupThaiZip(addr, p);
  const ok = r && r.zip === want && !!r.multi === multi && (!dist || r.district === dist) && !!r.fuzzy === !!fuzzy;
  if (!ok) { bad++; console.log('FAIL', addr, '->', r, 'want', want); } else console.log('ok  ', want, r.district, r.sub || '');
}
for (const [addr, p] of nulls) {
  const r = ctx.lookupThaiZip(addr, p);
  if (r) { bad++; console.log('FAIL (want null)', addr, '->', r); } else console.log('ok   null', addr);
}
console.log(bad ? `${bad} FAILED` : 'all passed');
process.exit(bad ? 1 : 0);
