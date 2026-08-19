/**
 * THE TERMINAL COMMAND TABLE.
 *
 * The command NAMES and their one-line descriptions follow the conventions of
 * agent TUIs generally — `/help`, `/clear`, `/status`, `/sessions`, `!` for a
 * shell escape — so that muscle memory carries over. Nothing here is a port of
 * another product's feature list: commands belonging to a service this app does
 * not have (hosted gateways, billing accounts, plugin registries, TUI chrome)
 * are absent rather than present-and-refusing, because a command that can never
 * work is a control that lies, and this app deletes those rather than shipping
 * them greyed out.
 *
 * Every command therefore either works now or is a real commitment:
 *
 *   ready    runs here, today.
 *   planned  belongs in this app and is not built yet. `note` names what it
 *            needs. `/help` marks it, so nobody types it expecting an answer.
 *
 * There is no third state. If something cannot ever act here, it is not in the
 * table at all.
 */

export type CommandState = 'ready' | 'planned'

export type CommandGroup = 'agents' | 'core' | 'session' | 'ops' | 'debug'

export interface TerminalCommand {
  name: string
  aliases?: string[]
  group: CommandGroup
  /** One line, imperative, lower case. Rendered straight into `/help`. */
  help: string
  usage?: string
  state: CommandState
  /**
   * Required on anything `planned` — what it still needs. Enforced by
   * test/terminal-registry.test.mjs, because a command that says "not yet"
   * without saying "pending what" is indistinguishable from one that is broken.
   */
  note?: string
}

export const COMMANDS: TerminalCommand[] = [
  // ------------------------------------------------------------------ agents
  // The reason this terminal exists. Every agent turn runs in its own OS
  // process, and these are the controls over that.
  {
    name: 'agents',
    aliases: ['tasks'],
    group: 'agents',
    help: 'list live agent processes and recent exits',
    state: 'ready',
  },
  {
    name: 'spawn',
    group: 'agents',
    help: 'start an agent session in its own OS process',
    usage: '/spawn [cwd]',
    state: 'planned',
    note: 'needs session creation wired into the terminal; /agents lists what the pane already spawns',
  },
  {
    name: 'kill',
    group: 'agents',
    help: 'terminate one agent process; the others keep running',
    usage: '/kill <id>',
    state: 'ready',
  },
  {
    name: 'stop',
    group: 'agents',
    help: 'interrupt the running turn without killing the process',
    state: 'planned',
    note: 'needs the terminal to own a current session to interrupt',
  },

  // -------------------------------------------------------------------- core
  { name: 'help', group: 'core', help: 'list every command', state: 'ready' },
  {
    name: 'clear',
    aliases: ['new'],
    group: 'core',
    help: 'clear the terminal log',
    state: 'ready',
  },
  { name: 'status', group: 'core', help: 'show what is running', state: 'ready' },
  {
    name: 'history',
    group: 'core',
    help: "show the open session's transcript",
    state: 'planned',
    note: 'needs the terminal to own a current session',
  },
  {
    name: 'title',
    group: 'core',
    help: 'set or show the current session title',
    state: 'planned',
    note: 'needs the terminal to own a current session',
  },
  {
    name: 'copy',
    group: 'core',
    help: 'copy the last assistant message',
    state: 'planned',
    note: 'needs the terminal to own a current session',
  },
  {
    name: 'save',
    group: 'core',
    help: 'save the current transcript to JSON',
    state: 'planned',
    note: 'needs the terminal to own a current session',
  },
  {
    name: 'quit',
    aliases: ['exit'],
    group: 'core',
    help: 'close the terminal panel (does NOT quit the app)',
    state: 'ready',
  },
  {
    name: 'retry',
    group: 'core',
    help: 'resend the last message',
    state: 'planned',
    note: 'needs the last user turn replayed through the supervisor',
  },
  {
    name: 'undo',
    group: 'core',
    help: 'undo the last exchange',
    state: 'planned',
    note: 'transcripts are append-only; needs a rewind that also rewinds the SDK session',
  },
  {
    name: 'queue',
    aliases: ['q'],
    group: 'core',
    help: 'inspect or enqueue a message',
    state: 'planned',
    note: 'needs a per-session input queue; sends are one-at-a-time today',
  },
  {
    name: 'steer',
    group: 'core',
    help: 'inject a message after the next tool call, without interrupting',
    state: 'planned',
    note: 'needs mid-run injection into the SDK stream',
  },
  {
    name: 'logs',
    group: 'core',
    help: "show an agent process's stderr",
    state: 'planned',
    note: 'the supervisor captures it per process; not surfaced yet',
  },

  // ----------------------------------------------------------------- session
  {
    name: 'sessions',
    aliases: ['switch', 'session', 'resume'],
    group: 'session',
    help: 'browse, switch, or resume sessions',
    state: 'planned',
    note: 'needs a session picker in the panel',
  },
  {
    name: 'yolo',
    group: 'session',
    help: 'toggle per-session approvals',
    state: 'planned',
    note: 'needs the terminal to own a current session',
  },
  {
    name: 'model',
    group: 'session',
    help: 'change or show the model',
    state: 'planned',
    note: 'the SDK takes a model option; not threaded through the session record yet',
  },
  {
    name: 'reasoning',
    group: 'session',
    help: 'inspect or set reasoning effort',
    state: 'planned',
    note: 'same route as /model',
  },
  {
    name: 'verbose',
    group: 'session',
    help: 'cycle tool-output detail',
    state: 'planned',
    note: 'the transcript already carries tool blocks; needs a render toggle',
  },
  {
    name: 'background',
    aliases: ['bg'],
    group: 'session',
    help: 'run a prompt in the background',
    state: 'planned',
    note: 'the supervisor already holds several processes; needs a detached send',
  },
  {
    name: 'branch',
    aliases: ['fork'],
    group: 'session',
    help: 'branch the session',
    state: 'planned',
    note: 'needs a transcript copy plus a fresh SDK resume id',
  },
  {
    name: 'compress',
    group: 'session',
    help: 'compact the transcript',
    state: 'planned',
    note: 'no compaction step in this app yet',
  },
  {
    name: 'tools',
    group: 'session',
    help: 'enable or disable tools',
    state: 'planned',
    note: 'the tool list is hard-coded to Read/Glob/Grep in claude.ts',
  },

  // --------------------------------------------------------------------- ops
  {
    name: 'rollback',
    group: 'ops',
    help: 'list, diff, or restore checkpoints',
    state: 'planned',
    note: 'the vault already keeps .backups/ and .trash/; needs wiring to those',
  },
  {
    name: 'replay',
    group: 'ops',
    help: 'replay a finished agent run',
    state: 'planned',
    note: 'the supervisor journals exits; replay needs the full trace kept',
  },
  {
    name: 'replay-diff',
    group: 'ops',
    help: 'diff two finished agent runs',
    state: 'planned',
    note: 'follows /replay',
  },

  // ------------------------------------------------------------------- debug
  {
    name: 'mem',
    group: 'debug',
    help: 'show memory use per agent process',
    state: 'ready',
  },
]

/**
 * Name or alias -> command. Built once.
 *
 * Aliases share the entry rather than being copied, so `/bg` and `/background`
 * can never drift into reporting different states for the same command.
 */
const BY_NAME = new Map<string, TerminalCommand>(
  COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])].map((n) => [n, c] as const)),
)

/** Case-insensitive, and tolerant of the leading slash the user just typed. */
export function findCommand(input: string): TerminalCommand | null {
  return BY_NAME.get(input.trim().replace(/^\//, '').toLowerCase()) ?? null
}

/** Group order for `/help`. Most useful first. */
export const GROUP_ORDER: CommandGroup[] = ['agents', 'core', 'session', 'ops', 'debug']

export const GROUP_LABEL: Record<CommandGroup, string> = {
  agents: 'Agents',
  core: 'Core',
  session: 'Session',
  ops: 'Ops',
  debug: 'Debug',
}

/**
 * One parsed input line.
 *
 * `!` is the shell escape. It is a SEPARATE kind rather than a command named
 * "!" so that the consent gate has one unmistakable thing to key on: anything
 * that reaches the OS arrives here as `kind: 'shell'` and nothing else can.
 */
export type ParsedInput =
  | { kind: 'empty' }
  | { kind: 'shell'; command: string }
  | { kind: 'command'; name: string; arg: string; command: TerminalCommand | null }
  | { kind: 'prompt'; text: string }

export function parseInput(raw: string): ParsedInput {
  const line = raw.trim()
  if (!line) return { kind: 'empty' }
  if (line.startsWith('!')) {
    const command = line.slice(1).trim()
    return command ? { kind: 'shell', command } : { kind: 'empty' }
  }
  if (line.startsWith('/')) {
    const [word, ...rest] = line.slice(1).split(/\s+/)
    return {
      kind: 'command',
      name: word.toLowerCase(),
      arg: rest.join(' '),
      command: findCommand(word),
    }
  }
  return { kind: 'prompt', text: line }
}
