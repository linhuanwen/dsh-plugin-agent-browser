import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const dir = join('research', 'R8-交付链', 'assets')
mkdirSync(dir, { recursive: true })

const rows = [
  ['项目名称', '项目编号', '采购人', '中标供应商', '中标金额_元', '金额原文', '公告日期', '地区', '公告类型', '详情URL', '列表页码'],
  ['合肥工业大学算力服务器及工作站设备采购项目', 'HFUT-DX-2026-0034/ZB202609082', '合肥工业大学', '合肥市百陌电子科技有限公司', '1446200', '144.6200000（万元）', '2026-11-20', '安徽', '中标公告', 'http://www.ccgp.gov.cn/cggg/zygg/zbgg/202611/t20261120_27721283.htm', '1'],
  ['生物育种钟山实验室高性能计算服务器（采购包1）', 'JSZC-320100-JZCG-G2026-0391', '生物育种钟山实验室', '中电鸿信信息科技有限公司', '5980000', '5980000元', '2026-11-18', '江苏', '中标公告', 'http://www.ccgp.gov.cn/cggg/dfgg/zbgg/202611/t20261118_27708674.htm', '1'],
  ['张家港市公安局存储服务器建设', 'JSZC-320582-JZCG-G2026-0039', '张家港市公安局（机关）', '国泰新点软件股份有限公司', '3980000', '3980000元', '2026-11-18', '江苏', '中标公告', 'http://www.ccgp.gov.cn/cggg/dfgg/zbgg/202611/t20261118_27704873.htm', '1'],
]

const esc = (v) => `"${String(v).replace(/"/g, '""')}"`
const csv = rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n'
writeFileSync(join(dir, 'data.csv'), csv, 'utf8')

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const shotList = join(dir, 'shot-list.png')
const shotDetail = join(dir, 'shot-detail.png')
const b1 = readFileSync(shotList)
const b2 = readFileSync(shotDetail)

const SEARCH_1 = 'https://search.ccgp.gov.cn/bxsearch?searchtype=1&page_index=1&bidSort=0&buyerName=&projectId=&pinMu=0&bidType=7&dbselect=bidx&kw=%E6%9C%8D%E5%8A%A1%E5%99%A8&start_time=2026%3A10%3A20&end_time=2026%3A11%3A20&timeType=3&displayZone=&zoneId=&pppStatus=0&agentName='
const SEARCH_2 = SEARCH_1.replace('page_index=1', 'page_index=2')
const SEARCH_3 = SEARCH_1.replace('page_index=1', 'page_index=3')
const HFUT = 'http://www.ccgp.gov.cn/cggg/zygg/zbgg/202611/t20261120_27721283.htm'

const sources = {
  case: 'R8-delivery-chain',
  builtAt: '2026-11-20T16:00:00+08:00',
  timezone: 'Asia/Shanghai',
  items: [
    { id: 'S1', kind: 'search', title: '采购公告搜索：关键字「服务器」（标题检索）+ 中标公告 + 近1月', url: SEARCH_1, capturedAt: '2026-11-20T15:57:00+08:00', note: '共找到 167 条；查询日期 2026-10-20 至 2026-11-20' },
    { id: 'S2', kind: 'image', title: '搜索结果页截图（筛选状态与 3 条记录）', url: SEARCH_1, file: 'assets/shot-list.png', bytes: b1.length, width: b1.readUInt32BE(16), height: b1.readUInt32BE(20), sha256: sha(shotList), capturedAt: '2026-11-20T15:58:50+08:00' },
    { id: 'S3', kind: 'page', title: '合肥工业大学算力服务器及工作站设备采购项目中标结果公告', url: HFUT, capturedAt: '2026-11-20T15:56:40+08:00', note: '第 1 行数据来源' },
    { id: 'S4', kind: 'image', title: '详情页截图（中标金额 144.6200000 万元）', url: HFUT, file: 'assets/shot-detail.png', bytes: b2.length, width: b2.readUInt32BE(16), height: b2.readUInt32BE(20), sha256: sha(shotDetail), capturedAt: '2026-11-20T15:59:35+08:00' },
    { id: 'S5', kind: 'page', title: '生物育种钟山实验室高性能计算服务器中标公告', url: 'http://www.ccgp.gov.cn/cggg/dfgg/zbgg/202611/t20261118_27708674.htm', capturedAt: '2026-11-20T15:57:50+08:00', note: '第 2 行数据来源（采购包1）' },
    { id: 'S6', kind: 'page', title: '张家港市公安局存储服务器建设中标公告', url: 'http://www.ccgp.gov.cn/cggg/dfgg/zbgg/202611/t20261118_27704873.htm', capturedAt: '2026-11-20T15:58:10+08:00', note: '第 3 行数据来源' },
    { id: 'S7', kind: 'page', title: '搜索结果第 2 页', url: SEARCH_2, capturedAt: '2026-11-20T15:58:20+08:00', note: '20 条，用于去重比对' },
    { id: 'S8', kind: 'page', title: '搜索结果第 3 页', url: SEARCH_3, capturedAt: '2026-11-20T15:58:25+08:00', note: '20 条，用于去重比对；含「（二次）」重新招标案例' },
  ],
}

writeFileSync(join(dir, 'sources.json'), JSON.stringify(sources, null, 2), 'utf8')

console.log(JSON.stringify({ csvBytes: csv.length, sources: sources.items.length, files: readdirSync(dir) }, null, 2))
