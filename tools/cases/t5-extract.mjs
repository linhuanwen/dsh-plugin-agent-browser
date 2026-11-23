import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'C:/Users/林焕文/.dsh/office-kit/outputs/session-0bd31ac1bfd4f3c12fb6e8cc/891d60e6-7c19-48e7-b1d6-208988e16318/公平竞争审查条例实施办法.txt';
const text = readFileSync(SRC, 'utf8').replace(/\uFEFF/g, '');

const chapters = [...text.matchAll(/第[一二三四五六七八九十]+章\s*[^\u4e00-\u9fa5]?[^。]{0,20}/g)]
  .map((m) => m[0].replace(/\s+/g, ' ').trim());

const articles = [...text.matchAll(/第[一二三四五六七八九十百]+条/g)].map((m) => m[0]);
const uniq = [...new Set(articles)];

const tail = text.slice(-600);
const head = text.slice(0, 400);

writeFileSync('tools/cases/t5-extract.json', JSON.stringify({
  bytes: Buffer.byteLength(text, 'utf8'),
  chars: text.length,
  chapters,
  articleCount: uniq.length,
  lastArticles: uniq.slice(-4),
  head: head.replace(/\s+/g, ' '),
  tail: tail.replace(/\s+/g, ' '),
}, null, 2), 'utf8');
console.log('ok');
