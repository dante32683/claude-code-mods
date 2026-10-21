// The side tasks this session started, newest last. `id` is the worker's
// agentId; `answer` is its final message once it ends.
export type AsideJob = {
  id: string
  task: string
  model: 'haiku' | 'opus'
  status: 'running' | 'done' | 'failed'
  answer: string
}

declare module 'claude-code' {
  interface PluginState {
    aside: { jobs: AsideJob[] }
  }
}
