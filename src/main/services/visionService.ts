export interface VisionAnalysisResult {
  isQuestion: boolean
  questionText?: string
  questionType?: 'leetcode' | 'system-design' | 'other'
  confidence?: number
}
export interface VisionServiceConfig {
  apiKey: string
  model?: string
}
export class VisionService {
  constructor(private config: VisionServiceConfig) {}
  async analyzeScreenshot(imageBase64: string): Promise<VisionAnalysisResult> {
    const data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64
    const model = this.config.model || 'gemini-3.6-flash'
    const prompt =
      'Analyze this screenshot for an interview question. Reply only JSON: {"isQuestion":boolean,"questionText":string,"questionType":"leetcode"|"system-design"|"other","confidence":number}. Extract visible question text when present.'
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.config.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            { parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data } }] }
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.2,
            maxOutputTokens: 1000
          }
        })
      }
    )
    if (!response.ok)
      throw new Error(`Gemini vision request failed (${response.status}): ${await response.text()}`)
    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const text =
      json.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '{}'
    const parsed = JSON.parse(text) as VisionAnalysisResult
    return {
      isQuestion: Boolean(parsed.isQuestion || parsed.questionText?.trim()),
      questionText: parsed.questionText || '',
      questionType: parsed.questionType || 'other',
      confidence: parsed.confidence ?? 0.5
    }
  }
}
