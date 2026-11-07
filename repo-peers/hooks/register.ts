// repo-peers: other Claude chats in the same repo.
//
// Each session keeps a small heartbeat file of its own in %TEMP%/claude-peers
// (one writer per file, so no races): its repo, checkout, branch, title, first
// prompt, files it edited, and whether a turn is running. At each prompt the
// session reads its peers' files, and when the set of peers working in this
// repo changes, or a peer has edited a file this chat edited too, Claude gets
// a hidden note naming them and suggesting it message a peer whose work could
// collide. During a turn, tool calls also check (at most once a minute) for a
// peer that went from idle to working, so a chat that starts mid-task is named
// then, not at the next prompt. Files written by Bash (edits heredocs, cat >)
// count as edits. Windows only: the folder comes from %TEMP% via cmd.
import type { Register, EngineInterface } from 'claude-code'

export const ACTIVE_MS = 30 * 60_000 // a peer idle longer than this is left out
const MAX_FILES = 15
const BEAT_MS = 2 * 60_000
const CHECK_MS = 60_000 // how often a turn's tool calls look for peers that started
const RENAME_MS = 15 * 60_000 // a peer named as working within this isn't named again for starting

export type Beat = {
  id: string
  repo: string // git common dir: the same for every worktree of one repo
  checkout: string
  branch: string
  title: string
  firstPrompt: string
  files: string[]
  working: boolean
  updated: number
  ended: boolean
  started?: number // when this chat's first prompt ran (older beats lack it)
}

// told: the last prompt note's signature; working: peers seen working at the
// last check; named: when each peer was last named to Claude as working.
// seen: every peer this chat has read at least once.
type Me = { beat: Beat; told: string; working: Set<string>; checked: number; named: Map<string, number>; seen: Set<string> }
let me: Me | null = null
let dir: Promise<string | undefined> | undefined

function peersDir($: EngineInterface): Promise<string | undefined> {
  dir ??= $.process
    .run(['cmd', '/d', '/c', 'echo %TEMP%'])
    .then(r => {
      const d = r.stdout.trim().replaceAll('\\', '/')
      return r.exitCode === 0 && /^[A-Za-z]:\//.test(d) ? `${d}/claude-peers` : undefined
    })
    .catch(() => undefined)
  return dir
}

const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()

async function gitInfo($: EngineInterface, cwd: string) {
  const r = await $.process.run(['git', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel', '--abbrev-ref', 'HEAD'], { timeoutMs: 10_000 })
  if (r.exitCode !== 0) return null
  const [repo, checkout, branch] = r.stdout.trim().split(/\r?\n/)
  return repo && checkout ? { repo: norm(repo), checkout: norm(checkout), branch: branch ?? '' } : null
}

async function save($: EngineInterface): Promise<void> {
  const d = await peersDir($)
  if (d && me) await $.fs.write(`${d}/${me.beat.id}.json`, JSON.stringify(me.beat))
}

export async function readPeers($: EngineInterface, self: Beat, now: number): Promise<Beat[]> {
  const d = await peersDir($)
  if (!d) return []
  let entries
  try {
    entries = await $.fs.list(d)
  } catch {
    return []
  }
  const out: Beat[] = []
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.json') || e.name === `${self.id}.json`) continue
    if (typeof e.mtimeMs === 'number' && now - e.mtimeMs > ACTIVE_MS) continue
    try {
      const raw = await $.fs.read(`${d}/${e.name}`)
      const b = JSON.parse(typeof raw === 'string' ? raw : '') as Beat
      if (b.ended || b.repo !== self.repo || now - b.updated > ACTIVE_MS) continue
      out.push(b)
    } catch {}
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`

const HEAD = 'repo-peers: other chats in this repo'
export const STARTED_HEAD = 'repo-peers: while this turn ran, another chat started or became active in this repo'
const LISTED_FILES = 3

// Temp and scratch files, and paths outside the peer's checkout (absolute
// ones), say little about collisions here, so the edited list leaves them out.
const SCRATCH = /(^|\/)(\$[^/]*|te?mp|scratch(pad)?)\//i
const listable = (f: string) => !SCRATCH.test(f) && !/^[a-z]:\//i.test(f)
// The last three segments of a path: enough to recognize the file.
const short = (f: string) => f.split('/').slice(-3).join('/')

// One line per peer. Files this chat also edited are listed in full, since
// they are the collision warning; otherwise the peer's three latest files.
export function peerNote(self: Beat, peers: Beat[], now: number, head = HEAD): { text: string | null; sig: string } {
  const mine = new Set(self.files)
  const rows = peers.map(p => ({ p, shared: p.files.filter(f => mine.has(f)) }))
  const sig = rows.map(r => `${r.p.id}:${r.p.checkout === self.checkout ? 'same' : 'other'}:${r.shared.join(',')}`).join('|')
  if (!rows.length) return { text: null, sig }
  const allHere = peers.every(p => p.checkout === self.checkout && p.branch === self.branch)
  const lines = [allHere ? `${head} (same checkout, ${self.branch}):` : `${head}:`]
  for (const { p, shared } of rows) {
    const name = p.title ? `"${p.title}"` : `chat starting "${p.firstPrompt}"`
    const where = allHere ? '' : p.checkout === self.checkout ? `same checkout (${p.branch}), ` : `worktree ${p.checkout} (${p.branch}), `
    const state = p.working ? 'working now' : `idle ${minutes(now - p.updated)}`
    // A chat that began after this one is news to it.
    const isNew = p.started !== undefined && self.started !== undefined && p.started > self.started ? ', new chat' : ''
    const others = p.files.filter(f => !shared.includes(f) && listable(f))
    let edited = ''
    if (shared.length) edited = `; edited the same files as this chat: ${shared.join(', ')}${others.length ? `, +${others.length} more` : ''}`
    else if (others.length) {
      const listed = others.slice(-LISTED_FILES).reverse().map(short)
      edited = `; edited ${listed.join(', ')}${others.length > listed.length ? `, +${others.length - listed.length} more` : ''}`
    }
    lines.push(`- ${name}: ${where}${state}${isNew}${edited}`)
  }
  lines.push("If your work could collide with one, send it a short send_message on what you're changing.")
  return { text: lines.join('\n'), sig }
}

const rel = (path: string) => (me ? norm(path).replace(me.beat.checkout + '/', '') : norm(path))

// Git Bash and Windows absolute paths: /c/x, C:/x, C:\x, ~/x.
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/[A-Za-z]\/|~\/)/

function absolute(path: string, base: string, home: string): string {
  const p = path.trim().replace(/^(["'])(.*)\1$/, '$2')
  if (p.startsWith('~/')) return `${home}/${p.slice(2)}`
  const drive = /^\/([A-Za-z])\/(.*)$/.exec(p)
  if (drive) return `${drive[1]!.toUpperCase()}:/${drive[2]}`
  return ABSOLUTE.test(p) ? p : `${base}/${p}`
}

// Files a Bash command writes, for the edit add-on: the `=== path` lines of an
// `edits` heredoc and the target of `cat > file <<`. A leading `cd dir &&`
// sets the folder relative paths start from. Other writes (sed -i, scripts)
// are left out; this is a hint for overlap, not a full record. The command
// may arrive with bash-fixes' prefixes (its guards `source` and pipefail)
// ahead of the cd, so those are skipped first.
export function bashEdits(command: string, cwd: string, home: string): string[] {
  const body = command.replace(/^source '[^']*' 2>\/dev\/null; /, '').replace(/^set -o pipefail; /, '')
  const cd = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&/.exec(body)
  const base = cd ? absolute(cd[1]!, cwd, home) : cwd
  const out: string[] = []
  if (/\bedits\s+<</.test(command)) for (const m of command.matchAll(/^=== (.+)$/gm)) out.push(absolute(m[1]!, base, home))
  for (const m of command.matchAll(/\bcat\s+>>?\s*("[^"]+"|'[^']+'|[^\s<;&|]+)\s*<</g)) out.push(absolute(m[1]!, base, home))
  return out
}

function editedPaths(tool: string, input: unknown, cwd: string, home: string): string[] {
  if (!input || typeof input !== 'object') return []
  const i = input as Record<string, unknown>
  if (tool === 'Bash') return typeof i.command === 'string' ? bashEdits(i.command, cwd, home) : []
  if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return []
  const p = i.file_path ?? i.notebook_path
  return typeof p === 'string' ? [p] : []
}

// Peers to name since the last check: a chat that began after this one and
// hasn't been read before, whether or not it is still working (a short turn
// can start and end between two checks), and a peer that went from idle to
// working and hasn't been named recently. Updates the check state either way.
function started(peers: Beat[], now: number): Beat[] {
  if (!me) return []
  const m = me
  const fresh = peers.filter(p => {
    const isNew = !m.seen.has(p.id) && p.started !== undefined && m.beat.started !== undefined && p.started > m.beat.started
    const turned = p.working && !m.working.has(p.id) && now - (m.named.get(p.id) ?? -Infinity) >= RENAME_MS
    return isNew || turned
  })
  for (const p of peers) m.seen.add(p.id)
  m.working = new Set(peers.filter(p => p.working).map(p => p.id))
  m.checked = now
  return fresh
}

export const register: Register = on => {
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r = await next(e)
    if (e.agent_id) return r
    const now = await $.clock.now()
    if (!me || me.beat.id !== e.session_id) {
      const g = await gitInfo($, e.cwd)
      if (!g) return r
      const beat: Beat = { id: e.session_id, ...g, title: '', firstPrompt: e.prompt.replace(/\s+/g, ' ').slice(0, 80), files: [], working: true, updated: now, ended: false, started: now }
      me = { beat, told: '', working: new Set(), checked: 0, named: new Map(), seen: new Set() }
    }
    me.beat = { ...me.beat, title: e.session_title ?? me.beat.title, working: true, updated: now }
    await save($)
    const peers = await readPeers($, me.beat, now)
    const fresh = started(peers, now)
    const { text, sig } = peerNote(me.beat, peers, now)
    if (sig === me.told && !fresh.length) return r
    me.told = sig
    for (const p of peers) if (p.working) me.named.set(p.id, now)
    return text ? { ...r, additionalContext: [...(r.additionalContext ?? []), text] } : r
  }).catch(($, e, next) => next(e))

  // Every tool call keeps the heartbeat fresh (at most every 2 minutes), so a
  // long turn of Bash work doesn't read as idle; an edit is saved at once.
  on('classic.PostToolUse', async ($, e, next) => {
    const r = await next(e)
    if (!me) return r
    const now = await $.clock.now()
    let home = ''
    if (e.tool_name === 'Bash') {
      try {
        home = ((await $.env.get('USERPROFILE')) ?? '').replaceAll('\\', '/')
      } catch {}
    }
    const paths = editedPaths(e.tool_name, e.tool_input, (e.cwd ?? '').replaceAll('\\', '/'), home).map(rel)
    if (paths.length || now - me.beat.updated >= BEAT_MS) {
      const files = [...me.beat.files.filter(f => !paths.includes(f)), ...paths].slice(-MAX_FILES)
      me.beat = { ...me.beat, files, updated: now }
      await save($)
    }
    if (now - me.checked < CHECK_MS) return r
    const fresh = started(await readPeers($, me.beat, now), now)
    if (!fresh.length) return r
    for (const p of fresh) me.named.set(p.id, now)
    const { text } = peerNote(me.beat, fresh, now, STARTED_HEAD)
    return text ? { ...r, additionalContext: [...(r.additionalContext ?? []), text] } : r
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    if (me) {
      me.beat = { ...me.beat, working: false, updated: await $.clock.now() }
      await save($)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('classic.SessionEnd', async ($, e, next) => {
    const r = await next(e)
    if (me) {
      me.beat = { ...me.beat, working: false, ended: true }
      await save($)
    }
    return r
  }).catch(($, e, next) => next(e))
}
