import { config } from 'dotenv'
import { app, safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
config()
export interface AppSettings {
  geminiApiKey: string
  geminiApiKeys: string[]
  activeGeminiKeyIndex: number
  assemblyAiApiKey: string
  geminiModel: string
  alwaysOnTop: boolean
  windowOpacity: number
  pauseThreshold: number
  autoStart: boolean
  resumeDescription: string
}
const key = (name: string): string => process.env[name] || process.env[`VITE_${name}`] || ''
const DEFAULT_SETTINGS: AppSettings = {
  geminiApiKey: key('GEMINI_API_KEY'),
  geminiApiKeys: [key('GEMINI_API_KEY'), '', '', '', ''],
  activeGeminiKeyIndex: 0,
  assemblyAiApiKey: key('ASSEMBLYAI_API_KEY'),
  geminiModel: process.env.GEMINI_MODEL || process.env.VITE_GEMINI_MODEL || 'gemini-3.6-flash',
  alwaysOnTop: true,
  windowOpacity: 1,
  pauseThreshold: 1500,
  autoStart: false,
  resumeDescription: ''
}
export class SettingsManager {
  private settingsPath = path.join(app.getPath('userData'), 'settings.json')
  private settings = this.loadSettings()
  private loadSettings(): AppSettings {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const saved = JSON.parse(fs.readFileSync(this.settingsPath, 'utf-8'))
        for (const [plain, encrypted] of [['geminiApiKey', 'geminiApiKeyEncrypted'], ['assemblyAiApiKey', 'assemblyAiApiKeyEncrypted']] as const) {
          if (safeStorage.isEncryptionAvailable() && saved[encrypted]) {
            try {
              saved[plain] = safeStorage.decryptString(Buffer.from(saved[encrypted], 'base64'))
              delete saved[encrypted]
            } catch {
              saved[plain] = ''
            }
          }
        }
        if (safeStorage.isEncryptionAvailable() && Array.isArray(saved.geminiApiKeysEncrypted)) {
          saved.geminiApiKeys = saved.geminiApiKeysEncrypted.map((encrypted: string) => {
            try { return encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : '' } catch { return '' }
          })
        }
        return this.normalizeSettings({ ...DEFAULT_SETTINGS, ...saved })
      }
    } catch (error) {
      console.error('Failed to load settings:', error)
    }
    return this.normalizeSettings({ ...DEFAULT_SETTINGS })
  }
  private normalizeSettings(settings: AppSettings): AppSettings {
    const suppliedKeys = Array.isArray(settings.geminiApiKeys) ? settings.geminiApiKeys : []
    const geminiApiKeys = Array.from({ length: 5 }, (_, index) =>
      (suppliedKeys[index] ?? (index === 0 ? settings.geminiApiKey : '')).trim()
    )
    const activeGeminiKeyIndex = Math.max(0, Math.min(4, Number(settings.activeGeminiKeyIndex) || 0))
    return { ...settings, geminiApiKeys, activeGeminiKeyIndex, geminiApiKey: geminiApiKeys[activeGeminiKeyIndex] || '' }
  }
  private saveSettings(): void {
    try {
      const saved: Record<string, unknown> = { ...this.settings }
      saved.geminiApiKeys = []
      if (safeStorage.isEncryptionAvailable())
        for (const [plain, encrypted] of [
          ['geminiApiKey', 'geminiApiKeyEncrypted'],
          ['assemblyAiApiKey', 'assemblyAiApiKeyEncrypted']
        ] as const)
          if (typeof saved[plain] === 'string' && saved[plain]) {
            saved[encrypted] = safeStorage.encryptString(saved[plain] as string).toString('base64')
            saved[plain] = ''
          }
      if (safeStorage.isEncryptionAvailable()) {
        saved.geminiApiKeysEncrypted = this.settings.geminiApiKeys.map((apiKey) =>
          apiKey ? safeStorage.encryptString(apiKey).toString('base64') : ''
        )
      }
      fs.writeFileSync(this.settingsPath, JSON.stringify(saved, null, 2))
    } catch (error) {
      console.error('Failed to save settings:', error)
    }
  }
  getSettings(): AppSettings {
    return { ...this.settings }
  }
  getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.settings[key]
  }
  updateSettings(updates: Partial<AppSettings>): void {
    this.settings = this.normalizeSettings({ ...this.settings, ...updates })
    this.saveSettings()
  }
  setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.settings = this.normalizeSettings({ ...this.settings, [key]: value })
    this.saveSettings()
  }
  resetToDefaults(): void {
    this.settings = { ...DEFAULT_SETTINGS }
    this.saveSettings()
  }
  hasApiKeys(): boolean {
    return Boolean(this.settings.geminiApiKey && this.settings.assemblyAiApiKey)
  }
}
