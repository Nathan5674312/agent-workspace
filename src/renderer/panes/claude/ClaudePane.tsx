/**
 * SECTION 1 — Claude Code pane (left, full height).
 *
 * Rebuild the Claude Code desktop layout, structure-for-structure.
 * NO styling beyond structure. Semantic elements, stable class names only.
 *
 * Regions:
 *   top rail      hamburger · sidebar toggle · search · back / forward
 *   mode tabs     Home · Code
 *   primary nav   + New · Artifacts · Customize · More (collapsible)
 *   project group group header with add + filter controls
 *   session list  status dot · title · per-session state
 *   account row   avatar · name · plan tier · chevron
 *   main greeting "What's up next, <name>?" + What's new
 *   stats card    Overview/Models tabs · All/30d/7d toggle · 8 tiles ·
 *                 contribution heatmap · one comparison line
 *   composer      scope chips · input · permission-mode chip · attach · mic ·
 *                 options chevron · model name · effort level · toggle
 */
import React, { useState, useEffect } from 'react'
import type { Session, ChatMessage, Stats, ChatBlock, PermissionMode } from '../../../shared/ipc.js'

const PERMISSION_MODES: PermissionMode[] = ['ask', 'accept-edits', 'bypass']

export function ClaudePane(): React.ReactElement {
  const [sessions, setSessions] = useState<Session[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [statRange, setStatRange] = useState<'all' | '30d' | '7d'>('30d')
  const [statsTab, setStatsTab] = useState<'overview' | 'models'>('overview')
  const [input, setInput] = useState('')
  // Per-session, because the mode is persisted per session in main. The
  // contract's `Session` does not carry it back, so this mirror only reflects
  // changes made from this window; main's default is 'ask', so is ours.
  const [permissionModes, setPermissionModes] = useState<Record<string, PermissionMode>>({})

  // Load sessions on mount
  useEffect(() => {
    const unsubscribe = window.api.claude.onSessionUpdate((s) => {
      setSessions((prev) => {
        const idx = prev.findIndex((x) => x.id === s.id)
        if (idx >= 0) {
          const updated = [...prev]
          updated[idx] = s
          return updated
        }
        return [...prev, s]
      })
    })

    window.api.claude
      .sessions()
      .then((loaded) => {
        // Merge rather than replace: a session update can land between the
        // subscribe above and this promise resolving, and a bare setSessions
        // would throw that update away.
        setSessions((prev) => {
          const byId = new Map(loaded.map((s) => [s.id, s]))
          for (const s of prev) byId.set(s.id, s)
          return [...byId.values()]
        })
      })
      .catch(console.error)

    return unsubscribe
  }, [])

  // Load history when session changes
  useEffect(() => {
    if (!selectedSessionId) {
      setHistory([])
      return
    }
    let live = true
    window.api.claude
      .history(selectedSessionId)
      .then((h) => {
        // Guard against a slow response for a session the user already left.
        if (live) setHistory(h)
      })
      .catch(console.error)
    return () => {
      live = false
    }
  }, [selectedSessionId])

  // Load stats when range changes
  useEffect(() => {
    window.api.claude.stats(statRange).then(setStats).catch(console.error)
  }, [statRange])

  // Subscribe to messages
  useEffect(() => {
    const unsubscribe = window.api.claude.onMessage((sessionId, msg) => {
      if (sessionId === selectedSessionId) {
        setHistory((prev) => [...prev, msg])
      }
    })
    return unsubscribe
  }, [selectedSessionId])

  const handleNewSession = async () => {
    try {
      const cwd = '.' // ponytail: placeholder project path
      const session = await window.api.claude.newSession(cwd)
      setSessions((prev) => [...prev, session])
      setSelectedSessionId(session.id)
      setHistory([])
    } catch (err) {
      console.error('Failed to create session:', err)
    }
  }

  const handleSend = async () => {
    if (!selectedSessionId || !input.trim()) return
    const text = input
    setInput('')
    try {
      await window.api.claude.send(selectedSessionId, text)
    } catch (err) {
      // Put the text back. It was cleared optimistically so the composer feels
      // instant, but on a failed send the only copy of what the user typed was
      // this local `text` — clearing without restoring threw the message away
      // and left an empty box with nothing on screen to say why. A long prompt
      // is expensive to retype and there is no draft anywhere to recover it
      // from. Only restore if the user has not already started typing again,
      // so we never clobber newer input.
      setInput((cur) => (cur === '' ? text : cur))
      console.error('Failed to send message:', err)
    }
  }

  const handleInterrupt = async () => {
    if (!selectedSessionId) return
    try {
      await window.api.claude.interrupt(selectedSessionId)
    } catch (err) {
      console.error('Failed to interrupt:', err)
    }
  }

  const currentSession = sessions.find((s) => s.id === selectedSessionId)
  const permissionMode: PermissionMode = selectedSessionId
    ? (permissionModes[selectedSessionId] ?? 'ask')
    : 'ask'

  // Cycle the chip through the contract's three modes and tell main about it.
  // Previously this was a `useState` with no setter and no IPC call: the chip
  // rendered a mode the session never actually had.
  const handleCyclePermissionMode = async () => {
    if (!selectedSessionId) return
    const next = PERMISSION_MODES[(PERMISSION_MODES.indexOf(permissionMode) + 1) % PERMISSION_MODES.length]
    try {
      await window.api.claude.setPermissionMode(selectedSessionId, next)
      setPermissionModes((prev) => ({ ...prev, [selectedSessionId]: next }))
    } catch (err) {
      console.error('Failed to set permission mode:', err)
    }
  }

  return (
    <div className="claude-pane-container">
      {/* Top rail */}
      <div className="claude-top-rail">
        <button className="claude-hamburger" aria-label="Menu">
          ☰
        </button>
        <button className="claude-sidebar-toggle" aria-label="Toggle sidebar">
          ◀
        </button>
        <input type="text" className="claude-search" placeholder="Search..." />
        <button className="claude-back" aria-label="Back">
          ←
        </button>
        <button className="claude-forward" aria-label="Forward">
          →
        </button>
      </div>

      {/* Mode tabs */}
      <div className="claude-mode-tabs">
        <button className="claude-mode-tab claude-mode-tab--active" data-mode="home">
          Home
        </button>
        <button className="claude-mode-tab" data-mode="code">
          Code
        </button>
      </div>

      {/* Primary navigation */}
      <div className="claude-primary-nav">
        <button className="claude-nav-item" onClick={handleNewSession}>
          + New
        </button>
        <button className="claude-nav-item">Artifacts</button>
        <button className="claude-nav-item">Customize</button>
        <button className="claude-nav-item claude-nav-item--collapsible">More</button>
      </div>

      {/* Project group header */}
      <div className="claude-project-group">
        <div className="claude-project-header">
          <span className="claude-project-name">Desktop</span>
          <button className="claude-project-add" aria-label="Add project">
            +
          </button>
          <button className="claude-project-filter" aria-label="Filter projects">
            ⚙
          </button>
        </div>
      </div>

      {/* Session list */}
      <div className="claude-session-list">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`claude-session-item ${selectedSessionId === s.id ? 'claude-session-item--active' : ''}`}
            onClick={() => setSelectedSessionId(s.id)}
          >
            <span className={`claude-session-status-dot claude-status-${s.status}`} aria-label={`Status: ${s.status}`}>
              ●
            </span>
            <span className="claude-session-title">{s.title}</span>
            <span className="claude-session-state">{s.status}</span>
          </div>
        ))}
      </div>

      {/* Account row */}
      <div className="claude-account-row">
        <div className="claude-account-avatar">A</div>
        <div className="claude-account-info">
          <div className="claude-account-name">Nathan</div>
          <div className="claude-account-tier">Pro</div>
        </div>
        <button className="claude-account-menu" aria-label="Account menu">
          ⋮
        </button>
      </div>

      {/* Main content area */}
      <div className="claude-main">
        {!currentSession ? (
          // Greeting view
          <div className="claude-greeting">
            <h2 className="claude-greeting-title">What's up next, Nathan?</h2>
            <a href="#" className="claude-whats-new-link">
              What's new
            </a>
          </div>
        ) : (
          // Chat view (when session selected)
          <div className="claude-chat">
            <div className="claude-history">
              {history.map((msg: ChatMessage) => (
                <div key={msg.id} className={`claude-message claude-message--${msg.role}`}>
                  <div className="claude-message-role">{msg.role}</div>
                  {msg.blocks.map((block: ChatBlock, i: number) => (
                    <div key={i} className={`claude-block claude-block-${block.kind}`}>
                      {block.kind === 'text' && <div className="claude-text">{block.text}</div>}
                      {block.kind === 'thinking' && <div className="claude-thinking">💭 {block.text}</div>}
                      {block.kind === 'tool_use' && (
                        <div className="claude-tool-use">
                          Tool: {block.name} (ID: {block.id})
                        </div>
                      )}
                      {block.kind === 'tool_result' && (
                        <div className={`claude-tool-result ${block.isError ? 'claude-tool-result--error' : ''}`}>
                          {block.content}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Stats card */}
        {!currentSession && (
          <div className="claude-stats-card">
            <div className="claude-stats-header">
              <div className="claude-stats-tabs">
                <button
                  className={`claude-stats-tab ${statsTab === 'overview' ? 'claude-stats-tab--active' : ''}`}
                  onClick={() => setStatsTab('overview')}
                >
                  Overview
                </button>
                <button
                  className={`claude-stats-tab ${statsTab === 'models' ? 'claude-stats-tab--active' : ''}`}
                  onClick={() => setStatsTab('models')}
                >
                  Models
                </button>
              </div>
              <div className="claude-stats-range-toggle">
                <button
                  className={`claude-range-btn ${statRange === 'all' ? 'claude-range-btn--active' : ''}`}
                  onClick={() => setStatRange('all')}
                >
                  All
                </button>
                <button
                  className={`claude-range-btn ${statRange === '30d' ? 'claude-range-btn--active' : ''}`}
                  onClick={() => setStatRange('30d')}
                >
                  30d
                </button>
                <button
                  className={`claude-range-btn ${statRange === '7d' ? 'claude-range-btn--active' : ''}`}
                  onClick={() => setStatRange('7d')}
                >
                  7d
                </button>
              </div>
            </div>

            {stats && statsTab === 'overview' && (
              <div className="claude-stats-grid">
                <div className="claude-stat-tile">
                  <div className="claude-stat-label">Sessions</div>
                  <div className="claude-stat-value">{stats.sessions}</div>
                </div>
                <div className="claude-stat-tile">
                  <div className="claude-stat-label">Messages</div>
                  <div className="claude-stat-value">{stats.messages}</div>
                </div>
                <div className="claude-stat-tile">
                  <div className="claude-stat-label">Total Tokens</div>
                  <div className="claude-stat-value">{stats.totalTokens.toLocaleString()}</div>
                </div>
                <div className="claude-stat-tile">
                  <div className="claude-stat-label">Active Days</div>
                  <div className="claude-stat-value">{stats.activeDays}</div>
                </div>
                <div className="claude-stat-tile">
                  <div className="claude-stat-label">Current Streak</div>
                  <div className="claude-stat-value">{stats.currentStreak}</div>
                </div>
                <div className="claude-stat-tile">
                  <div className="claude-stat-label">Longest Streak</div>
                  <div className="claude-stat-value">{stats.longestStreak}</div>
                </div>
                <div className="claude-stat-tile">
                  <div className="claude-stat-label">Peak Hour</div>
                  <div className="claude-stat-value">{stats.peakHour !== null ? `${stats.peakHour}:00` : '—'}</div>
                </div>
                <div className="claude-stat-tile">
                  <div className="claude-stat-label">Favorite Model</div>
                  <div className="claude-stat-value">{stats.favoriteModel ?? '—'}</div>
                </div>
              </div>
            )}

            {stats && statsTab === 'overview' && (
              <div className="claude-heatmap">
                <div className="claude-heatmap-grid">
                  {stats.heatmap.map((cell: {date: string; count: number}) => (
                    <div
                      key={cell.date}
                      className="claude-heatmap-cell"
                      data-date={cell.date}
                      data-count={cell.count}
                      title={`${cell.date}: ${cell.count} messages`}
                    >
                      ■
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* The one comparison line. Both numbers come from real recorded
                activity — there is no previous-period figure in the contract's
                Stats, so nothing here is inferred. */}
            {stats && statsTab === 'overview' && (
              <div className="claude-stats-comparison">
                <span className="claude-stats-comparison-text">
                  {stats.currentStreak} day streak vs {stats.longestStreak} day best
                </span>
              </div>
            )}

            {stats && statsTab === 'models' && (
              <div className="claude-models-view">
                <div className="claude-models-list">
                  {/* Only `favoriteModel` crosses the contract; a per-model
                      table would be an invented breakdown. Empty state says so
                      rather than showing zeroes. */}
                  {stats.favoriteModel ? (
                    <div className="claude-model-row" data-model={stats.favoriteModel}>
                      <span className="claude-model-row-label">Most used</span>
                      <span className="claude-model-row-value">{stats.favoriteModel}</span>
                    </div>
                  ) : (
                    <div className="claude-models-empty">No model usage recorded yet</div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="claude-composer">
        {/* Scope chips */}
        <div className="claude-scope-chips">
          <span className="claude-scope-chip">Local</span>
          <span className="claude-scope-chip">Desktop</span>
        </div>

        {/* Input area */}
        <div className="claude-composer-input-wrapper">
          <textarea
            className="claude-composer-input"
            placeholder="Ask Claude anything..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
          />
          <button className="claude-composer-submit" onClick={handleSend} aria-label="Send message" disabled={!input.trim()}>
            ↑
          </button>
        </div>

        {/* Bottom controls */}
        <div className="claude-composer-controls">
          <div className="claude-composer-left">
            <button
              className="claude-permission-mode-chip"
              data-mode={permissionMode}
              onClick={handleCyclePermissionMode}
              disabled={!selectedSessionId}
              aria-label={`Permission mode: ${permissionMode}`}
            >
              {permissionMode}
            </button>
            <button className="claude-attach" aria-label="Attach file">
              📎
            </button>
            <button className="claude-mic" aria-label="Voice input">
              🎤
            </button>
            <button className="claude-options" aria-label="More options">
              ⋯
            </button>
          </div>
          <div className="claude-composer-right">
            <span className="claude-model-name">claude-sonnet</span>
            <span className="claude-effort-level">Extended</span>
            <button className="claude-effort-toggle" aria-label="Toggle effort level">
              ⚡
            </button>
          </div>
        </div>
      </div>

      {/* Status bar (when running) */}
      {currentSession && currentSession.status === 'running' && (
        <div className="claude-status-bar">
          <span className="claude-status-text">Running...</span>
          <button className="claude-interrupt-btn" onClick={handleInterrupt}>
            Stop
          </button>
        </div>
      )}
    </div>
  )
}
