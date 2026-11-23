import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const file = 'docs/cases/outputs/R8-交付链/assets/sources.json';
const doc = JSON.parse(readFileSync(file, 'utf8'));

function measure(path) {
  const bytes = readFileSync(path);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes: bytes.length, width, height, sha256 };
}

const stamp = '2026-11-20T17:30:00+08:00';
const updates = {
  S2: { title: '搜索结果页整页截图（筛选状态 + 15 条记录 + 页脚）', file: 'assets/shot-list.png' },
  S4: { title: '详情页整页截图（中标金额 144.6200000 万元 + 主要标的信息）', file: 'assets/shot-detail.png' },
};

for (const item of doc.items) {
  const patch = updates[item.id];
  if (!patch) continue;
  const m = measure('docs/cases/outputs/R8-交付链/' + patch.file);
  Object.assign(item, { title: patch.title, file: patch.file, ...m, capturedAt: stamp });
  item.note = `browser_screenshot 整页拼接（${m.width} × ${m.height}），${new Date(stamp).toISOString().slice(0, 10)} 重拍`;
}

writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
const brief = doc.items.filter((i) => i.kind === 'image').map((i) => `${i.id} ${i.width}x${i.height} ${i.bytes}B ${i.sha256.slice(0, 12)}`);
console.log(brief.join('\n'));
