import { BrowserWindow, clipboard, desktopCapturer, ipcMain } from 'electron'
import { AnswerEntry } from '../../preload/index'
import { HistoryManager } from '../services/historyManager'
import { OpenAIService } from '../services/openaiService'
import { QuestionDetector } from '../services/questionDetector'
import { ScreenshotService } from '../services/screenshotService'
import { AppSettings, SettingsManager } from '../services/settingsManager'
import { VisionService } from '../services/visionService'
import { WhisperService } from '../services/whisperService'
import { clearTerminalLogs, getTerminalLogs } from '../services/terminalLog'

let whisperService: WhisperService | null = null
let openaiService: OpenAIService | null = null
let questionDetector: QuestionDetector | null = null
let settingsManager: SettingsManager | null = null
let historyManager: HistoryManager | null = null
let screenshotService: ScreenshotService | null = null
let visionService: VisionService | null = null
let mainWindow: BrowserWindow | null = null
let isCapturing = false
let pendingQuestionText = ''
let questionGenerationTimer: ReturnType<typeof setTimeout> | null = null

function setOverlayAlwaysOnTop(window: BrowserWindow, value: boolean): void {
  // Windows fullscreen/borderless applications can outrank the default
  // always-on-top level. `screen-saver` keeps this opt-in overlay accessible.
  window.setAlwaysOnTop(value, process.platform === 'win32' ? 'screen-saver' : 'floating')
  if (value && window.isVisible()) window.moveTop()
}

export function initializeIpcHandlers(window: BrowserWindow): void {
  mainWindow = window
  settingsManager = new SettingsManager()
  historyManager = new HistoryManager()
  questionDetector = new QuestionDetector()

  // In-app terminal: buffered main-process logs plus a narrow live event channel.
  ipcMain.handle('get-terminal-logs', () => getTerminalLogs())
  ipcMain.handle('clear-terminal-logs', () => {
    clearTerminalLogs()
    return { success: true }
  })

  // Settings handlers
  ipcMain.handle('get-settings', () => {
    return settingsManager?.getSettings()
  })

  ipcMain.handle('update-settings', (_event, updates: Partial<AppSettings>) => {
    settingsManager?.updateSettings(updates)

    // Apply window settings immediately
    if (updates.alwaysOnTop !== undefined && mainWindow) {
      setOverlayAlwaysOnTop(mainWindow, updates.alwaysOnTop)
    }
    if (updates.windowOpacity !== undefined && mainWindow) {
      mainWindow.setOpacity(updates.windowOpacity)
    }

    return settingsManager?.getSettings()
  })

  ipcMain.handle('select-gemini-key', (_event, index: number) => {
    settingsManager?.updateSettings({ activeGeminiKeyIndex: index })
    const settings = settingsManager?.getSettings()
    if (!settings?.geminiApiKey) throw new Error(`Gemini API Key ${index + 1} is empty. Add it in Settings first.`)
    openaiService?.setApiKey(settings.geminiApiKey)
    visionService = null
    console.log(`Switched to Gemini API Key ${settings.activeGeminiKeyIndex + 1}`)
    return settings
  })

  ipcMain.handle('has-api-keys', () => {
    return settingsManager?.hasApiKeys()
  })

  // Fetch OpenAI models
  ipcMain.handle('fetch-openai-models', async (_event, apiKey: string) => {
    try {
      if (!apiKey || apiKey.trim().length === 0) {
        throw new Error('API key is required')
      }

      const OpenAI = (await import('openai')).default
      const client = new OpenAI({ apiKey })

      const response = await client.models.list()

      // Filter for chat completion models and sort them
      const chatModels = response.data.map((model) => ({
        id: model.id,
        name: model.id
      }))

      return { success: true, models: chatModels }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to fetch models'
      console.error('Error fetching OpenAI models:', errorMessage)
      return { success: false, error: errorMessage, models: [] }
    }
  })

  // Audio capture handlers
  ipcMain.handle('start-capture', async () => {
    if (isCapturing) return { success: true }
    const settings = settingsManager?.getSettings()
    const geminiApiKey = settings?.geminiApiKey || ''

    // Debug: Log API key status (not the actual keys)
    console.log('API Keys configured:', {
      gemini: geminiApiKey ? 'Yes' : 'No',
      assemblyai: settings?.assemblyAiApiKey
        ? `Yes (${settings.assemblyAiApiKey.length} chars)`
        : 'No'
    })

    if (!geminiApiKey || !settings?.assemblyAiApiKey) {
      throw new Error('Gemini and AssemblyAI API keys must be configured in Settings.')
    }

    try {
      // IMPORTANT: Clean up any existing services/listeners first to prevent duplicates
      if (whisperService) {
        whisperService.removeAllListeners()
        whisperService = null
      }
      if (openaiService) {
        openaiService.removeAllListeners()
        openaiService = null
      }
      questionDetector?.removeAllListeners()

      // Initialize Whisper service for transcription
      whisperService = new WhisperService({
        apiKey: settings.assemblyAiApiKey,
        model: 'universal-streaming-english'
      })

      // Initialize OpenAI service for answer generation
      openaiService = new OpenAIService({
        apiKey: geminiApiKey,
        model: settings.geminiModel,
        resumeDescription: settings.resumeDescription
      })

      // Set up OpenAI event listeners ONCE
      openaiService.on('stream', (chunk) => {
        mainWindow?.webContents.send('answer-stream', chunk)
      })

      openaiService.on('complete', (answer) => {
        mainWindow?.webContents.send('answer-complete', answer)
      })

      // Set up Whisper event listeners
      whisperService.on('transcript', async (event) => {
        console.log('Transcript received:', event.text)
        if (pendingQuestionText && questionGenerationTimer) {
          clearTimeout(questionGenerationTimer)
          questionGenerationTimer = null
          console.log('Deferring answer generation while more speech arrives')
        }
        questionDetector?.addTranscript(event.text, event.isFinal)
        mainWindow?.webContents.send('transcript', event)
      })

      whisperService.on('utteranceEnd', () => {
        console.log('Processing utterance...')
        questionDetector?.onUtteranceEnd()
        mainWindow?.webContents.send('utterance-end')
      })

      whisperService.on('speechStarted', () => {
        mainWindow?.webContents.send('speech-started')
      })

      whisperService.on('error', (error) => {
        const errorMessage = error instanceof Error ? error.message : 'Unknown capture error'
        console.error('Whisper error:', errorMessage)
        mainWindow?.webContents.send('capture-error', errorMessage)
      })

      // Set up question detector listener ONCE
      questionDetector?.on('questionDetected', async (detection) => {
        pendingQuestionText = [pendingQuestionText, detection.text].filter(Boolean).join(' ')
        if (questionGenerationTimer) clearTimeout(questionGenerationTimer)
        // Keep the response snappy while still allowing a closely-following
        // sentence to cancel and merge with this question.
        const pauseMs = Math.min(700, Math.max(300, settingsManager?.getSettings().pauseThreshold || 700))
        questionGenerationTimer = setTimeout(async () => {
          const question = pendingQuestionText
          pendingQuestionText = ''
          questionGenerationTimer = null
          if (!question || !openaiService) return
          console.log('Question detected:', question)
          mainWindow?.webContents.send('question-detected', { ...detection, text: question })
          try {
            await openaiService.generateAnswer(question)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error('[Gemini] Answer generation failed:', error)
            mainWindow?.webContents.send('answer-error', message)
          }
        }, pauseMs)
      })

      // Start Whisper service
      await whisperService.start()
      isCapturing = true
      console.log('Audio capture started successfully')

      return { success: true }
    } catch (error) {
      console.error('start-capture error:', error)
      const errorMessage = error instanceof Error ? error.message : 'Failed to start capture'
      throw new Error(errorMessage)
    }
  })

  ipcMain.handle('stop-capture', async () => {
    isCapturing = false

    if (whisperService) {
      whisperService.stop()
      whisperService.removeAllListeners()
      whisperService = null
    }

    // Keep listeners so an answer already being generated remains visible.

    // Remove question detector listeners to prevent duplicates on next start
    questionDetector?.removeAllListeners()
    questionDetector?.clearBuffer()
    console.log('Audio capture stopped')

    return { success: true }
  })

  ipcMain.handle('get-capture-status', () => {
    return isCapturing
  })

  // Audio data from renderer
  ipcMain.on('audio-data', (_event, audioData: ArrayBuffer) => {
    if (whisperService && isCapturing) {
      whisperService.addAudioData(audioData)
    }
  })

  // Get audio sources for system audio capture
  ipcMain.handle('get-audio-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      fetchWindowIcons: true
    })

    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL()
    }))
  })

  // Window control handlers
  ipcMain.handle('set-always-on-top', (_event, value: boolean) => {
    if (mainWindow) setOverlayAlwaysOnTop(mainWindow, value)
    settingsManager?.setSetting('alwaysOnTop', value)
    return value
  })

  ipcMain.handle('set-window-opacity', (_event, value: number) => {
    mainWindow?.setOpacity(value)
    settingsManager?.setSetting('windowOpacity', value)
    return value
  })

  ipcMain.handle('minimize-window', () => {
    mainWindow?.hide()
  })

  ipcMain.handle('close-window', () => {
    mainWindow?.hide()
  })

  // Clear conversation history
  ipcMain.handle('clear-history', () => {
    openaiService?.clearHistory()
    return { success: true }
  })

  // History handlers
  ipcMain.handle('get-history', () => {
    return historyManager?.getHistory() || []
  })

  ipcMain.handle('save-history-entry', (_event, entry: AnswerEntry) => {
    historyManager?.addEntry(entry)
    return { success: true }
  })

  ipcMain.handle('save-history-entries', (_event, entries: AnswerEntry[]) => {
    historyManager?.addEntries(entries)
    return { success: true }
  })

  ipcMain.handle('clear-saved-history', () => {
    historyManager?.clearHistory()
    return { success: true }
  })

  ipcMain.handle('delete-history-entry', (_event, id: string) => {
    historyManager?.deleteEntry(id)
    return { success: true }
  })

  // Clipboard handlers
  ipcMain.handle('write-to-clipboard', (_event, text: string) => {
    try {
      clipboard.writeText(text)
      return { success: true }
    } catch (error) {
      console.error('Failed to write to clipboard:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Screenshot handlers
  ipcMain.handle('capture-screenshot', async () => {
    try {
      if (!screenshotService) {
        screenshotService = new ScreenshotService(mainWindow || undefined)
      }

      const result = await screenshotService.captureActiveWindow()

      if (result.success && result.imageData) {
        mainWindow?.webContents.send('screenshot-captured', { imageData: result.imageData })
      }

      // Capturing a fullscreen window can cause Windows to reorder its z-stack.
      // Restore the overlay immediately without stealing focus or showing it in
      // the taskbar.
      if (mainWindow?.isAlwaysOnTop()) setOverlayAlwaysOnTop(mainWindow, true)

      return result
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to capture screenshot'
      console.error('Screenshot capture error:', errorMessage)
      return {
        success: false,
        error: errorMessage
      }
    }
  })

  // Session API handler
  ipcMain.handle(
    'call-session-api',
    async (
      _event,
      payload: { sessionDuration: number; timestamp: number; [key: string]: unknown }
    ) => {
      try {
        // Placeholder API endpoint - can be configured via settings or environment variable
        const API_ENDPOINT = process.env.SESSION_API_URL || 'https://api.example.com/session'

        const response = await fetch(API_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        })

        if (!response.ok) {
          throw new Error(`API call failed with status: ${response.status}`)
        }

        const result = await response.json()
        console.log('Session API called successfully:', result)
        return { success: true, data: result }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to call session API'
        console.error('Session API error:', errorMessage)
        return {
          success: false,
          error: errorMessage
        }
      }
    }
  )

  ipcMain.handle('analyze-screenshot', async (_event, imageData: string) => {
    const settings = settingsManager?.getSettings()

    if (!settings?.geminiApiKey) {
      return {
        success: false,
        error: 'Gemini API key not configured. Please add it in Settings.'
      }
    }

    try {
      // Initialize services if needed
      if (!visionService) {
        visionService = new VisionService({
          apiKey: settings.geminiApiKey,
          model: settings.geminiModel
        })
      }

      if (!openaiService) {
        openaiService = new OpenAIService({
          apiKey: settings.geminiApiKey,
          model: settings.geminiModel,
          resumeDescription: settings.resumeDescription
        })

        // Set up OpenAI event listeners
        openaiService.on('stream', (chunk) => {
          mainWindow?.webContents.send('answer-stream', chunk)
        })

        openaiService.on('complete', (answer) => {
          mainWindow?.webContents.send('answer-complete', answer)
        })
      }

      // Analyze screenshot for interview question
      console.log('Analyzing screenshot for interview question...')
      const analysis = await visionService.analyzeScreenshot(imageData)

      console.log('Analysis result:', {
        isQuestion: analysis.isQuestion,
        hasQuestionText: !!analysis.questionText,
        questionTextLength: analysis.questionText?.length || 0,
        questionType: analysis.questionType,
        confidence: analysis.confidence
      })

      // Check if question is detected - be more lenient
      if (analysis.isQuestion) {
        // If we have question text, use it. Otherwise, we'll extract from image directly
        const questionText = analysis.questionText?.trim() || 'Interview question from screenshot'

        console.log('Question detected:', questionText.substring(0, 100))
        console.log('Question type:', analysis.questionType)

        // Send question detected event
        mainWindow?.webContents.send('question-detected-from-image', {
          text: questionText,
          questionType: analysis.questionType,
          confidence: analysis.confidence
        })

        // Generate solution - pass questionText only if we have it, otherwise let the model extract from image
        try {
          await openaiService.generateSolutionFromImage(
            imageData,
            analysis.questionText && analysis.questionText.trim().length > 10
              ? questionText
              : undefined,
            analysis.questionType
          )
        } catch (error) {
          console.error('Solution generation error:', error)
          mainWindow?.webContents.send('answer-error', (error as Error).message)
          return {
            success: false,
            error: (error as Error).message
          }
        }

        return {
          success: true,
          isQuestion: true,
          questionText: questionText,
          questionType: analysis.questionType
        }
      } else {
        // No question detected - but if confidence is moderate, still try to generate solution
        if (analysis.confidence && analysis.confidence >= 0.3) {
          console.log('Low confidence but attempting solution generation anyway...')
          const questionText = analysis.questionText?.trim() || 'Technical problem from screenshot'

          mainWindow?.webContents.send('question-detected-from-image', {
            text: questionText,
            questionType: analysis.questionType || 'other',
            confidence: analysis.confidence
          })

          try {
            await openaiService.generateSolutionFromImage(
              imageData,
              analysis.questionText && analysis.questionText.trim().length > 10
                ? questionText
                : undefined,
              analysis.questionType || 'other'
            )

            return {
              success: true,
              isQuestion: true,
              questionText: questionText,
              questionType: analysis.questionType || 'other'
            }
          } catch (error) {
            console.error('Solution generation error:', error)
            // Fall through to no question message
          }
        }

        // No question detected - log why
        console.log('No question detected. Analysis:', {
          isQuestion: analysis.isQuestion,
          confidence: analysis.confidence,
          hasQuestionText: !!analysis.questionText
        })

        mainWindow?.webContents.send('screenshot-no-question', {
          message:
            'No interview question detected in the screenshot. Please make sure the question is clearly visible and try again.'
        })
        return {
          success: true,
          isQuestion: false,
          message: 'No interview question detected in the screenshot'
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to analyze screenshot'
      console.error('Screenshot analysis error:', errorMessage)
      mainWindow?.webContents.send('answer-error', errorMessage)
      return {
        success: false,
        error: errorMessage
      }
    }
  })
}

export function cleanupIpcHandlers(): void {
  if (whisperService) {
    whisperService.stop()
    whisperService = null
  }
  if (openaiService) {
    openaiService.removeAllListeners()
    openaiService = null
  }
  questionDetector = null
  if (questionGenerationTimer) clearTimeout(questionGenerationTimer)
  questionGenerationTimer = null
  pendingQuestionText = ''
  settingsManager = null
  historyManager = null
  screenshotService = null
  visionService = null
  mainWindow = null
  isCapturing = false
}
