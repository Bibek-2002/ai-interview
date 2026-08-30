export interface AudioCaptureOptions {
  sampleRate?: number
  channelCount?: number
  echoCancellation?: boolean
  noiseSuppression?: boolean
  autoGainControl?: boolean
}

const DEFAULT_OPTIONS: AudioCaptureOptions = {
  sampleRate: 16000,
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
}

export class AudioCaptureService {
  private audioContext: AudioContext | null = null
  private mediaStream: MediaStream | null = null
  private workletNode: AudioWorkletNode | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private isCapturing = false
  private options: AudioCaptureOptions
  private captureType: 'microphone' | 'system' | null = null
  private systemSourceId: string | null = null
  private isRestarting = false
  private deviceChangeListener: (() => void) | null = null
  private lastRestartTime = 0

  constructor(options: AudioCaptureOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  async startMicrophoneCapture(): Promise<void> {
    if (this.isCapturing) return

    try {
      this.captureType = 'microphone'
      this.systemSourceId = null

      // Get microphone stream
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: this.options.sampleRate,
          channelCount: this.options.channelCount,
          echoCancellation: this.options.echoCancellation,
          noiseSuppression: this.options.noiseSuppression,
          autoGainControl: this.options.autoGainControl
        }
      })

      // Listen to track end
      this.mediaStream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          console.log('Microphone audio track ended, triggering restart...')
          this.restartCapture()
        }
      })

      // Create audio context
      this.audioContext = new AudioContext({
        sampleRate: this.options.sampleRate
      })

      // Create source from microphone
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream)

      // Load and create audio worklet for processing
      await this.audioContext.audioWorklet.addModule(this.createWorkletBlobUrl())

      this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-processor')

      // Handle audio data from worklet
      this.workletNode.port.onmessage = (event) => {
        if (event.data.audioData) {
          this.handleAudioData(event.data.audioData)
        }
      }

      // Connect nodes
      this.sourceNode.connect(this.workletNode)

      this.isCapturing = true
      this.setupDeviceChangeDetector()
    } catch (error) {
      console.error('Failed to start microphone capture:', error)
      this.captureType = null
      throw error
    }
  }

  async startSystemAudioCapture(sourceId: string): Promise<void> {
    if (this.isCapturing) return

    try {
      this.captureType = 'system'
      this.systemSourceId = sourceId

      // Use desktopCapturer source for system audio
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // @ts-ignore - Electron specific constraint
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId
          }
        },
        video: {
          // @ts-ignore - Electron specific constraint
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId
          }
        }
      })

      // Remove video track, we only need audio
      this.mediaStream.getVideoTracks().forEach((track) => track.stop())

      // Listen to track end
      this.mediaStream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          console.log('System audio track ended, triggering restart...')
          this.restartCapture()
        }
      })

      // Create audio context
      this.audioContext = new AudioContext({
        sampleRate: this.options.sampleRate
      })

      // Create source from stream
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream)

      // Load audio worklet
      await this.audioContext.audioWorklet.addModule(this.createWorkletBlobUrl())

      this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-processor')

      this.workletNode.port.onmessage = (event) => {
        if (event.data.audioData) {
          this.handleAudioData(event.data.audioData)
        }
      }

      this.sourceNode.connect(this.workletNode)

      this.isCapturing = true
      this.setupDeviceChangeDetector()
    } catch (error) {
      console.error('Failed to start system audio capture:', error)
      this.captureType = null
      this.systemSourceId = null
      throw error
    }
  }

  private createWorkletBlobUrl(): string {
    const workletCode = `
      class AudioProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.bufferSize = 4096;
          this.buffer = new Float32Array(this.bufferSize);
          this.bufferIndex = 0;
        }

        process(inputs, outputs, parameters) {
          const input = inputs[0];
          if (input && input[0]) {
            const inputData = input[0];
            
            for (let i = 0; i < inputData.length; i++) {
              this.buffer[this.bufferIndex++] = inputData[i];
              
              if (this.bufferIndex >= this.bufferSize) {
                // Convert Float32 to Int16 for Deepgram
                const int16Buffer = new Int16Array(this.bufferSize);
                for (let j = 0; j < this.bufferSize; j++) {
                  const s = Math.max(-1, Math.min(1, this.buffer[j]));
                  int16Buffer[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                
                this.port.postMessage({
                  audioData: int16Buffer.buffer
                }, [int16Buffer.buffer]);
                
                this.buffer = new Float32Array(this.bufferSize);
                this.bufferIndex = 0;
              }
            }
          }
          return true;
        }
      }

      registerProcessor('audio-processor', AudioProcessor);
    `

    const blob = new Blob([workletCode], { type: 'application/javascript' })
    return URL.createObjectURL(blob)
  }

  private handleAudioData(audioData: ArrayBuffer): void {
    // Send audio data to main process
    if (window.api) {
      window.api.sendAudioData(audioData)
    }
  }

  async stop(): Promise<void> {
    if (this.deviceChangeListener) {
      navigator.mediaDevices.removeEventListener('devicechange', this.deviceChangeListener)
      this.deviceChangeListener = null
    }

    if (this.workletNode) {
      this.workletNode.disconnect()
      this.workletNode = null
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect()
      this.sourceNode = null
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop())
      this.mediaStream = null
    }

    if (this.audioContext) {
      await this.audioContext.close()
      this.audioContext = null
    }

    this.isCapturing = false
    this.captureType = null
    this.systemSourceId = null
  }

  getIsCapturing(): boolean {
    return this.isCapturing
  }

  private setupDeviceChangeDetector(): void {
    if (!this.deviceChangeListener) {
      let debounceTimeout: any = null

      this.deviceChangeListener = () => {
        if (!this.isCapturing || this.isRestarting) return

        if (debounceTimeout) {
          clearTimeout(debounceTimeout)
        }

        debounceTimeout = setTimeout(async () => {
          console.log('Audio capture: device change event detected, restarting stream...')
          await this.restartCapture()
        }, 1000)
      }

      navigator.mediaDevices.addEventListener('devicechange', this.deviceChangeListener)
    }
  }

  private async restartCapture(): Promise<void> {
    if (!this.isCapturing || this.isRestarting) return
    this.isRestarting = true

    const now = Date.now()
    if (now - this.lastRestartTime < 2000) {
      console.log('Audio capture: restart requested too soon, ignoring to avoid loop.')
      this.isRestarting = false
      return
    }
    this.lastRestartTime = now

    try {
      console.log('Audio capture: restarting stream due to device switch/track end...')

      // 1. Disconnect and cleanup old nodes
      if (this.workletNode) {
        this.workletNode.disconnect()
        this.workletNode = null
      }

      if (this.sourceNode) {
        this.sourceNode.disconnect()
        this.sourceNode = null
      }

      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach((track) => track.stop())
        this.mediaStream = null
      }

      if (this.audioContext) {
        await this.audioContext.close()
        this.audioContext = null
      }

      // 2. Re-acquire media stream
      if (this.captureType === 'system' && this.systemSourceId) {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            // @ts-ignore - Electron specific constraint
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: this.systemSourceId
            }
          },
          video: {
            // @ts-ignore - Electron specific constraint
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: this.systemSourceId
            }
          }
        })

        // Remove video track, we only need audio
        this.mediaStream.getVideoTracks().forEach((track) => track.stop())
      } else {
        // Microphone capture
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: this.options.sampleRate,
            channelCount: this.options.channelCount,
            echoCancellation: this.options.echoCancellation,
            noiseSuppression: this.options.noiseSuppression,
            autoGainControl: this.options.autoGainControl
          }
        })
      }

      // Listen to track end on new stream
      this.mediaStream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          console.log('Audio track ended, triggering restart...')
          this.restartCapture()
        }
      })

      // 3. Re-create audio context and nodes
      this.audioContext = new AudioContext({
        sampleRate: this.options.sampleRate
      })

      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream)

      await this.audioContext.audioWorklet.addModule(this.createWorkletBlobUrl())

      this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-processor')

      this.workletNode.port.onmessage = (event) => {
        if (event.data.audioData && this.isCapturing) {
          this.handleAudioData(event.data.audioData)
        }
      }

      this.sourceNode.connect(this.workletNode)
      console.log('Audio capture: restarted successfully.')
    } catch (error) {
      console.error('Audio capture: failed to restart stream:', error)
    } finally {
      this.isRestarting = false
    }
  }
}
