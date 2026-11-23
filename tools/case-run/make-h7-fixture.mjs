// tools/case-run/make-h7-fixture.mjs — 生成 H7 用的可预期大小页面（含超宽表格，测 fitWidth）
import fs from 'node:fs';

const rows = [];
for (let i = 0; i < 60; i += 1) {
  rows.push(
    `<li id="row-${i}"><a href="/item/${i}">Entry number ${i} — agent browser hardening fixture</a><span>value ${i * 7}</span></li>`,
  );
}
const cells = [];
for (let i = 0; i < 12; i += 1) cells.push(`<th>column-${i}-wide-header</th>`);
// 1900px 宽的表格：fitWidth=true 时会被缩小，false 时出现横向滚动
const table = `<table style="width:1900px;border-collapse:collapse"><thead><tr>${cells.join('')}</tr></thead><tbody><tr>${cells.map((_, i) => `<td>cell ${i}</td>`).join('')}</tr></tbody></table>`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>H7 fixture — snapshot budget</title></head><body><h1>Hardening fixture</h1><p>Used by H7 to compare snapshot budgets.</p>${table}<ul>${rows.join('')}</ul></body></html>`;
fs.writeFileSync('tools/case-run/fixtures/h7-page.html', html, 'utf8');
console.log('bytes=' + Buffer.byteLength(html));
