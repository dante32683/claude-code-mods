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
// then, not at the next prompt. Windows only: the folder comes from %TEMP% via cmd.
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
}

// told: the last prompt note's signature; working: peers seen working at the
// last check; named: when each peer was last named to Claude as working.
type Me = { beat: Beat; told: string; working: Set<string>; checked: number; named: Map<string, number> }
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

const ago = (ms: number) => (ms < 90_000 ? 'just now' : `${Math.round(ms / 60_000)} min ago`)

const HEAD = 'repo-peers: other Claude chats are working in this repo:'
export const STARTED_HEAD = 'repo-peers: while this turn ran, another Claude chat started working in this repo:'

export function peerNote(self: Beat, peers: Beat[], now: number, head = HEAD): { text: string | null; sig: string } {
  const mine = new Set(self.files)
  const rows = peers.map(p => ({ p, shared: p.files.filter(f => mine.has(f)) }))
  const sig = rows.map(r => `${r.p.id}:${r.p.checkout === self.checkout ? 'same' : 'other'}:${r.shared.join(',')}`).join('|')
  if (!rows.length) return { text: null, sig }
  const lines = [head]
  for (const { p, shared } of rows) {
    const where = p.checkout === self.checkout ? `same checkout (${p.branch})` : `worktree ${p.checkout} (${p.branch})`
    const name = p.title ? `"${p.title}"` : `chat starting "${p.firstPrompt}"`
    const state = p.working ? `working now (updated ${ago(now - p.updated)})` : `idle since ${ago(now - p.updated)}`
    lines.push(`- ${name}: ${where}, ${state}`)
    if (shared.length) lines.push(`  edited the same files as this chat: ${shared.join(', ')}`)
    else if (p.files.length) lines.push(`  edited: ${p.files.slice(-6).join(', ')}`)
  }
  lines.push('If your work could collide with one (same files, branch, commits or a running gate), find it with list_sessions and send it a short send_message on what you are changing and how to stay clear.')
  return { text: lines.join('\n'), sig }
}

const rel = (path: string) => (me ? norm(path).replace(me.beat.checkout + '/', '') : norm(path))

function editedPath(tool: string, input: unknown): string | null {
  if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) || !input || typeof input !== 'object') return null
  const i = input as Record<string, unknown>
  const p = i.file_path ?? i.notebook_path
  return typeof p === 'string' ? p : null
}

// Peers working now that weren't at the last check and haven't been named
// recently. Updates the check state either way.
function started(peers: Beat[], now: number): Beat[] {
  if (!me) return []
  const fresh = peers.filter(p => p.working && !me!.working.has(p.id) && now - (me!.named.get(p.id) ?? -Infinity) >= RENAME_MS)
  me.working = new Set(peers.filter(p => p.working).map(p => p.id))
  me.checked = now
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
      const beat: Beat = { id: e.session_id, ...g, title: '', firstPrompt: e.prompt.replace(/\s+/g, ' ').slice(0, 80), files: [], working: true, updated: now, ended: false }
      me = { beat, told: '', working: new Set(), checked: 0, named: new Map() }
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
    const path = editedPath(e.tool_name, e.tool_input)
    if (path || now - me.beat.updated >= BEAT_MS) {
      const files = path ? [...me.beat.files.filter(f => f !== rel(path)), rel(path)].slice(-MAX_FILES) : me.beat.files
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
