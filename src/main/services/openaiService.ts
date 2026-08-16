import { EventEmitter } from 'events'

export interface GeminiConfig { apiKey: string; model?: string; maxTokens?: number; temperature?: number; resumeDescription?: string }
type Content = { role: 'user' | 'model'; parts: Array<Record<string, unknown>> }

export class OpenAIService extends EventEmitter {
  private history: Content[] = []
  constructor(private config: GeminiConfig) { super() }

  async generateAnswer(question: string): Promise<string> {
    console.log('[Gemini] Generating answer for:', question)
    this.history.push({ role: 'user', parts: [{ text: `Interview question: ${question}` }] })
    this.history = this.history.slice(-10)
    const answer = await this.request({
      systemInstruction: { parts: [{ text: `You are answering a live interview as the candidate. Be natural, direct, and concise. Usually use 2-4 sentences; never use generic AI introductions. Candidate background: ${this.config.resumeDescription || 'Not supplied.'}` }] },
      contents: this.history,
      generationConfig: { maxOutputTokens: this.config.maxTokens || 500, temperature: this.config.temperature || 0.7 }
    })
    this.history.push({ role: 'model', parts: [{ text: answer }] })
    return answer
  }

  async generateSolutionFromImage(imageBase64: string, questionText?: string, _questionType?: 'leetcode' | 'system-design' | 'other'): Promise<string> {
    const data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64
    return this.request({ systemInstruction: { parts: [{ text: 'Solve the interview problem clearly with explanation, code, complexity, and edge cases.' }] }, contents: [{ role: 'user', parts: [{ text: questionText || 'Extract the question from this screenshot and solve it.' }, { inlineData: { mimeType: 'image/png', data } }] }], generationConfig: { maxOutputTokens: this.config.maxTokens || 2000, temperature: this.config.temperature || 0.7 } })
  }
  clearHistory(): void { this.history = [] }
  setApiKey(apiKey: string): void { this.config.apiKey = apiKey }

  private async request(payload: Record<string, unknown>): Promise<string> {
    const model = this.config.model || 'gemini-3.6-flash'
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.config.apiKey)}`
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    if (!response.ok || !response.body) throw new Error(`Gemini request failed (${response.status}): ${await response.text()}`)
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let answer = ''; let finishReason = 'unknown'
    const consume = (event: string): void => { const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n'); if (!data || data === '[DONE]') return; const parsed = JSON.parse(data) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }> }; const candidate = parsed.candidates?.[0]; finishReason = candidate?.finishReason || finishReason; const chunk = candidate?.content?.parts?.map((part) => part.text || '').join('') || ''; if (chunk) { answer += chunk; this.emit('stream', chunk) } }
    while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() || ''; events.forEach(consume) }
    buffer += decoder.decode(); if (buffer.trim()) consume(buffer)
    if (!answer.trim()) throw new Error('Gemini returned an empty answer. Please try again.')
    console.log('[Gemini] Response metadata:', { finishReason }); console.log('[Gemini] Complete answer:\n' + answer); this.emit('complete', answer); return answer
  }
}
