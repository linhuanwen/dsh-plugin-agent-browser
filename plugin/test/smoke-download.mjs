import { createTools } from '../tools.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'smoke-'))
const ctx = { get: () => ({ ensure: async () => root }) }
const tools = createTools(ctx, {}, {})
console.log('tools:', tools.map((tool) => tool.name).join(', '))

const download = tools.find((tool) => tool.name === 'browser_download')
const value = await download.execute({ url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf' }, { agent: { id: 'a' } })
console.log('result:', JSON.stringify(value))
console.log('render:', download.output.render({}, value)[0].text)

const missing = await download.execute({ url: 'https://example.com/definitely-missing-404.pdf' }, { agent: { id: 'a' } })
console.log('404:', JSON.stringify(missing))
console.log('render404:', download.output.render({}, missing)[0].text.split('\n')[0])

const blocked = await download.execute({ url: 'file:///C:/Windows/win.ini' }, { agent: { id: 'a' } })
console.log('file:', JSON.stringify(blocked))
