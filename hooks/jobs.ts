import type { Job } from '../types'

// Background start: Agent reports "agentId: x", Bash "with ID: x"
export function backgroundId(text: string): string | null {
  const m = text.match(/agentId:\s*([A-Za-z0-9_-]+)/) ?? text.match(/running in background with ID:\s*([A-Za-z0-9_-]+)/)
  return m ? m[1] : null
}

// Endings arrive as <task-notification> with task-id and status
export function notifications(raw: string): { id: string; status: Job['status'] }[] {
  const out: { id: string; status: Job['status'] }[] = []
  for (const block of raw.split('<task-notification>').slice(1)) {
    const id = block.match(/<task-id>([^<]+)<\/task-id>/)?.[1]
    const st = block.match(/<status>([^<]+)<\/status>/)?.[1]
    if (!id || !st) continue
    out.push({ id: id.trim(), status: st.trim() === 'completed' ? 'done' : 'failed' })
  }
  return out
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}h` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function summary(jobs: Job[], diskNeeds: boolean) {
  const count = (s: Job['status']) => jobs.filter(j => j.status === s).length
  const failed = count('failed')
  return { running: count('running'), done: count('done'), failed, needs: failed + (diskNeeds ? 1 : 0) }
}

// A TaskStop sends no <task-notification>: stopped, or already gone, means the job is not running.
// A hook that blocks the stop leaves it running.
export function stopEnds(ran: { deny?: string; isError?: boolean; text?: string }): boolean {
  if (ran.deny !== undefined) return false
  return !ran.isError || /No task found|not running/i.test(ran.text ?? '')
}

export type Ending = { id: string; status: Job['status'] }

// Ended jobs stay until seen: loud shows them, quiet hides them.
// Endings for ids not in the list yet come back, so a notification that beats the id rewrite is not lost.
export function applyEndings(list: Job[], endings: Ending[], at: number): { list: Job[]; unmatched: Ending[] } {
  const ended = new Map(endings.map(d => [d.id, d.status]))
  const known = new Set(list.map(j => j.id))
  return {
    list: list.map(j => {
      const status = ended.get(j.id)
      return status && j.status === 'running' ? { ...j, status, endedAt: at } : j
    }),
    unmatched: endings.filter(d => !known.has(d.id)),
  }
}

export function applyNotifications(list: Job[], raw: string, at: number): Job[] {
  return applyEndings(list, notifications(raw), at).list
}

export const running = (list: Job[]) => list.filter(j => j.status === 'running')
