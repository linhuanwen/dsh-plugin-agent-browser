// tmp/patch-tool.mjs — 只用于 H 案例：在 profile patch 末尾插入/删除 agent-browser-panel 配置块
// 用法: node tmp/patch-tool.mjs set <file-with-yaml-body> | clear | check
import fs from 'node:fs';

const P = 'C:/Users/林焕文/.dsh/cordis.patch.yml';
const START = '# >>> h-cases start (自动生成，勿手改)';
const END = '# <<< h-cases end';
const mode = process.argv[2] ?? 'check';

const text = fs.readFileSync(P, 'utf8');
const strip = (s) => {
  const a = s.indexOf(START);
  if (a < 0) return s;
  const b = s.indexOf(END);
  const after = b < 0 ? '' : s.slice(b + END.length);
  return (s.slice(0, a) + after).replace(/\n{3,}/g, '\n\n');
};

const base = strip(text);

if (mode === 'clear') {
  fs.writeFileSync(P, base, 'utf8');
  console.log('cleared; chars=' + base.length + ' lines=' + base.split('\n').length);
} else if (mode === 'set') {
  const body = fs.readFileSync(process.argv[3], 'utf8').trimEnd();
  const next = base.replace(/\s*$/, '\n') + START + '\n' + body + '\n' + END + '\n';
  fs.writeFileSync(P, next, 'utf8');
  console.log('set; chars=' + next.length + ' lines=' + next.split('\n').length);
} else {
  const body = text.includes(START) ? text.slice(text.indexOf(START), text.indexOf(END) + END.length) : '(none)';
  console.log('chars=' + text.length + ' lines=' + text.split('\n').length + ' hasBlock=' + text.includes(START));
  console.log(body);
}
