// compact-plus: better compaction. The handoff-style summary instructions are
// modeled on OpenAI's Codex CLI.
//
// session.compact   writes the conversation about to be summarized to a searchable
//                   history file, adds handoff instructions for the summarizer, and
//                   picks the user's messages to keep word for word.
// session.append    appends those messages and a pointer to the history file to the
//                   summary row as the engine stores it (the engine's own summary
//                   message can't be edited from session.compact).
// prompt.context    checks instruction files against disk when the engine re-reads
//                   them (after a compaction), so a stale CLAUDE.md or AGENTS.md copy
//                   is swapped for the file as it is now; logged when it happens.
// turn.complete     compacts between turns, while the person reads, once the context
//                   is near the auto-compact threshold. In a headless host (the
//                   desktop app, the SDK, -p) that is a queued /compact.
//
// Everything fails open: on an error the engine's own behaviour runs unchanged.

import * as lib from './lib.js'

// Per-session state; a module reload starts it over.
const state = { pending: null, turnEndArmed: true, threshold: null, pruned: false }
const KEEP_DAYS = 30

async function historyDir($) {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) return null
  const id = await $.session.id()
  return `${home.replace(/\\/g, '/')}/.claude/compact-history/${id}`
}

async function log($, dir, entry) {
  try {
    const file = `${dir}/log.jsonl`
    const prior = (await $.fs.exists(file)) ? await $.fs.read(file) : ''
    await $.fs.write(file, prior + JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), ...entry }) + '\n')
  } catch {}
}

// Deletes this mod's history folders for sessions that last compacted over
// KEEP_DAYS ago (the age of each folder's log.jsonl), once per session.
async function pruneOld($, dir) {
  if (state.pruned) return
  state.pruned = true
  const root = dir.slice(0, dir.lastIndexOf('/'))
  const cutoff = (await $.clock.now()) - KEEP_DAYS * 86400000
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  for (const entry of await $.fs.list(root)) {
    if (entry.kind !== 'dir' || !/^[0-9a-f-]{36}$/.test(entry.name)) continue
    const folder = `${root}/${entry.name}`
    if (folder === dir) continue
    let mtime = 0
    try {
      mtime = (await $.fs.stat(`${folder}/log.jsonl`)).mtimeMs
    } catch {
      continue
    }
    if (mtime >= cutoff) continue
    const argv = isWindows ? ['cmd', '/c', 'rd', '/s', '/q', folder.replace(/\//g, '\\')] : ['rm', '-rf', folder]
    await $.process.run(argv, { timeoutMs: 20000 })
  }
}

async function prepare($, e, verbatimTokens) {
  const dir = await historyDir($)
  const verbatim = lib.selectVerbatim(e.messages, verbatimTokens)
  let file = null
  if (dir) {
    const now = await $.clock.now()
    file = `${dir}/${lib.stamp(now)}-${e.trigger}.md`
    const text = lib.renderHistory(e.messages, {
      sessionId: await $.session.id(),
      at: new Date(now).toISOString(),
      trigger: e.trigger,
    })
    // A failed write (over the 4 MiB limit, say) costs the file alone.
    await $.fs.write(file, text).catch(() => (file = null))
  }
  return { dir, file, verbatim }
}

// The auto-compact threshold changes only with the model or settings, so the
// breakdown that reports it is asked for at most every ten minutes.
async function autoCompactThreshold($) {
  const now = await $.clock.now()
  if (state.threshold && now - state.threshold.at < 600000) return state.threshold.value
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  const value = b && b.isAutoCompactEnabled && b.autoCompactThreshold ? b.autoCompactThreshold : 0
  state.threshold = { value, at: now }
  return value
}

async function isNearThreshold($, turnEndPercent) {
  const { context } = await $.session.usage()
  const threshold = context.tokens ? await autoCompactThreshold($) : 0
  return threshold > 0 && context.tokens >= (threshold * turnEndPercent) / 100
}

async function compactIfNear($, turnEndPercent) {
  state.turnEndArmed = false
  let near = false
  try {
    near = await isNearThreshold($, turnEndPercent)
  } finally {
    if (!near) state.turnEndArmed = true
  }
  if (!near) return
  const dir = await historyDir($)
  if (dir) await log($, dir, { event: 'turn-end-compact', percent: turnEndPercent })
  // A headless host (the desktop app, the SDK, -p) refuses $.session.compact:
  // compaction there runs as a /compact command, which queues until the session is idle.
  $.clock.after(1500, () => {
    $.session.compact()
      .catch(() => $.command.run({ command: 'compact' }))
      .catch(async (err) => {
        state.turnEndArmed = true
        if (dir) await log($, dir, { event: 'turn-end-compact-failed', error: String(err && err.message ? err.message : err).slice(0, 300) })
      })
  })
}

export function register(on, options) {
  const turnEndPercent = Number(options?.turnEndPercent ?? 90)
  const verbatimTokens = Number(options?.verbatimUserTokens ?? 8000)

  state.pending = null // blocks for the next summary row of the main conversation
  state.turnEndArmed = true // one turn-end compaction per context window
  state.threshold = null // { value, at }: the auto-compact threshold, cached
  state.pruned = false

  on('session.compact', async ($, e, next) => {
    // A subagent's or fork's own compaction: the handoff instructions alone.
    if (e.agentId) {
      let down = e
      try {
        down = { ...e, instructions: lib.joinInstructions(e.instructions, lib.handoffInstructions(null)) }
      } catch {}
      return next(down)
    }

    let prep = null
    let down = e
    try {
      prep = await prepare($, e, verbatimTokens)
      const extra = lib.handoffInstructions(prep.verbatim[0]?.text)
      down = { ...e, instructions: lib.joinInstructions(e.instructions, extra) }
    } catch {
      prep = null
      down = e
    }

    const result = await next(down)

    try {
      if (result && Array.isArray(result.messages) && e.trigger !== 'precompute') state.turnEndArmed = true
      if (result && Array.isArray(result.messages) && prep) {
        const kept = new Set(result.messages.map((m) => m.handle).filter(Boolean))
        const verbatim = prep.verbatim.filter((v) => !v.handle || !kept.has(v.handle))
        const blocks = []
        if (verbatim.length) blocks.push(lib.renderVerbatim(verbatim))
        if (prep.file) blocks.push(lib.pointerText(prep.file, prep.dir))
        state.pending = blocks.length ? blocks : null
        if (prep.dir) {
          await pruneOld($, prep.dir).catch(() => {})
          await log($, prep.dir, {
            event: 'compact',
            trigger: e.trigger,
            messages: e.messages.length,
            kept: result.messages.length - 1,
            verbatim: verbatim.length,
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter,
            file: prep.file,
          })
        }
      }
    } catch {}
    return result
  })

  on('session.append', { door: 'compaction' }, async ($, e, next) => {
    if (!state.pending || e.agentId || e.message.type !== 'user' || e.message.role !== 'user') return next(e)
    const blocks = state.pending
    state.pending = null
    const content = [...e.message.content, ...blocks.map((text) => ({ type: 'text', text }))]
    return next({ ...e, message: { ...e.message, content } })
  }).catch(($, e, next) => next(e))

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    try {
      const files = result.instructionFiles ?? e.instructionFiles
      if (!files || files.length === 0) return result
      const refreshed = []
      const fresh = await Promise.all(
        files.map(async (f) => {
          if (f.kind === 'memory' || f.kind === 'managed') return f
          let raw
          try {
            raw = await $.fs.read(f.path)
          } catch {
            return f
          }
          // The engine expands @imports into the content; disk text would drop them.
          if (typeof raw !== 'string' || /^@\S/m.test(raw)) return f
          const text = lib.stripInstructionText(raw)
          if (lib.sameText(text, f.content)) return f
          refreshed.push(f.path)
          return { ...f, content: text }
        }),
      )
      if (refreshed.length === 0) return result
      const dir = await historyDir($)
      if (dir) await log($, dir, { event: 'instructions-refreshed', files: refreshed })
      return { ...result, instructionFiles: fresh }
    } catch {
      return result
    }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (turnEndPercent > 0 && state.turnEndArmed && !e.agentId && e.reason === 'answer') {
      compactIfNear($, turnEndPercent).catch(() => {})
    }
    return result
  })
}
