import { Pause, Play, Terminal, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { TerminalLogEntry } from '../../../preload/index'

const LEVEL_STYLE: Record<TerminalLogEntry['level'], string> = {
  log: 'bg-slate-400',
  info: 'bg-sky-400',
  warn: 'bg-amber-400',
  error: 'bg-rose-400'
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function TerminalPanel(): React.JSX.Element {
  const [logs, setLogs] = useState<TerminalLogEntry[]>([])
  const [paused, setPaused] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const addLog = (entry: TerminalLogEntry): void => {
      setLogs((current) => current.some((log) => log.id === entry.id) ? current : [...current, entry].slice(-500))
    }
    const unsubscribe = window.api.onTerminalLog(addLog)
    void window.api.getTerminalLogs().then((entries) => setLogs((current) => {
      const ids = new Set(current.map((entry) => entry.id))
      return [...entries.filter((entry) => !ids.has(entry.id)), ...current].slice(-500)
    }))
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!paused && viewportRef.current) viewportRef.current.scrollTop = viewportRef.current.scrollHeight
  }, [logs, paused])

  const clear = async (): Promise<void> => {
    setLogs([])
    await window.api.clearTerminalLogs()
  }

  return (
    <section className="h-56 shrink-0 border-t border-violet-500/45 bg-[#070b14] shadow-[0_-8px_24px_rgba(2,6,23,0.32)]">
      <div className="flex h-9 items-center justify-between border-b border-dark-800 border-t-2 border-t-blue-500/70 bg-[#0a1020] px-3 app-no-drag">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-dark-300">
          <Terminal size={13} className="text-violet-400" />
          Terminal
          <span className="rounded bg-dark-800 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-dark-400">main process</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setPaused((value) => !value)} className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-dark-400 hover:bg-dark-800 hover:text-dark-200" title={paused ? 'Resume auto-scroll' : 'Pause auto-scroll'}>
            {paused ? <Play size={12} /> : <Pause size={12} />}{paused ? 'Resume' : 'Pause'}
          </button>
          <button onClick={() => void clear()} className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-dark-400 hover:bg-dark-800 hover:text-dark-200" title="Clear terminal logs">
            <Trash2 size={12} /> Clear
          </button>
        </div>
      </div>
      <div ref={viewportRef} className="custom-scrollbar h-[calc(100%-2.25rem)] overflow-auto px-3 py-2 font-mono text-[11px] leading-5 text-slate-300 app-no-drag">
        {logs.length === 0 ? <div className="text-dark-500">Waiting for main-process activity…</div> : logs.map((entry) => (
          <div key={entry.id} className="flex gap-2 whitespace-pre-wrap break-words">
            <span className="shrink-0 text-dark-600">{formatTime(entry.timestamp)}</span>
            <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${LEVEL_STYLE[entry.level]}`} aria-label={entry.level} />
            <span>{entry.message}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
