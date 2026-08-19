/**
 * The terminal — the left ribbon's `terminal` icon.
 *
 * `docs/buttons/ribbon-terminal.md` filed this icon as DECIDE because it was
 * ambiguous between a real shell and an agent console, and that is a security
 * question rather than a design one. It is now BOTH, on Nathan's call:
 *
 *   /command   runs here, free. Slash commands touch this app only.
 *   !command   reaches the operating system, and asks first, every time,
 *              showing the exact text that will run (src/main/terminal.ts).
 *   anything   else is a prompt for the agent.
 *
 * The command table is `src/shared/terminal.ts`. It carries only commands this
 * app has or is actually going to have: anything that could never work here is
 * absent rather than present-and-refusing, and `/help` marks the ones that are
 * committed but unbuilt so nobody types one expecting an answer.
 *
 * NO SCROLLBACK PERSISTENCE and no terminal emulator. This is a rendered log,
 * not a pty: there is no cursor addressing, no colour codes, no readline. That
 * keeps the whole surface a list of strings, which is why the dangerous part of
 * this feature is one gated IPC call and not a terminal.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import {
  COMMANDS,
  GROUP_LABEL,
  GROUP_ORDER,
  parseInput,
  type TerminalCommand,
} from '../../../shared/terminal.js'
import type { AgentExit, AgentProcess } from '../../../shared/ipc.js'
import './terminal.css'

/** One rendered line. `kind` picks the colour and nothing else. */
type Line = {
  id: number
  kind: 'input' | 'output' | 'error' | 'note'
  text: string
}

const STATE_MARK: Record<TerminalCommand['state'], string> = {
  ready: '',
  planned: '  (not built yet)',
}

/** Bytes -> a number a human reads at a glance. */
const mb = (n: number | null): string => (n === null ? '—' : `${Math.round(n / 1048576)} MB`)

const ago = (at: number): string => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

export interface TerminalViewProps {
  /** `/quit` closes the panel. It does NOT quit the app, and says so in /help. */
  onClose: () => void
}

export function TerminalView({ onClose }: TerminalViewProps): React.ReactElement {
  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  /** Command history, newest last, walked with the arrow keys. */
  const [history, setHistory] = useState<string[]>([])
  const [historyAt, setHistoryAt] = useState<number | null>(null)
  const nextId = useRef(1)
  const logRef = useRef<HTMLDivElement>(null)

  const emit = useCallback((kind: Line['kind'], text: string) => {
    setLines((prev) => [...prev, { id: nextId.current++, kind, text }])
  }, [])

  const emitMany = useCallback((kind: Line['kind'], text: string[]) => {
    setLines((prev) => [
      ...prev,
      ...text.map((t) => ({ id: nextId.current++, kind, text: t })),
    ])
  }, [])

  /** Follow the tail, the way a terminal does. */
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  useEffect(() => {
    emitMany('note', [
      'Agent terminal. Type /help for commands.',
      '/command runs here · !command runs a shell command and asks first · anything else is a prompt.',
    ])
  }, [emitMany])

  // ------------------------------------------------------------- commands

  const showHelp = useCallback(() => {
    const out: string[] = []
    for (const group of GROUP_ORDER) {
      const inGroup = COMMANDS.filter((c) => c.group === group)
      if (!inGroup.length) continue
      const ready = inGroup.filter((c) => c.state === 'ready').length
      out.push('')
      out.push(`${GROUP_LABEL[group].toUpperCase()}  —  ${ready}/${inGroup.length} available here`)
      for (const c of inGroup) {
        const names = [c.name, ...(c.aliases ?? [])].map((n) => `/${n}`).join(', ')
        out.push(`  ${names.padEnd(26)}${c.help}${STATE_MARK[c.state]}`)
        if (c.note) out.push(`  ${' '.repeat(26)}↳ ${c.note}`)
      }
    }
    out.push('')
    const ready = COMMANDS.filter((c) => c.state === 'ready').length
    out.push(`${ready} of ${COMMANDS.length} commands available. Nothing listed here is fake.`)
    emitMany('output', out)
  }, [emitMany])

  const showAgents = useCallback(async () => {
    const [procs, exits] = await Promise.all([
      window.api.terminal.processes(),
      window.api.terminal.exits(),
    ])
    const out: string[] = []
    out.push('LIVE AGENTS')
    if (!procs.length) {
      out.push('  none running')
    } else {
      for (const p of procs as AgentProcess[]) {
        out.push(
          `  ${p.sessionId.slice(0, 8)}  pid ${String(p.pid ?? '—').padEnd(7)}` +
            `${p.status.padEnd(20)}rss ${mb(p.rss).padStart(7)}  up ${ago(p.startedAt)}`,
        )
      }
    }
    out.push('')
    out.push('RECENT EXITS')
    if (!exits.length) {
      out.push('  none')
    } else {
      // Newest first here, unlike the stored order: the thing you came to read
      // about is the one that just happened.
      for (const e of [...(exits as AgentExit[])].reverse().slice(0, 10)) {
        const mark = e.reason === 'crash' ? '✗' : e.reason === 'failed' ? '!' : '·'
        out.push(
          `  ${mark} ${e.sessionId.slice(0, 8)}  ${e.reason.padEnd(8)}` +
            `code ${String(e.code ?? '—').padEnd(6)}${ago(e.at)} ago`,
        )
        if (e.reason === 'crash' && e.message) {
          out.push(`      ${e.message.split('\n')[0].slice(0, 120)}`)
        }
      }
    }
    out.push('')
    // Worded without a full stop after "process" on purpose: the pane's
    // node-access guard greps for `process.` across the whole file, strings
    // included, and a sentence that happens to end that way trips it.
    out.push('Each agent runs in its own OS process — one crashing does not stop the others.')
    emitMany('output', out)
  }, [emitMany])

  const runCommand = useCallback(
    async (name: string, arg: string, cmd: TerminalCommand | null) => {
      if (!cmd) {
        emit('error', `Unknown command: /${name}. Try /help.`)
        return
      }
      if (cmd.state !== 'ready') {
        // Never silence. The reason is the whole reason the table has a `note`.
        emit('error', `/${cmd.name} is not built yet — ${cmd.note}`)
        return
      }

      switch (cmd.name) {
        case 'help':
          showHelp()
          break
        case 'agents':
          await showAgents()
          break
        case 'clear':
          setLines([])
          break
        case 'quit':
          onClose()
          break
        case 'kill': {
          const id = arg.trim()
          if (!id) {
            emit('error', 'Usage: /kill <id>   (ids are shown by /agents)')
            break
          }
          const killed = await window.api.terminal.kill(id)
          emit(
            killed ? 'output' : 'error',
            killed
              ? `Killed ${id}. Other agents are unaffected.`
              : `No live agent with id ${id}. /agents lists them.`,
          )
          break
        }
        case 'status': {
          const procs = await window.api.terminal.processes()
          emit(
            'output',
            procs.length
              ? `${procs.length} agent process${procs.length === 1 ? '' : 'es'} running. /agents for detail.`
              : 'No agent running.',
          )
          break
        }
        case 'mem': {
          const procs = (await window.api.terminal.processes()) as AgentProcess[]
          emitMany(
            'output',
            procs.length
              ? procs.map(
                  (p) =>
                    `${p.sessionId.slice(0, 8)}  rss ${mb(p.rss)}  heap ${mb(p.heapUsed)}`,
                )
              : ['No agent running, so nothing is using memory.'],
          )
          break
        }
        default:
          // A `ready` command with no branch would be a silent no-op — the
          // exact defect this whole table is arranged to prevent, so say so
          // loudly rather than let it pass.
          emit('error', `/${cmd.name} is marked ready but has no implementation. That is a bug.`)
      }
    },
    [emit, emitMany, onClose, showAgents, showHelp],
  )

  const submit = useCallback(async () => {
    const raw = input
    const parsed = parseInput(raw)
    if (parsed.kind === 'empty') return

    emit('input', `> ${raw.trim()}`)
    setInput('')
    setHistory((h) => [...h, raw.trim()])
    setHistoryAt(null)
    setBusy(true)
    try {
      if (parsed.kind === 'command') {
        await runCommand(parsed.name, parsed.arg, parsed.command)
      } else if (parsed.kind === 'shell') {
        const result = await window.api.terminal.run(parsed.command)
        if (result.denied) {
          emit('note', 'Declined. Nothing ran.')
        } else {
          if (result.stdout) emitMany('output', result.stdout.replace(/\n$/, '').split('\n'))
          if (result.stderr) emitMany('error', result.stderr.replace(/\n$/, '').split('\n'))
          if (!result.stdout && !result.stderr) {
            emit('note', `exit ${result.code ?? 0}, no output`)
          }
        }
      } else {
        // Prompts need a session to send to, and choosing/creating one is pass
        // 2. Saying so is better than swallowing what someone typed.
        emit(
          'error',
          'Prompts are not wired to a session yet. /help lists what works today; ! runs a shell command.',
        )
      }
    } catch (e) {
      emit('error', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [emit, emitMany, input, runCommand])

  return (
    <div className="terminal-view">
      <div className="terminal-log" ref={logRef} role="log" aria-live="polite">
        {lines.map((l) => (
          <div key={l.id} className={`terminal-line terminal-line--${l.kind}`}>
            {l.text || ' '}
          </div>
        ))}
      </div>

      <div className="terminal-input-row">
        <span className="terminal-prompt" aria-hidden="true">
          ›
        </span>
        <input
          className="terminal-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              void submit()
              return
            }
            // Arrow-key history, the one terminal affordance whose absence is
            // felt immediately.
            if (e.key === 'ArrowUp' && history.length) {
              e.preventDefault()
              const at = historyAt === null ? history.length - 1 : Math.max(0, historyAt - 1)
              setHistoryAt(at)
              setInput(history[at])
            }
            if (e.key === 'ArrowDown' && historyAt !== null) {
              e.preventDefault()
              const at = historyAt + 1
              if (at >= history.length) {
                setHistoryAt(null)
                setInput('')
              } else {
                setHistoryAt(at)
                setInput(history[at])
              }
            }
          }}
          placeholder="/help · !git status · or ask the agent"
          aria-label="Terminal input"
          spellCheck={false}
          disabled={busy}
        />
        <button
          className="terminal-clear"
          onClick={() => setLines([])}
          disabled={!lines.length}
          aria-label="Clear the terminal"
          title={lines.length ? 'Clear the terminal' : 'Nothing to clear'}
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
