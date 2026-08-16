import { AlertCircle, CheckCircle, Coffee, Eye, EyeOff, Loader2, Save, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AppSettings, useInterviewStore } from '../store/interviewStore'

interface ModelOption {
  id: string
  name: string
}

const GEMINI_MODELS: ModelOption[] = [
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }
]

export function SettingsModal(): React.ReactNode | null {
  const { settings, showSettings, setShowSettings, setSettings } = useInterviewStore()
  const [localSettings, setLocalSettings] = useState<AppSettings>(settings)
  const [showOpenAIKey, setShowOpenAIKey] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [models, setModels] = useState<ModelOption[]>(GEMINI_MODELS)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const fetchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    setLocalSettings(settings)
  }, [settings])

  // Fetch models when API key changes (with debounce)
  useEffect(() => {
    // Clear previous timeout
    if (fetchTimeoutRef.current) {
      clearTimeout(fetchTimeoutRef.current)
    }

    // Gemini's available model names are configured locally. Do not call the
    // OpenAI models endpoint with a Gemini key.
    setModels(GEMINI_MODELS)
    setModelsError(null)
    setModelsLoading(false)

    return () => {
      if (fetchTimeoutRef.current) {
        clearTimeout(fetchTimeoutRef.current)
      }
    }
  }, [])

  if (!showSettings) return null

  const handleSave = async (): Promise<void> => {
    try {
      setSaveStatus('saving')
      const updatedSettings = await window.api.updateSettings(localSettings)
      setSettings(updatedSettings as AppSettings)
      setSaveStatus('saved')
      setTimeout(() => {
        setSaveStatus('idle')
        setShowSettings(false)
      }, 1000)
    } catch (err) {
      console.error('Failed to save settings:', err)
      setSaveStatus('error')
      setTimeout(() => setSaveStatus('idle'), 3000)
    }
  }

  const handleOpacityChange = async (value: number): Promise<void> => {
    setLocalSettings({ ...localSettings, windowOpacity: value })
    await window.api.setWindowOpacity(value)
  }

  const handleClose = (): void => {
    setLocalSettings(settings)
    setShowSettings(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md mx-4 bg-dark-900 rounded-xl border border-dark-700 shadow-2xl animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-700">
          <h2 className="text-lg font-semibold text-dark-100">Settings</h2>
          <button
            onClick={handleClose}
            className="p-1.5 rounded hover:bg-dark-700 transition-colors text-dark-400 hover:text-dark-200"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-6 space-y-5 max-h-[32rem] overflow-y-auto custom-scrollbar">
          {/* Gemini API Key */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-dark-200">
              Gemini API Keys
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noopener noreferrer"
                className="ml-2 text-xs text-blue-400 hover:underline"
              >
                Get key →
              </a>
            </label>
            <p className="text-xs text-dark-500">
              Paste one key per line. The app automatically switches to the next key only when Gemini returns a 429 quota error.
            </p>
            <div className="relative">
              <textarea
                value={localSettings.geminiApiKeys || localSettings.geminiApiKey}
                onChange={(e) => {
                  const geminiApiKeys = e.target.value
                  const geminiApiKey = geminiApiKeys.split(/[\r\n,]+/).map((key) => key.trim()).find(Boolean) || ''
                  setLocalSettings({ ...localSettings, geminiApiKeys, geminiApiKey })
                }}
                placeholder={'Paste Gemini API keys, one per line\nKey 1\nKey 2\nKey 3'}
                rows={5}
                className="w-full px-3 py-2 pr-10 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-blue-500 transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowOpenAIKey(!showOpenAIKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-dark-400 hover:text-dark-200"
              >
                {showOpenAIKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-dark-200">AssemblyAI API Key</label>
            <p className="text-xs text-dark-500">Used for live English transcription.</p>
            <input
              type="password"
              value={localSettings.assemblyAiApiKey}
              onChange={(e) => setLocalSettings({ ...localSettings, assemblyAiApiKey: e.target.value })}
              placeholder="Enter your AssemblyAI API key"
              className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Gemini Model */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-dark-200">
              Answer Generation Model
            </label>
            {modelsLoading ? (
              <div className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg animate-pulse">
                <div className="flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin text-blue-400" />
                  <span className="text-sm text-dark-400">Loading models...</span>
                </div>
              </div>
            ) : modelsError ? (
              <div className="space-y-1">
                <select
                  value={localSettings.geminiModel}
                  onChange={(e) =>
                    setLocalSettings({ ...localSettings, geminiModel: e.target.value })
                  }
                  className="w-full px-3 py-2 bg-dark-800 border border-red-500/50 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-red-500 transition-colors"
                >
                  <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
                  <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                  <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                </select>
                <div className="flex items-center gap-1.5 text-xs text-red-400">
                  <AlertCircle size={12} />
                  <span>{modelsError}</span>
                </div>
              </div>
            ) : models.length > 0 ? (
              <select
                value={localSettings.geminiModel}
                onChange={(e) =>
                  setLocalSettings({ ...localSettings, geminiModel: e.target.value })
                }
                className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-blue-500 transition-colors"
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            ) : (
              <select
                value={localSettings.geminiModel}
                onChange={(e) =>
                  setLocalSettings({ ...localSettings, geminiModel: e.target.value })
                }
                className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-blue-500 transition-colors"
                disabled
              >
                <option value="">Enter API key to load models</option>
              </select>
            )}
          </div>

          {/* Resume Description */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-dark-200">Resume Description</label>
            <p className="text-xs text-dark-500">
              Paste your resume content here (JSON, YML format preferably). This will be used to
              provide context-aware answers. Do not include icons, emojis, or other symbols.
            </p>
            <textarea
              value={localSettings.resumeDescription}
              onChange={(e) =>
                setLocalSettings({ ...localSettings, resumeDescription: e.target.value })
              }
              placeholder="Enter your resume content here..."
              rows={8}
              className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-blue-500 transition-colors resize-y"
            />
          </div>

          {/* Pause Threshold */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-dark-200">
              Silence Detection
              <span className="ml-2 text-xs text-dark-400">{localSettings.pauseThreshold}ms</span>
            </label>
            <input
              type="range"
              min="500"
              max="3000"
              step="100"
              value={localSettings.pauseThreshold}
              onChange={(e) =>
                setLocalSettings({ ...localSettings, pauseThreshold: Number(e.target.value) })
              }
              className="w-full accent-blue-500"
            />
            <p className="text-xs text-dark-500">
              How long to wait detecting the question for transcription (Recommended : 1500ms)
            </p>
          </div>

          {/* Window Opacity */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-dark-200">
              Window Opacity
              <span className="ml-2 text-xs text-dark-400">
                {Math.round(localSettings.windowOpacity * 100)}%
              </span>
            </label>
            <input
              type="range"
              min="0.3"
              max="1"
              step="0.05"
              value={localSettings.windowOpacity}
              onChange={(e) => handleOpacityChange(Number(e.target.value))}
              className="w-full accent-blue-500"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-dark-700">
          <div className="flex items-center gap-3">
            <a
              href="https://buymeacoffee.com"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Coffee size={16} />
              <span>Buy me a coffee</span>
            </a>
            {saveStatus === 'error' && (
              <div className="flex items-center gap-2 text-sm text-red-400">
                <AlertCircle size={16} />
                <span>Failed to save</span>
              </div>
            )}
            {saveStatus === 'saved' && (
              <div className="flex items-center gap-2 text-sm text-green-400">
                <CheckCircle size={16} />
                <span>Saved!</span>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleClose}
              className="px-4 py-2 text-sm font-medium text-dark-300 hover:text-dark-100 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saveStatus === 'saving'}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              <Save size={16} />
              <span>{saveStatus === 'saving' ? 'Saving...' : 'Save'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
