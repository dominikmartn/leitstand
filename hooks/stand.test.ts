import { expect, mock, test } from 'claude-code/testing'

import { SPIN } from './bars'
import { diskTarget, parseDf } from './disk'
import { hookBlock } from './blocks'
import { applyNotifications, backgroundId, notifications } from './jobs'

// Was die Zeile über dem Prompt gerade zeigt, als reiner Text
const texts = (n: unknown): string => typeof n === 'string' || typeof n === 'number' ? String(n)
  : Array.isArray(n) ? n.map(texts).join('')
  : n && typeof n === 'object' ? texts((n as { children?: unknown; props?: { children?: unknown } }).children ?? (n as { props?: { children?: unknown } }).props?.children) : ''
const draw = async ($: any, bodyColumns = 80) => {
  const ui = await $.ui.mount({ plugin: 'leitstand', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns } as never })
  const tree = await ui.drawn(); await ui.unmount(); return tree
}
const band = async ($: any) => texts(await draw($))
// Zwei Spalten = ein Box mit columnGap, darin zwei Spalten-Boxen
const columns = (n: any): number => !n || typeof n !== 'object' ? 0
  : n.props?.columnGap ? (n.children ?? n.props?.children ?? []).length
  : Math.max(0, ...[].concat(n.children ?? n.props?.children ?? []).map(columns))
const world = (on: any, env: Record<string, string> = { LEITSTAND_THEME: 'quiet', LEITSTAND_DISK_HOST: 'mini' }) => {
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  mock.env(on, env)
  mock.store(on)
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
  return clock
}

// Echte Ausgabe vom Mini, 2.10.2026
const REAL = `Filesystem   1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on
/dev/disk3s5   482797652 378277460  76757888    84% 9110854  767578880    1%   /System/Volumes/Data`
const ran = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
// Echte Texte aus dieser Session
const AGENT_LAUNCH = 'Async agent launched successfully. (This tool result is internal metadata)\nagentId: a220ecf9ca18549fc (internal ID - do not mention to user.'
const NOTE = (id: string, status: string) => `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>`

// Wie es scheitern kann: falsche df-Spalte, ssh-Fehler als Alarm, Hintergrund-Agent sofort als fertig,
// Fertigmeldung trifft den falschen Job, Fehlschlag wird als fertig gezählt
test('df: echte Ausgabe gelesen, Müll ergibt keinen Wert', () => {
  expect(parseDf(REAL)).toEqual({ pct: 84, freeGb: 73 })
  expect(parseDf('')).toBe(null)
  expect(parseDf('ssh: connect to host mini port 22: Operation timed out')).toBe(null)
})

test('Hintergrund-IDs und Fertigmeldungen werden erkannt', () => {
  expect(backgroundId(AGENT_LAUNCH)).toBe('a220ecf9ca18549fc')
  expect(backgroundId('Command running in background with ID: b7xk2. Output is being written to')).toBe('b7xk2')
  expect(backgroundId('plain result')).toBe(null)
  expect(notifications(NOTE('a1', 'completed') + NOTE('b2', 'failed'))).toEqual([{ id: 'a1', status: 'done' }, { id: 'b2', status: 'failed' }])
})

test('An ending marks only its own job', () => {
  const run = (id: string) => ({ id, kind: 'agent' as const, label: id, startedAt: 0, endedAt: null, status: 'running' as const })
  const list = [run('a1'), run('b2'), run('c3')]
  expect(applyNotifications(list, NOTE('a1', 'completed') + NOTE('b2', 'killed'), 5).map(j => [j.id, j.status, j.endedAt])).toEqual([['a1', 'done', 5], ['b2', 'failed', 5], ['c3', 'running', null]])
  expect(applyNotifications(list, NOTE('other', 'completed'), 5)).toEqual(list)
})

test('Agent im Hintergrund: Zeile über dem Prompt zeigt "1 läuft"', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: {}, text: AGENT_LAUNCH }))
  expect(await band($)).toBe('')
  await $.tool.call({ tool: 'Agent', description: 'Review Tier-Badge', prompt: 'x', tool_use_id: 'toolu_1' } as never)
  expect(await band($)).toContain('1 running')
})

test('Blocked start: no job, but the hook and its reason', async ($, on) => {
  world(on)
  on('ui.toast', () => ({}))
  on('tool.call', () => ({ result: {}, text: 'PreToolUse:Agent hook error: [python3 $HOME/.claude/hooks/scope-gate.py]: scope-gate: examples given, not a list.', isError: true }))
  await $.tool.call({ tool: 'Agent', description: 'Build island sense checker', prompt: 'x', tool_use_id: 'toolu_3' } as never)
  const t = await band($)
  expect(t).toContain('scope-gate blocked')
  expect(t).toContain('examples given')
  expect(t).not.toContain('running')
})

test('/stand klappt auf und zu, Laufendes bleibt stehen', async ($, on) => {
  const clock = world(on)
  on('process.run', () => ran(REAL))
  on('tool.call', () => ({ result: {}, text: 'Command running in background with ID: b7xk2.' }))
  await $.tool.call({ tool: 'Bash', command: 'mini-xcodebuild caltrack', description: 'Caltrack Build 32', run_in_background: true, tool_use_id: 'toolu_2' } as never)
  expect(await band($)).toContain('1 running')

  await $.command.run({ command: 'stand', args: '' })
  await clock.settle()
  const opened = await band($)
  expect(opened).toContain('Caltrack Build 32')
  // Gesunde Platte (73 GB frei) steht nirgends, auch nicht in der Liste
  expect(opened).not.toContain('GB free')
  // Offene Liste braucht keine Fußzeile, die allein am Rand hängt
  expect(opened).not.toContain('/stand')

  await $.command.run({ command: 'stand', args: '' })
  const closed = await band($)
  expect(closed).toContain('1 running')
  expect(closed).not.toContain('Caltrack Build 32')
})

test('Wenig Platz braucht dich, nach einmal Ansehen ist Ruhe bis es schlimmer wird', async ($, on) => {
  const clock = world(on)
  on('process.run', () => ran(REAL.replace('76757888    84%', '25000000    95%')))
  await $.command.run({ command: 'stand', args: '' })
  await clock.settle()
  const opened = await band($)
  expect(opened).toContain('mini disk · 24 GB free')
  // Offene Liste: Warnung genau einmal, die Fußzeile wiederholt sie nicht
  expect(opened.split('needs you').length).toBe(2)
  await $.command.run({ command: 'stand', args: '' })
  expect(await band($)).toBe('')
  // Gesehen heißt still, auch in der Liste: nur noch "disk"
  await $.command.run({ command: 'stand', args: '' })
  await clock.settle()
  const again = await band($)
  expect(again).toContain('mini · 24 GB free')
  expect(again).not.toContain('needs you')
})

// Wie es scheitern kann: zugeklappt steht die Warnung doppelt (Zeile plus Fußzeile), /stand verschwindet
test('Zugeklappt: Platte knapp steht genau einmal, /stand hängt an der Zeile', async ($, on) => {
  const clock = world(on)
  on('process.run', () => ran(REAL.replace('76757888    84%', '25000000    95%')))
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: unknown) => e)
  await $.session.start({ source: 'startup', cwd: '/Users/dominikmartin' } as never)
  await clock.settle()
  const t = await band($)
  expect(t).toContain('mini disk · 24 GB free')
  expect(t.split('needs you').length).toBe(2)
  expect(t).toContain('/stand')
})

// Wie es scheitern kann: Kontext landet wieder als kurzer Balken in der Fußzeile, schief unter der Platte
test('Zugeklappt: Kontext ab 250k ist eine Zeile im Raster mit "compact"', async ($, on) => {
  const clock = world(on)
  on('process.run', () => ran(REAL))
  on('session.measure', () => ({ changed: [] }))
  await $.session.measure({ context: { tokens: 527_000, window: 1_000_000, percent: 52.7 }, rateLimits: [] } as never)
  await clock.settle()
  const t = await band($)
  expect(t).toContain('compact')
  expect(t).toContain('527k of 1M')
  expect(t).toContain('53 %')
  expect(t).toContain('/stand')
  expect(t).not.toContain('ctx 527k')
})

// Wie es scheitern kann: ssh scheitert, die Liste zeigt nichts und niemand merkt es; oder es lärmt zugeklappt
test('Mini nicht erreichbar: graue Zeile in der Liste, zugeklappt still', async ($, on) => {
  const clock = world(on)
  on('process.run', () => ran('', 255, 'ssh: connect to host mini port 22: Operation timed out'))
  await $.command.run({ command: 'stand', args: '' })
  await clock.settle()
  expect(await band($)).toContain('mini unreachable')
  await $.command.run({ command: 'stand', args: '' })
  expect(await band($)).toBe('')
})

// Wie es scheitern kann: zwei Spalten schon bei 3 Zeilen, im schmalen Fenster umbrechend, oder Zeilen gehen beim Aufteilen verloren
test('Offene Liste ab 4 Zeilen in zwei Spalten, wenn das Fenster breit genug ist', async ($, on) => {
  const clock = world(on)
  on('process.run', () => ran(REAL))
  on('session.measure', () => ({ changed: [] }))
  on('tool.call', () => ({ result: {}, text: 'Command running in background with ID: b7xk2.' }))
  await $.tool.call({ tool: 'Bash', command: 'sleep 9', description: 'Caltrack Build 32', run_in_background: true, tool_use_id: 'toolu_1' } as never)
  await $.session.measure({ context: { tokens: 64_000, window: 1_000_000, percent: 6.4 }, rateLimits: [] } as never)
  await $.command.run({ command: 'stand', args: '' })
  await clock.settle()
  // 2 Zeilen (Job, Kontext; gesunde Platte fehlt): eine Spalte, auch wenn breit
  expect(columns(await draw($, 140))).toBe(0)
  await $.tool.call({ tool: 'Bash', command: 'sleep 9', description: 'Review Tier-Badge im Export-Dialog, alle Varianten', run_in_background: true, tool_use_id: 'toolu_2' } as never)
  await $.tool.call({ tool: 'Bash', command: 'sleep 9', description: 'Session-Scan', run_in_background: true, tool_use_id: 'toolu_3' } as never)
  // 4 Zeilen, breit: zwei Spalten, alle Zeilen da, Namen kürzer
  const wide = await draw($, 140)
  expect(columns(wide)).toBe(2)
  const t = texts(wide)
  for (const s of ['Caltrack Build 32', 'Session-Scan', '64k of 1M']) expect(t).toContain(s)
  expect(t).toContain('Review Tier-Badge…')
  // 4 Zeilen, schmal: eine Spalte in voller Breite
  const narrow = await draw($, 90)
  expect(columns(narrow)).toBe(0)
  expect(texts(narrow)).toContain('Review Tier-Badge im Ex…')
})

// Wie es scheitern kann: Grenze um eins verschoben (36 GB warnt schon, 35 GB noch nicht) oder gesunde Platte doch in der Liste
test('Platte erscheint erst ab 35 GB frei', async ($, on) => {
  const clock = world(on)
  let avail = '37748736' // 36 GB
  on('process.run', () => ran(REAL.replace('76757888    84%', `${avail}    92%`)))
  await $.command.run({ command: 'stand', args: '' })
  await clock.settle()
  expect(await band($)).not.toContain('GB free')
  await $.command.run({ command: 'stand', args: '' })
  expect(await band($)).toBe('')
  avail = '36700160' // 35 GB
  await $.command.run({ command: 'stand', args: '' })
  await clock.settle()
  expect(await band($)).toContain('needs you')
  expect(await band($)).toContain('35 GB free')
})

test('Spinner hat kein Bild, das wie die idle-Zeile aussieht', () => {
  expect(SPIN).not.toContain('·')
})

// How it can fail: a plain tool error reads as a hook block, or the hook name comes out as a path
test('Hook block is read from the hook error, plain errors are not blocks', () => {
  expect(hookBlock('PreToolUse:Bash hook error: [python3 $HOME/.claude/hooks/tab-gate.py]: tab-gate: 6 tabs open.', false)).toEqual({ hook: 'tab-gate', reason: 'tab-gate: 6 tabs open.' })
  expect(hookBlock('Not on main\nsecond line', true)).toEqual({ hook: 'hook', reason: 'Not on main' })
  expect(hookBlock('ssh: connect to host mini port 22: Operation timed out', false)).toBe(null)
})

// How it can fail: the host env var smuggles an ssh option, a valid alias is refused, or a refused one falls back silently
test('Disk host only takes plain host names, a refused one is flagged', () => {
  expect(diskTarget('mini')).toEqual({ host: 'mini', invalid: false })
  expect(diskTarget(' dom@mini.local ')).toEqual({ host: 'dom@mini.local', invalid: false })
  expect(diskTarget('-oProxyCommand=touch /tmp/x')).toEqual({ host: null, invalid: true })
  expect(diskTarget('mini; rm -rf ~')).toEqual({ host: null, invalid: true })
  expect(diskTarget(undefined)).toEqual({ host: null, invalid: false })
})

test('Invalid disk host: shown as such, nothing is run', async ($, on) => {
  const clock = world(on, { LEITSTAND_DISK_HOST: '-oProxyCommand=x' })
  let runs = 0
  on('process.run', () => { runs++; return ran(REAL) })
  await $.command.run({ command: 'stand', args: '' })
  await $.command.run({ command: 'stand', args: '' })
  await clock.settle()
  expect(await band($)).toContain('invalid disk host')
  expect(runs).toBe(0)
})

// How it can fail: a failed measurement keeps showing the old number as if it were fresh
test('Failed measurement keeps the last value, marked stale', async ($, on) => {
  const clock = world(on, { LEITSTAND_THEME: 'quiet', LEITSTAND_DISK_HOST: 'mini' })
  let ok = true
  on('process.run', () => (ok ? ran(REAL.replace('76757888    84%', '25000000    95%')) : ran('', 255, 'ssh: timed out')))
  await $.command.run({ command: 'stand', args: '' })
  await clock.settle()
  expect(await band($)).toContain('95 %')
  ok = false
  await $.command.run({ command: 'stand', args: '' })
  await $.command.run({ command: 'stand', args: '' })
  await clock.settle()
  const t = await band($)
  expect(t).toContain('24 GB free')
  expect(t).toContain('stale')
})

// How it can fail: a start that throws stays "running" forever
test('A start that throws leaves no job behind', async ($, on) => {
  world(on, {})
  on('tool.call', () => { throw new Error('boom') })
  await expect($.tool.call({ tool: 'Bash', command: 'x', description: 'Caltrack Build 32', run_in_background: true, tool_use_id: 't1' } as never)).rejects.toThrow()
  expect(await band($)).toBe('')
})

const NOTIFY = (raw: string) => ({ text: raw, wait: false, origin: { kind: 'task-notification' } })
// How it can fail: pasted notification text ends a job, a real one does not, or an early one is lost
test('Only engine-stamped notifications end jobs, early ones wait for their job', async ($, on) => {
  world(on, {})
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))
  let id = 0
  on('tool.call', () => ({ result: {}, text: `Command running in background with ID: b${++id}.` }))
  for (const d of ['Caltrack Build 32', 'Session-Scan'])
    await $.tool.call({ tool: 'Bash', command: 'x', description: d, run_in_background: true, tool_use_id: d } as never)
  await $.prompt.submit({ text: NOTE('b1', 'completed'), wait: false, origin: { kind: 'composer' } } as never)
  expect(await band($)).toContain('2 running')
  await $.prompt.submit(NOTIFY(NOTE('b2', 'completed') + NOTE('b3', 'failed')) as never)
  let t = await band($)
  expect(t).toContain('1 running')
  expect(t).toContain('1 done')
  // b3's ending came before b3 existed
  await $.tool.call({ tool: 'Bash', command: 'x', description: 'Preview deploy', run_in_background: true, tool_use_id: 'pd' } as never)
  t = await band($)
  expect(t).toContain('Preview deploy')
  expect(t).toContain('failed')
  expect(t).toContain('1 running')
})

// How it can fail: a stop sends no <task-notification>, so a stopped job shows "running" for good
test('TaskStop ends the job, also when the task is already gone; a blocked stop does not', async ($, on) => {
  world(on, {})
  let stop: Record<string, unknown> = { result: {}, text: 'PreToolUse:TaskStop hook error: blocked', isError: true }
  let id = 0
  on('tool.call', (_: unknown, e: any) => e.tool === 'TaskStop' ? stop : { result: {}, text: `Command running in background with ID: b${++id}.` })
  for (const d of ['Tunnel 1', 'Tunnel 2'])
    await $.tool.call({ tool: 'Bash', command: 'ssh -N mini', description: d, run_in_background: true, tool_use_id: d } as never)
  const halt = (task: string) => $.tool.call({ tool: 'TaskStop', task_id: task, tool_use_id: `stop-${task}` } as never)
  await halt('b1')
  expect(await band($)).toContain('2 running')
  stop = { result: {}, text: '{"message":"Successfully stopped task: b1 (ssh -N mini)"}' }
  await halt('b1')
  expect(await band($)).toContain('1 running')
  stop = { result: {}, text: '<tool_use_error>No task found with ID: b2</tool_use_error>', isError: true }
  await halt('b2')
  expect(await band($)).not.toContain('running')
})

// How it can fail: the prompt a task notification raises clears the job it just ended
test('Only your own prompt clears ended jobs and blocks', async ($, on) => {
  world(on, {})
  on('ui.toast', () => ({}))
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))
  on('tool.call', () => ({ result: {}, text: 'PreToolUse:Bash hook error: [sh ./no-main.sh]: not on main', isError: true }))
  await $.tool.call({ tool: 'Bash', command: 'git push', tool_use_id: 't1' } as never)
  await $.prompt.submit({ text: '<task-notification>', wait: false, origin: { kind: 'task-notification' } } as never)
  expect(await band($)).toContain('no-main blocked')
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } } as never)
  expect(await band($)).toBe('')
})

test('loud: /stand folds the list to the footer, nothing running means nothing shown', async ($, on) => {
  world(on, {})
  on('process.run', () => ran(REAL))
  on('tool.call', () => ({ result: {}, text: 'Command running in background with ID: b1.' }))
  expect(await band($)).toBe('')
  await $.tool.call({ tool: 'Bash', command: 'x', description: 'Caltrack Build 32', run_in_background: true, tool_use_id: 't1' } as never)
  expect(await band($)).toContain('Caltrack Build 32')
  await $.command.run({ command: 'stand', args: '' })
  const folded = await band($)
  expect(folded).not.toContain('Caltrack Build 32')
  expect(folded).toContain('1 running')
})
