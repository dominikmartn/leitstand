export type Disk = {
  pct: number | null
  freeGb: number | null
  // Time of the last good measurement
  at: number
  error: string | null
}

export type Job = {
  id: string
  kind: 'agent' | 'bash'
  label: string
  startedAt: number
  endedAt: number | null
  status: 'running' | 'done' | 'failed'
}

declare module 'claude-code' {
  interface PluginState {
    leitstand: {
      disk: Disk | null
      jobs: Job[]
      // null: the theme decides (loud shows the list, quiet folds it)
      open: boolean | null
      diskSeen: 'ok' | 'warn' | 'bad'
      ctx: { tokens: number; window: number; pct: number } | null
      block: { hook: string; reason: string } | null
      // Endings that arrived before their job had its background id
      early: { id: string; status: 'running' | 'done' | 'failed' }[]
    }
  }
}
