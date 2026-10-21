// compact-plus helpers: pure functions, no `$`, so the tests can call them directly.

export const CHARS_PER_TOKEN = 4
export const VERBATIM_OPEN = '<user-messages-verbatim>'
export const VERBATIM_CLOSE = '</user-messages-verbatim>'
const VERBATIM_SEP = '\n--- user message ---\n'
const SUMMARY_START = 'This session is being continued from a previous conversation'
const PER_MESSAGE_CHARS = 8000
const TOOL_INPUT_CHARS = 2000
const TOOL_RESULT_CHARS = 12000

// User-role rows the engine or the app writes, not the person.
const MACHINE_PREFIXES = [
  '<system-reminder>',
  '<task-notification>',
  '<command-',
  '<local-command',
  '<side-sessions-event>',
  '<ci-monitor-event>',
  '<user-prompt-submit-hook>',
  '[Request interrupted',
  'Caveat:',
  SUMMARY_START,
]

export function cutMiddle(text, max, note = 'the full text is in the history file') {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return `${text.slice(0, head)}\n[... ${text.length - max} characters cut; ${note} ...]\n${text.slice(text.length - tail)}`
}

/** The person's own words in a user row, or '' when the row is machine text. */
export function personText(text) {
  const cleaned = (text ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  if (!cleaned || MACHINE_PREFIXES.some((p) => cleaned.startsWith(p))) return ''
  return cleaned
}

/** Messages carried in an earlier summary's verbatim block, oldest first. */
export function carriedMessages(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messages[i].role === 'user' ? messages[i].text ?? '' : ''
    const start = text.lastIndexOf(VERBATIM_OPEN)
    if (start < 0) continue
    const end = text.indexOf(VERBATIM_CLOSE, start)
    if (end < 0) continue
    const body = text.slice(start + VERBATIM_OPEN.length, end)
    return body
      .split(VERBATIM_SEP)
      .slice(1)
      .map((t) => t.trim())
      .filter(Boolean)
  }
  return []
}

/**
 * The person's messages to keep word for word, oldest first: those carried from
 * earlier summaries, then this window's, chosen newest first within the budget.
 * Each entry keeps the engine's handle when it has one, so a message the
 * engine keeps verbatim anyway can be left out later.
 */
export function selectVerbatim(messages, budgetTokens) {
  if (!(budgetTokens > 0)) return []
  const entries = carriedMessages(messages).map((text) => ({ text }))
  for (const m of messages) {
    if (m.role !== 'user') continue
    const text = personText(m.text)
    if (text) entries.push({ text, handle: m.handle })
  }
  let room = budgetTokens * CHARS_PER_TOKEN
  const chosen = []
  for (let i = entries.length - 1; i >= 0 && room > 200; i--) {
    const capped = cutMiddle(entries[i].text, Math.min(PER_MESSAGE_CHARS, room))
    chosen.push({ ...entries[i], text: capped })
    room -= capped.length + VERBATIM_SEP.length
  }
  return chosen.reverse()
}

export function renderVerbatim(entries) {
  const intro =
    "The user's own messages, word for word, oldest first. compact-plus keeps them across compactions; where the summary above paraphrases one, the wording here is what the user said."
  return `${VERBATIM_OPEN}\n${intro}\n${entries.map((e) => VERBATIM_SEP + e.text).join('\n')}\n${VERBATIM_CLOSE}`
}

export function pointerText(file, dir) {
  return [
    `compact-plus saved the conversation from before this compaction as searchable text: "${file}".`,
    `Earlier parts of this session are in the same folder. For exact wording, paths, commands, errors or tool output the summary left out, search there before asking the user or redoing work: rg -n "<term>" "${dir}"`,
  ].join('\n')
}

export function handoffInstructions(firstVerbatim) {
  const lines = [
    'Extra instructions from the compact-plus mod:',
    '- Write this as a handoff to another model that will continue the work with nothing but your summary. Open section 1 with the current goal and where it stands, in two or three sentences.',
    '- Keep exact identifiers: file paths, commands that worked, commit hashes, branch names, URLs, session and task ids, error text and numbers.',
    "- Record each decision with its reason, and the user's corrections and preferences in the user's own words.",
    '- Say what was verified (tests run, output checked) and what is assumed or untested.',
    '- List open promises: what you said you would do, what waits on the user, and background work still running (subagents, other sessions, background commands) with how to check on it.',
    '- Do not restate instruction files (CLAUDE.md, AGENTS.md, the memory index) or the system prompt; they are sent again after compaction.',
    '- The most recent messages may be kept verbatim after your summary, and you may not see them. In "Current Work", describe the last state you can see, and word the next step so it still holds if those messages already started it.',
  ]
  if (firstVerbatim) {
    const head = firstVerbatim.replace(/\s+/g, ' ').slice(0, 80)
    lines.push(
      `- The user's messages from the one beginning "${head}" onward are attached word for word after your summary. In section 6, give each of those one short line with its outcome instead of restating it.`,
    )
  }
  return lines.join('\n')
}

export function joinInstructions(own, extra) {
  return own && own.trim() ? `${own.trim()}\n\n${extra}` : extra
}

function toolInput(input) {
  try {
    return cutMiddle(JSON.stringify(input ?? {}), TOOL_INPUT_CHARS, 'see the transcript')
  } catch {
    return '(input not shown)'
  }
}

/** The pre-compaction conversation as plain text, one `## [n] role` heading per message. */
export function renderHistory(messages, meta) {
  const out = [
    `# Conversation before compaction`,
    ``,
    `Session ${meta.sessionId}, compacted ${meta.at} (${meta.trigger}), ${messages.length} messages. Written by the compact-plus mod.`,
    `Each message starts with a "## [n] role" line; tool calls follow as "### tool <name>" with their input and result (long results cut; the .jsonl transcript has everything).`,
    ``,
  ]
  messages.forEach((m, i) => {
    const uses = m.toolUses ?? []
    const text = (m.text ?? '').trim()
    if (m.role === 'user' && !text && (m.toolResults?.length ?? 0) > 0) return
    if (!text && uses.length === 0) return
    out.push(`## [${i}] ${m.role}`, '')
    if (text) out.push(text, '')
    for (const u of uses) {
      out.push(`### tool ${u.tool}${u.isError ? ' (error)' : ''}`, `input: ${toolInput(u.input)}`)
      if (typeof u.text === 'string') out.push('result:', cutMiddle(u.text, TOOL_RESULT_CHARS, 'see the transcript'))
      out.push('')
    }
  })
  return out.join('\n')
}

/** Instruction-file text as the engine loads it: no frontmatter, no HTML comments. */
export function stripInstructionText(raw) {
  let text = raw.replace(/\r\n/g, '\n')
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 4)
    if (end > 0) text = text.slice(text.indexOf('\n', end + 1) + 1)
  }
  return text.replace(/<!--[\s\S]*?-->/g, '')
}

export function sameText(a, b) {
  const norm = (s) =>
    s
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trimEnd())
      .join('\n')
      .trim()
  return norm(a) === norm(b)
}

export function stamp(ms) {
  return new Date(ms).toISOString().replace(/[:]/g, '').replace(/\.\d+Z$/, 'Z')
}
