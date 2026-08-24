import { BrowserWindow } from 'electron'

export type TerminalLogLevel = 'log' | 'info' | 'warn' | 'error'

export interface TerminalLogEntry {
  id: number
  level: TerminalLogLevel
  timestamp: number
  message: string
}

const MAX_LOG_ENTRIES = 500
const SECRET_KEY = /(api[-_]?key|authorization|token|secret|password)/i
const logs: TerminalLogEntry[] = []
let logWindow: BrowserWindow | null = null
let nextId = 1
let installed = false

function redactString(value: string): string {
  if (/^data:(image|audio|video)\//i.test(value)) return '[binary payload omitted]'
  return value
    .replace(/AIza[\w-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]')
    .replace(/(Bearer\s+)[^\s,}]+/gi, '$1[REDACTED]')
}

function formatValue(value: unknown, seen = new WeakSet<object>()): string {
  if (typeof value === 'string') return redactString(value)
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (value instanceof Error) return `${value.name}: ${redactString(value.message)}${value.stack ? `\n${redactString(value.stack)}` : ''}`
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return '[binary payload omitted]'
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    if (Array.isArray(value)) return `[${value.map((item) => formatValue(item, seen)).join(', ')}]`
    return `{ ${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}: ${SECRET_KEY.test(key) ? '[REDACTED]' : formatValue(item, seen)}`)
      .join(', ')} }`
  }
  return redactString(String(value))
}

function append(level: TerminalLogLevel, args: unknown[]): void {
  const entry: TerminalLogEntry = {
    id: nextId++,
    level,
    timestamp: Date.now(),
    message: args.map((arg) => formatValue(arg)).join(' ')
  }
  logs.push(entry)
  if (logs.length > MAX_LOG_ENTRIES) logs.splice(0, logs.length - MAX_LOG_ENTRIES)
  if (logWindow && !logWindow.isDestroyed()) logWindow.webContents.send('terminal-log', entry)
}

export function installMainProcessLogCapture(): void {
  if (installed) return
  installed = true
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  }

  ;(['log', 'info', 'warn', 'error'] as const).forEach((level) => {
    console[level] = (...args: unknown[]): void => {
      original[level](...args)
      append(level, args)
    }
  })
}

export function setTerminalLogWindow(window: BrowserWindow | null): void {
  logWindow = window
}

export function getTerminalLogs(): TerminalLogEntry[] {
  return [...logs]
}

export function clearTerminalLogs(): void {
  logs.length = 0
}
