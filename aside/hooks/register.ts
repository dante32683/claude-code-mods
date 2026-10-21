// aside: /aside <task> hands a side task to a background worker while the
// chat goes on. Unlike /btw it has tools, so it can look things up, run
// commands and edit files. Its answer opens in the Aside pane instead of
// landing in the chat; "Send to chat" posts it as your message when you want
// the main thread to see it. It is immediate: typed mid-turn it starts the
// worker at once instead of queuing behind (or interrupting) the main turn.
import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'
import type { AsideJob } from '../types'

const PANE = 'aside'
const TITLE = 'Aside'
const jobs = atom({ plugin: 'aside', key: 'jobs' } as const, [])
const CONTEXT_CHARS = 8000

const WORKER_PROMPT = `You are a side worker. The user started you with /aside while their main chat with Claude keeps going, so do the task without waiting on that chat.

- Do the task fully with your tools, then answer in a few short paragraphs or a compact list: what you found or changed, with file paths and line numbers where they help.
- Don't commit, push, send messages, or act outside this machine unless the task says to.
- The main chat may be editing the same repo. Change only what the task needs, and say exactly which files you touched.
- If the task is unclear, make the most reasonable reading, say which one you took, and do it.`

export function parseTask(args: string): { task: string; model: 'haiku' | 'opus' } {
  const m = /^\s*opus:\s*/i.exec(args)
  return m ? { task: args.slice(m[0].length).trim(), model: 'opus' } : { task: args.trim(), model: 'haiku' }
}

export async function recentContext($: EngineInterface): Promise<string> {
  let msgs
  try {
    msgs = await $.session.messages()
  } catch {
    return ''
  }
  const out: string[] = []
  let room = CONTEXT_CHARS
  for (let i = msgs.length - 1; i >= 0 && room > 0; i--) {
    const m = msgs[i]!
    const text = m.text.trim()
    if (!text || text.startsWith('<')) continue
    const cut = text.length > 1500 ? text.slice(0, 1500) + ' ...' : text
    out.unshift(`${m.role === 'user' ? 'User' : 'Claude'}: ${cut}`)
    room -= cut.length
  }
  return out.join('\n\n')
}

// One notification block that names one of our workers: the answer is in the
// pane already, so the main chat doesn't need to hear about it.
export function isOurNotice(text: string, ids: string[]): boolean {
  const blocks = text.match(/<task-notification>/g)?.length ?? 0
  return blocks === 1 && ids.some(id => text.includes(id))
}

const setJob = ($: EngineInterface, id: string, patch: Partial<AsideJob>) =>
  update($, jobs, list => list.map(j => (j.id === id ? { ...j, ...patch } : j)))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'aside', description: 'Hand a side task to a background worker; its answer opens in a pane', argumentHint: '<task>  (start with "opus:" for Opus)', immediate: true })
    await $.agent.register({ name: 'worker', description: 'Side worker for /aside (Haiku)', prompt: WORKER_PROMPT, model: 'haiku', effort: 'xhigh' })
    await $.agent.register({ name: 'worker-opus', description: 'Side worker for /aside (Opus)', prompt: WORKER_PROMPT, model: 'opus', effort: 'medium' })
    return r
  })

  // Only /aside starts these workers; Claude's Agent tool doesn't offer them.
  on('agent.offer', { agent: 'aside:worker' }, () => ({ isOffered: false }))
  on('agent.offer', { agent: 'aside:worker-opus' }, () => ({ isOffered: false }))

  on('command.run', { command: 'aside' }, async ($, e) => {
    const { task, model } = parseTask(e.args)
    if (!task) {
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: 'Usage: /aside <task>, or /aside opus: <task>. The Aside pane shows earlier answers.' }
    }
    const context = await recentContext($)
    const prompt = `Task:\n${task}` + (context ? `\n\nThe main chat's recent messages, for context (don't continue that work unless the task asks):\n\n${context}` : '')
    const r = await $.agent.spawn({ prompt, description: 'aside: ' + task.slice(0, 50), subagentType: model === 'opus' ? 'aside:worker-opus' : 'aside:worker' })
    const id = 'agentId' in r ? r.agentId : undefined
    if (!id) return { text: `Couldn't start the side worker: ${'deny' in r ? r.deny : 'no agent id'}` }
    await update($, jobs, list => [...list, { id, task, model, status: 'running' as const, answer: '' }].slice(-20))
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: `Side worker (${model}) started: ${task}` }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) return r
    const list = await read($, jobs)
    const job = list.find(j => j.id === e.agentId)
    if (!job) return r
    const failed = e.reason !== 'answer'
    await setJob($, job.id, { status: failed ? 'failed' : 'done', answer: e.answer || (failed ? `Ended: ${e.reason}` : '') })
    $.ui.toast(`Aside ${failed ? 'stopped' : 'done'}: ${job.task.slice(0, 60)}`)
    await $.ui.open({ id: PANE, title: TITLE })
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind !== 'task-notification') return next(e)
    const list = await read($, jobs)
    if (isOurNotice(e.text, list.map(j => j.id))) return { drop: 'Side worker finished; its answer is in the Aside pane.' }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const list = (await read($, jobs)).slice().reverse()
    if (!list.length) return Box({ children: [Text({ dimColor: true, children: ['No side tasks yet. Start one with /aside <task>.'] })] })
    return Box({
      flexDirection: 'column',
      gap: 1,
      children: list.map(j =>
        Box({
          key: 'job-' + j.id,
          flexDirection: 'column',
          children: [
            Text({ bold: true, children: [j.task] }),
            Text({ dimColor: true, children: [`${j.model} · ${j.status === 'running' ? 'working…' : j.status}`] }),
            ...(j.answer ? [Markdown({ key: 'ans-' + j.id, text: j.answer })] : []),
            Box({
              flexDirection: 'row',
              gap: 1,
              children: [
                ...(j.answer && j.status === 'done'
                  ? [Button({ key: 'send-' + j.id, label: 'Send to chat', variant: 'primary', onPress: () => void $.prompt.submit({ text: `Side worker's answer to "${j.task}":\n\n${j.answer}`, asUser: true }).catch(() => {}) })]
                  : []),
                ...(j.status !== 'running'
                  ? [Button({ key: 'dismiss-' + j.id, label: 'Dismiss', variant: 'secondary', onPress: () => void update($, jobs, l => l.filter(x => x.id !== j.id)) })]
                  : []),
              ],
            }),
          ],
        }),
      ),
    })
  })
}
