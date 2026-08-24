import { EventEmitter } from 'events'
export interface TranscriptEvent {
  text: string
  isFinal: boolean
  confidence: number
}
export interface WhisperConfig {
  apiKey: string
  model?: string
}
export class WhisperService extends EventEmitter {
  private socket: WebSocket | null = null
  constructor(private config: WhisperConfig) {
    super()
  }
  async start(): Promise<void> {
    const tokenResponse = await fetch(
      'https://streaming.assemblyai.com/v3/token?expires_in_seconds=600',
      { headers: { Authorization: this.config.apiKey } }
    )
    if (!tokenResponse.ok)
      throw new Error(
        `AssemblyAI token request failed (${tokenResponse.status}): ${await tokenResponse.text()}`
      )
    const { token } = (await tokenResponse.json()) as { token: string }
    const params = new URLSearchParams({
      sample_rate: '16000',
      speech_model: this.config.model || 'universal-streaming-english',
      format_turns: 'true',
      token
    })
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${params}`)
      this.socket = socket
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error('AssemblyAI connection error'))
      socket.onmessage = (event) => this.onMessage(String(event.data))
      socket.onerror = () => this.emit('error', new Error('AssemblyAI connection error'))
      socket.onclose = () => {
        this.socket = null
      }
    })
  }
  addAudioData(data: ArrayBuffer | Buffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(data)
  }
  stop(): void {
    if (this.socket) {
      this.socket.close()
      this.socket = null
    }
  }
  private onMessage(raw: string): void {
    try {
      const message = JSON.parse(raw) as {
        type?: string
        transcript?: string
        end_of_turn?: boolean
        end_of_turn_confidence?: number
      }
      if (message.type === 'SpeechStarted') {
        this.emit('speechStarted')
        return
      }
      if (message.type !== 'Turn' || !message.transcript?.trim()) return
      const isFinal = Boolean(message.end_of_turn)
      this.emit('transcript', {
        text: message.transcript.trim(),
        isFinal,
        confidence: message.end_of_turn_confidence ?? 1
      } satisfies TranscriptEvent)
      if (isFinal) this.emit('utteranceEnd')
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error('Invalid AssemblyAI response'))
    }
  }
}
