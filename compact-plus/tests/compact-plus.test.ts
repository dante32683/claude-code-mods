import { expect, mock, test } from 'claude-code/testing'
import * as lib from '../hooks/lib.js'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const DIR = 'C:/Users/x/.claude/compact-history/sess-1'

const user = (text: string, handle?: string) => ({ role: 'user', text, toolUses: [], handle })
const assistant = (text: string, handle?: string, toolUses: unknown[] = []) => ({ role: 'assistant', text, toolUses, handle })

const transcript = [
  user('Please fix the parser bug in src/parse.ts', 'h1'),
  assistant('Looking at it.', 'h2', [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'rg parse src' }, text: 'src/parse.ts:12: parse()' }]),
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'src/parse.ts:12: parse()' }], handle: 'h3' },
  user('<task-notification>agent done</task-notification>', 'h4'),
  user('Also keep the old API working, do not rename parse()', 'h5'),
  assistant('Fixed; tests pass.', 'h6'),
  user('Thanks, now commit it', 'h7'),
  assistant('Committed as abc1234.', 'h8'),
]

// The engine beneath the plugin: env, ids, clock, files, and a core compaction
// that keeps the last user and assistant messages verbatim.
const norm = (p: unknown) => String(p).replace(/\\/g, '/')

type Seen = { instructions?: string; compactCalls: number; failWrite?: boolean; dirs?: string[] }

function engine(on: any, files: Map<string, string>, seen: Seen) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:\\Users\\x', OS: 'Windows_NT' })
  on('fs.list', () => ({ value: (seen.dirs ?? []).map((name) => ({ name, kind: name.includes('.') ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false })) }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.write', ($: any, e: any) => {
    if (seen.failWrite) throw new Error('disk full')
    files.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', ($: any, e: any) => ({ value: files.has(norm(e.path)) }))
  on('fs.read', ($: any, e: any) => {
    if (!files.has(norm(e.path))) throw new Error('ENOENT ' + norm(e.path))
    return { value: files.get(norm(e.path)) }
  })
  on('session.compact', ($: any, e: any) => {
    seen.compactCalls++
    seen.instructions = e.instructions
    return { messages: [user('SUMMARY', 's1'), ...(e.messages ?? []).slice(-2)], tokensBefore: 300000, tokensAfter: 18000 }
  })
  return clock
}

const summaryRow = (text = 'This session is being continued from a previous conversation. SUMMARY') => ({
  door: 'compaction',
  origin: { kind: 'engine' },
  uuid: 'row-1',
  message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
})

test('personText drops machine rows and system reminders', () => {
  expect(lib.personText('<task-notification>x</task-notification>')).toBe('')
  expect(lib.personText('This session is being continued from a previous conversation...')).toBe('')
  expect(lib.personText('fix it <system-reminder>noise</system-reminder>')).toBe('fix it')
})

test('selectVerbatim keeps carried messages first and fits the budget newest first', () => {
  const carried = lib.renderVerbatim([{ text: 'old one' }, { text: 'old two' }])
  const messages = [user(`This session is being continued from a previous conversation.\n${carried}`), ...transcript]
  const all = lib.selectVerbatim(messages as any, 8000).map((v) => v.text)
  expect(all).toEqual([
    'old one',
    'old two',
    'Please fix the parser bug in src/parse.ts',
    'Also keep the old API working, do not rename parse()',
    'Thanks, now commit it',
  ])
  const small = lib.selectVerbatim(messages as any, 60).map((v) => v.text)
  expect(small[small.length - 1]).toBe('Thanks, now commit it')
  expect(small.length < all.length).toBe(true)
  expect(lib.selectVerbatim(messages as any, 0)).toEqual([])
})

test('renderHistory lists messages and tool calls, skipping bare tool-result rows', () => {
  const text = lib.renderHistory(transcript as any, { sessionId: 'sess-1', at: 'now', trigger: 'auto' })
  expect(text.includes('## [0] user\n\nPlease fix the parser bug')).toBe(true)
  expect(text.includes('### tool Bash')).toBe(true)
  expect(text.includes('input: {"command":"rg parse src"}')).toBe(true)
  expect(text.includes('## [2] user')).toBe(false)
})

test('stripInstructionText removes frontmatter and comments', () => {
  expect(lib.stripInstructionText('---\na: 1\n---\n# Rules\r\n<!-- hidden -->keep\n')).toBe('# Rules\nkeep\n')
  expect(lib.sameText('a  \r\nb\n', 'a\nb')).toBe(true)
})

test('a compaction writes the history file, adds handoff instructions, and appends messages and a pointer to the summary row', async ($, on) => {
  const files = new Map<string, string>()
  const seen = { compactCalls: 0 } as { instructions?: string; compactCalls: number }
  engine(on, files, seen)
  mock.session(on)

  const result: any = await $.session.compact({ instructions: 'keep the parser notes', messages: transcript, trigger: 'auto' } as any)
  expect(result.messages.length).toBe(3)
  expect(seen.compactCalls).toBe(1)
  expect(seen.instructions!.startsWith('keep the parser notes\n\nExtra instructions from the compact-plus mod:')).toBe(true)
  expect(seen.instructions!.includes('from the one beginning "Please fix the parser bug')).toBe(true)

  const historyFile = [...files.keys()].find((k) => k.endsWith('.md'))!
  expect(historyFile.startsWith(`${DIR}/2026-10-20T120000Z-`)).toBe(true)
  expect(files.get(historyFile)!.includes('Committed as abc1234.')).toBe(true)
  expect(files.get(`${DIR}/log.jsonl`)!.includes('"event":"compact"')).toBe(true)

  const stored: any = await $.session.append(summaryRow() as any)
  const texts = stored.message.content.map((b: any) => b.text)
  expect(texts.length).toBe(3)
  expect(texts[1].includes('<user-messages-verbatim>')).toBe(true)
  expect(texts[1].includes('do not rename parse()')).toBe(true)
  // The engine kept "Thanks, now commit it" verbatim itself, so the block leaves it out.
  expect(texts[1].includes('Thanks, now commit it')).toBe(false)
  expect(texts[2].includes(historyFile)).toBe(true)
  expect(texts[2].includes(`rg -n "<term>" "${DIR}"`)).toBe(true)

  // Only the next summary row gets the blocks.
  const again: any = await $.session.append(summaryRow() as any)
  expect(again.message.content.length).toBe(1)
})

test('a failed history write costs only the file: instructions and verbatim messages still go', async ($, on) => {
  const seen = { compactCalls: 0, failWrite: true } as { instructions?: string; compactCalls: number; failWrite?: boolean }
  engine(on, new Map(), seen)
  mock.session(on)
  const result: any = await $.session.compact({ instructions: 'mine', messages: transcript, trigger: 'manual' } as any)
  expect(result.messages.length).toBe(3)
  expect(seen.instructions).toStartWith('mine\n\nExtra instructions from the compact-plus mod:')
  const stored: any = await $.session.append(summaryRow() as any)
  const added = stored.message.content.slice(1).map((b: any) => b.text)
  expect(added.length).toBe(1)
  expect(added[0]).toContain('<user-messages-verbatim>')
})

test('prompt.context swaps a stale instruction file for the copy on disk, leaving memory alone', async ($, on) => {
  const files = new Map<string, string>([
    ['C:/repo/AGENTS.md', '# Rules\nnew rule\n'],
    ['C:/Users/x/.claude/CLAUDE.md', '# Mine\nsame\n'],
    ['C:/mem/MEMORY.md', 'changed memory'],
  ])
  engine(on, files, { compactCalls: 0 })
  const instructionFiles = [
    { path: 'C:/repo/AGENTS.md', kind: 'project', content: '# Rules\nold rule' },
    { path: 'C:/Users/x/.claude/CLAUDE.md', kind: 'user', content: '# Mine\nsame' },
    { path: 'C:/mem/MEMORY.md', kind: 'memory', content: 'memory as loaded' },
  ]
  on('prompt.context', ($: any, e: any) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))
  const result: any = await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'x' }], instructionFiles } as any)
  expect(result.instructionFiles.map((f: any) => f.content)).toEqual(['# Rules\nnew rule\n', '# Mine\nsame', 'memory as loaded'])

  const unchanged: any = await $.prompt.context({ blocks: [], instructionFiles: [instructionFiles[1]] } as any)
  expect(unchanged.instructionFiles[0]).toEqual(instructionFiles[1])
})

test('turn end compacts once when the context is near the threshold', async ($, on) => {
  const seen = { compactCalls: 0 } as { instructions?: string; compactCalls: number }
  const clock = engine(on, new Map(), seen)
  let tokens = 200000
  on('session.usage', ($: any, e: any) => ({
    value: {
      startedAt: NOW,
      context: { tokens, window: 1000000, percent: 20, breakdown: e?.breakdown ? { autoCompactThreshold: 337000, isAutoCompactEnabled: true } : undefined },
      rateLimits: {},
      cost: { usd: 0 },
    },
  }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  const done = { turnId: 't', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' }

  await $.turn.complete(done as any)
  await clock.advance(2000)
  expect(seen.compactCalls).toBe(0)

  // Past 90% of the threshold: one compaction, even if two turns end before it starts.
  tokens = 310000
  await $.turn.complete(done as any)
  await $.turn.complete(done as any)
  await clock.advance(2000)
  expect(seen.compactCalls).toBe(1)

  // A subagent's turn or an interrupted one never compacts.
  await $.turn.complete({ ...done, agentId: 'a1' } as any)
  await $.turn.complete({ ...done, reason: 'aborted', isAborted: true } as any)
  await clock.advance(2000)
  expect(seen.compactCalls).toBe(1)
})

test('the first compaction of a session deletes history folders idle for 30 days', async ($, on) => {
  const old = '11111111-1111-1111-1111-111111111111'
  const recent = '22222222-2222-2222-2222-222222222222'
  const files = new Map<string, string>()
  engine(on, files, { compactCalls: 0, dirs: [old, recent, 'sess-1', 'notes.txt'] })
  mock.session(on)
  on('fs.stat', ($: any, e: any) => ({ value: { kind: 'file', size: 1, isLink: false, mtimeMs: String(e.path).includes(old) ? NOW - 40 * 86400000 : NOW - 86400000 } }))
  const runs: string[][] = []
  on('process.run', ($: any, e: any) => (runs.push(e.argv), { value: { exitCode: 0, stdout: '', stderr: '' } }))
  await $.session.compact({ messages: transcript, trigger: 'auto' } as any)
  await $.session.compact({ messages: transcript, trigger: 'auto' } as any)
  expect(runs).toEqual([['cmd', '/c', 'rd', '/s', '/q', `C:\\Users\\x\\.claude\\compact-history\\${old}`]])
})
