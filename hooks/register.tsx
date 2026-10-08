import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Disk, Job } from '../types'
import type { Level } from './disk'
import { DF, diskTarget, level, needsYou, parseDf } from './disk'
import { DOT, loudMeter, meter } from './bars'
import { hookBlock } from './blocks'
import { applyEndings, backgroundId, notifications, running, stopEnds } from './jobs'

const disk = atom({ plugin: 'leitstand', key: 'disk' } as const, null)
// Claude Code lists running jobs below the prompt itself; Leitstand only tracks them for the done sound
const jobs = atom({ plugin: 'leitstand', key: 'jobs' } as const, [])
const open = atom({ plugin: 'leitstand', key: 'open' } as const, null)
const ctx = atom({ plugin: 'leitstand', key: 'ctx' } as const, null)
const block = atom({ plugin: 'leitstand', key: 'block' } as const, null)
const diskSeen = atom({ plugin: 'leitstand', key: 'diskSeen' } as const, 'ok')
const early = atom({ plugin: 'leitstand', key: 'early' } as const, [])

// Mid tones: readable on light and dark terminals
const C = { clay: '#d97757', ok: '#4fa86b', warn: '#d08a1e', bad: '#d9534f', track: '#8a8580' }
const MEASURE_EVERY = 5 * 60 * 1000
const LONG_MS = 60 * 1000
// From here on the context row stands above the prompt and says "compact"
const CTX_SHOW = 250_000
const W = { label: 24, bar: 14, right: 8 }

type Theme = 'loud' | 'quiet'
const theme = async ($: EngineInterface): Promise<Theme> => ((await $.env.get('LEITSTAND_THEME'))?.trim() === 'quiet' ? 'quiet' : 'loud')

// Local disk by default; LEITSTAND_DISK_HOST measures another machine over ssh
const target = async ($: EngineInterface) => diskTarget(await $.env.get('LEITSTAND_DISK_HOST'))
const host = async ($: EngineInterface) => (await target($)).host
const INVALID_HOST = 'LEITSTAND_DISK_HOST is not a plain host name'
// One session measures, the others wait for its result
const LEASE_MS = 20 * 1000
const dfArgv = (hn: string | null) => (hn ? ['ssh', '-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', hn, DF] : ['sh', '-c', DF])
const storeKey = (hn: string | null) => hn ?? 'local'

async function measure($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  const { host: hn, invalid } = await target($)
  let error: string
  if (invalid) {
    await update($, disk, () => ({ pct: null, freeGb: null, at, error: INVALID_HOST }))
    return
  }
  // ponytail: the store has no compare-and-set, so two sessions can still both measure within the same instant; newer-wins below keeps the result right
  await $.store.set(`disk-lease:${storeKey(hn)}`, at + LEASE_MS)
  try {
    const run = await $.process.run(dfArgv(hn), { timeoutMs: 15000 })
    const parsed = run.exitCode === 0 ? parseDf(run.stdout) : null
    if (parsed) {
      const before = await read($, disk)
      const next: Disk = { ...parsed, at, error: null }
      await update($, disk, () => next)
      const stored = (await $.store.get(`disk:${storeKey(hn)}`)) as Disk | undefined
      if (!stored || stored.at <= at) await $.store.set(`disk:${storeKey(hn)}`, next)
      if (level(parsed.freeGb) === 'bad' && level(before?.freeGb ?? null) !== 'bad') {
        $.ui.toast(`${hn ?? 'Disk'} at ${parsed.pct} %, only ${parsed.freeGb} GB free`)
      }
      return
    }
    error = run.stderr.trim().split('\n').pop() || `df exited with ${run.exitCode}`
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  // Keep the last good value and its time, only note the error; the row marks it stale
  await update($, disk, prev => ({ pct: prev?.pct ?? null, freeGb: prev?.freeGb ?? null, at: prev?.at ?? at, error }))
}

// All sessions share one measurement: only measure when the stored one is stale
async function refreshDisk($: EngineInterface): Promise<void> {
  const key = storeKey(await host($))
  const seen = (await $.store.get(`disk-seen:${key}`)) as Level | undefined
  if (seen) await update($, diskSeen, () => seen)
  const shared = (await $.store.get(`disk:${key}`)) as Disk | undefined
  const t = await $.clock.now()
  if (shared && shared.pct !== null && t - shared.at < MEASURE_EVERY) {
    await update($, disk, () => shared)
    return
  }
  const lease = Number((await $.store.get(`disk-lease:${key}`)) ?? 0)
  if (lease > t) return
  await measure($)
}

// Done sound only after long work, so short answers stay silent. Played from the system, not shipped.
const ding = async ($: EngineInterface) => {
  if ((await $.env.get('LEITSTAND_SOUND'))?.trim() === 'off') return
  void $.process.run(['afplay', '/System/Library/Sounds/Glass.aiff'], { timeoutMs: 5000 }).catch(() => {})
}

// A hook blocked a tool call: keep it until the next prompt
async function noteBlock($: EngineInterface, ran: unknown): Promise<void> {
  const r = ran as { deny?: string; isError?: boolean; text?: string }
  const hit = r.deny !== undefined ? hookBlock(r.deny, true) : r.isError ? hookBlock(r.text ?? '', false) : null
  if (!hit) return
  await update($, block, () => hit)
  $.ui.toast(`${hit.hook} blocked · ${hit.reason}`)
}

// What stands above the prompt without being asked: a low disk, a hook block, a full context
async function alerts($: EngineInterface) {
  const d = await read($, disk)
  const lv = level(d?.freeGb ?? null)
  const diskNeeds = needsYou(lv, await read($, diskSeen))
  const g = await read($, block)
  const c0 = await read($, ctx)
  const c = c0 && typeof c0 === 'object' ? c0 : null
  const ctxHigh = c !== null && c.tokens >= CTX_SHOW
  return { d, lv, diskNeeds, g, c, ctxHigh, any: diskNeeds || !!g || ctxHigh }
}

const HUMAN = new Set(['composer', 'bridge', 'sdk'])

const fit = (t: string, w: number) => ([...t].length > w ? [...t].slice(0, w - 1).join('') + '…' : t.padEnd(w))
const kTok = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}k`)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'stand', description: 'Toggle the list: disk, context and what needs you' })
    void refreshDisk($)
    if ((await target($)).invalid) $.ui.toast(INVALID_HOST)
    $.clock.every(60 * 1000, () => void refreshDisk($))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const isAgent = e.tool === 'Agent'
    const isBgBash = e.tool === 'Bash' && input.run_in_background === true
    if (e.agentId) return next(e)
    if (e.tool === 'TaskStop') {
      const ran = await next(e)
      await noteBlock($, ran)
      const id = String(input.task_id ?? input.shell_id ?? '')
      if (id && stopEnds(ran as { deny?: string; isError?: boolean; text?: string })) {
        const at = await $.clock.now()
        await update($, jobs, list => applyEndings(list, [{ id, status: 'failed' }], at).list)
      }
      return ran
    }
    if (!isAgent && !isBgBash) {
      const ran = await next(e)
      await noteBlock($, ran)
      return ran
    }

    const tmp = String(e.tool_use_id ?? Math.random())
    const label = String(input.description ?? input.command ?? e.tool).trim()
    const startedAt = await $.clock.now()
    await update($, jobs, list => [...list, { id: tmp, kind: isAgent ? 'agent' : 'bash', label, startedAt, endedAt: null, status: 'running' } as Job])

    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } catch (err) {
      // The start threw: it never ran, so it must not stay "running"
      await update($, jobs, list => list.filter(j => j.id !== tmp))
      throw err
    }
    await noteBlock($, ran)
    const text = 'text' in ran && typeof ran.text === 'string' ? ran.text : ''
    const bg = backgroundId(text)
    // A start that a hook blocked or that failed at once never ran: no job
    const neverStarted = 'deny' in ran || ('isError' in ran && ran.isError === true)
    // Blocked, or already finished in the foreground: nothing left to show
    await update($, jobs, list => (neverStarted || !bg ? list.filter(j => j.id !== tmp) : list.map(j => (j.id === tmp ? { ...j, id: bg } : j))))
    // Its ending may have arrived first
    const pending = bg ? (await read($, early)).filter(d => d.id === bg) : []
    if (pending.length) {
      const at = await $.clock.now()
      await update($, jobs, list => applyEndings(list, pending, at).list)
      await update($, early, list => list.filter(d => d.id !== bg))
    }
    return ran
  })

  // Sound only when it is your turn: nothing runs any more, and it took a while. Once per prompt.
  let workStart = 0
  on('turn.complete', async ($, e, next) => {
    if (workStart && !running(await read($, jobs)).length && (await $.clock.now()) - workStart >= LONG_MS) {
      void ding($)
      workStart = 0
    }
    return next(e)
  })

  // Endings are read only from prompts the engine stamped as task notifications: text a user pastes cannot end a job.
  // Your own next prompt means you saw what ended.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'task-notification') {
      const at = await $.clock.now()
      const { list, unmatched } = applyEndings(await read($, jobs), notifications(e.text), at)
      await update($, jobs, () => list)
      // Keep only a few: an ending for a job started before this session never finds its row
      if (unmatched.length) await update($, early, prev => [...prev, ...unmatched].slice(-20))
    }
    if (!HUMAN.has(e.origin?.kind ?? 'composer')) return next(e)
    workStart = await $.clock.now()
    await update($, block, () => null)
    await update($, jobs, running)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const tokens = e.context.tokens ?? null
    const window = e.context.window
    const pct = e.context.percent ?? (tokens !== null && window ? (tokens / window) * 100 : null)
    await update($, ctx, () => (tokens === null ? null : { tokens, window, pct: Math.round(pct ?? 0) }))
    return next(e)
  })

  on('command.run', { command: 'stand' }, async $ => {
    // loud opens by default, but shows nothing until something needs you: then the first /stand opens
    const wasOpen = (await read($, open)) ?? ((await theme($)) === 'loud' && (await alerts($)).any)
    await update($, open, () => !wasOpen)
    // Folding means seen: the disk warning goes quiet
    if (wasOpen) {
      const lv = level((await read($, disk))?.freeGb ?? null)
      await update($, diskSeen, () => lv)
      await $.store.set(`disk-seen:${storeKey(await host($))}`, lv)
    }
    else void measure($)
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const th = await theme($)
    const explicit = await read($, open)
    const isOpen = explicit ?? th === 'loud'
    const hostName = await host($)
    const { d, lv, diskNeeds, g, c, ctxHigh, any } = await alerts($)
    if (!any && explicit !== true) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const loud = th === 'loud'
    const diskColor = lv === 'bad' ? C.bad : lv === 'warn' ? C.warn : C.clay

    // loud shows the disk whenever the list is up; quiet only once it runs low
    const diskShown = !!d && (d.pct === null ? !!d.error : loud || lv !== 'ok')
    const ctxShown = c !== null && (!loud || ctxHigh || explicit === true)
    const diskName = hostName ? `${hostName} disk` : 'disk'

    const Track = ({ s: str }: { s: string }) => <Text color={C.track} dimColor>{str}</Text>
    const Hint = () => <Text dimColor>{'     /stand'}</Text>
    const Row = ({ mark, color, state, label, bar, right, bold, hint }: { mark: string; color: string; state: string; label: string; bar: unknown; right: string; bold?: boolean; hint?: boolean }) => (
      <Box>
        <Text color={color}>{mark} </Text>
        <Text color={color} bold={bold}>{fit(state, 11)}</Text>
        <Text>{fit(label, W.label)} </Text>
        {bar as never}
        <Text dimColor>{right.padStart(W.right)}</Text>
        {hint ? <Hint /> : null}
      </Box>
    )
    const empty = <Track s={(loud ? DOT : '─').repeat(W.bar)} />

    // Seen means calm: no "needs you", just the numbers in the warning color
    const diskRow = (hint = false) => !d || !diskShown ? null : d.pct === null
      ? <Row mark=" " color={C.track} state="disk" label={d.error === INVALID_HOST ? 'invalid disk host' : hostName ? `${hostName} unreachable` : 'disk unreadable'} bar={empty} right="" />
      : (() => {
        const [body, rest] = (loud ? loudMeter : meter)(d.pct, W.bar)
        const bar = [<Text color={diskColor}>{body}</Text>, <Track s={rest} />]
        // Last measurement failed: the old value stays, marked as stale
        const diskRight = d.error ? 'stale' : `${d.pct} %`
        if (diskNeeds) return <Row mark="!" color={diskColor} state="needs you" label={`${diskName} · ${d.freeGb} GB free`} bar={bar} right={diskRight} bold hint={hint} />
        return <Row mark=" " color={diskColor} state={loud ? '' : 'disk'} label={`${loud ? diskName : hostName ?? 'disk'} · ${d.freeGb} GB free`} bar={bar} right={diskRight} />
      })()

    const ctxRow = (hint = false) => !ctxShown || !c ? null : (() => {
      const [body, rest] = (loud ? loudMeter : meter)(c.pct, W.bar)
      const color = ctxHigh ? C.warn : C.track
      return <Row mark=" " color={color} state={ctxHigh ? 'compact' : 'context'} label={`${kTok(c.tokens)} of ${kTok(c.window)}`} bar={[<Text color={color}>{body}</Text>, <Track s={rest} />]} right={`${c.pct} %`} hint={hint} />
    })()

    const idle = <Row mark="·" color={C.track} state="idle" label="nothing needs you" bar={empty} right="" />
    const openRows = isOpen ? [diskRow(), ctxRow()].filter(Boolean) : []
    const list = isOpen && (openRows.length ? openRows : idle)

    const blockLine = (hint: boolean) => g && (
      <Box>
        <Text color={C.bad}>■ </Text>
        <Text bold>{g.hook}</Text>
        <Text dimColor>{' blocked'}</Text>
        {g.reason ? <Text dimColor>{`  ·  ${fit(g.reason, 60).trimEnd()}`}</Text> : null}
        {hint ? <Hint /> : null}
      </Box>
    )

    if (loud) {
      // The footer counts what needs you, folded or open; without it /stand hangs on the last row
      const hang = diskNeeds ? null : g ? 'block' : !isOpen && ctxHigh ? 'ctx' : null
      return (
        <Box flexDirection="column">
          {list}
          {!isOpen && ctxHigh && ctxRow(hang === 'ctx')}
          {blockLine(hang === 'block')}
          {diskNeeds && (
            <Box>
              <Text color={C.warn} bold>! 1 needs you</Text>
              <Hint />
            </Box>
          )}
          {!diskNeeds && !hang && <Text dimColor>/stand</Text>}
        </Box>
      )
    }

    // quiet: no footer, /stand hangs on the last row
    const last = isOpen ? null : g ? 'block' : ctxHigh ? 'ctx' : 'disk'
    return (
      <Box flexDirection="column">
        {list}
        {diskNeeds && !isOpen && diskRow(last === 'disk')}
        {ctxHigh && !isOpen && ctxRow(last === 'ctx')}
        {blockLine(last === 'block')}
      </Box>
    )
  })
}
