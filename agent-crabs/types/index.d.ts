// What a subagent is doing, which picks its crab's animation.
export type Activity = 'think' | 'read' | 'search' | 'edit' | 'run' | 'web' | 'done' | 'failed'

// One subagent this session started. `id` is its agentId.
export type Crab = {
  id: string
  label: string
  activity: Activity
  detail: string
  tools: number
  startedAt: number
  endedAt?: number
  // The pose on screen. A new activity's pose loads hidden beside it and takes over
  // once it has had WARM_MS to load (changedAt), so a swap never shows a blank frame.
  shown: Activity
  changedAt: number
  // Its tool calls in flight, and when one last started or ended: a crab with none
  // running for a while goes back to thinking.
  busy?: number
  lastToolAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-crabs': { crabs: Crab[]; now: number }
  }
}
