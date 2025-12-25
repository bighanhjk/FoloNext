import type { SupportedActionLanguage } from "@follow/shared"

import { getClientAISettings } from "../../context"

interface LLMProvider {
  id: string
  generateSummary: (content: string, language: SupportedActionLanguage) => Promise<string>
  generateTranslation: (content: string, targetLanguage: SupportedActionLanguage) => Promise<string>
  chatStream: (
    messages: { role: string; content: string }[],
    options?: { signal?: AbortSignal },
  ) => Promise<ReadableStream<string>>
}

abstract class BaseProvider implements LLMProvider {
  abstract id: string
  protected abstract modelName: string
  protected baseURL: string
  protected apiKey: string

  constructor(apiKey: string, baseURL?: string) {
    this.apiKey = apiKey
    // Use provided baseURL or fallback to default (handled in derived class passing default)
    // Actually, derived classes should pass the default if baseURL is undefined in their constructor
    // but here we just take what's passed.
    this.baseURL = (baseURL || "").replace(/\/+$/, "")
  }

  // ... rest of methods
  protected getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    }
  }

  protected getChatEndpoint(): string {
    return `${this.baseURL}/chat/completions`
  }

  async chatStream(
    messages: { role: string; content: string }[],
    options?: { signal?: AbortSignal },
  ): Promise<ReadableStream<string>> {
    // implementation ...
    const response = await fetch(this.getChatEndpoint(), {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: this.modelName,
        messages,
        stream: true,
      }),
      signal: options?.signal,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      throw new Error(`${this.id} API Error: ${response.status} ${errorText}`)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error("Response body is not readable")

    return new ReadableStream({
      async start(controller) {
        const decoder = new TextDecoder()
        let buffer = ""

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() || ""

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed || !trimmed.startsWith("data: ")) continue

              const data = trimmed.slice(6)
              if (data === "[DONE]") continue

              try {
                const json = JSON.parse(data)
                const content = json.choices?.[0]?.delta?.content
                if (content) {
                  controller.enqueue(content)
                }
              } catch (e) {
                console.warn("Error parsing SSE data", e)
              }
            }
          }
        } catch (e) {
          controller.error(e)
        } finally {
          controller.close()
        }
      },
    })
  }

  async generateSummary(content: string, language: SupportedActionLanguage): Promise<string> {
    const prompt = this.getPrompt(language)

    try {
      const response = await fetch(this.getChatEndpoint(), {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({
          model: this.modelName,
          messages: [
            {
              role: "system",
              content:
                "You are a helpful assistant that summarizes articles. Output only the summary text without any introduction or markdown formatting unless requested.",
            },
            {
              role: "user",
              content: `${prompt}:\n\n${content.slice(0, 12000)}`,
            },
          ],
          stream: false,
        }),
      })

      if (!response.ok) {
        throw new Error(`${this.id} API Error: ${response.statusText}`)
      }

      const data = await response.json()
      const summaryText = data.choices?.[0]?.message?.content?.trim() || ""
      return summaryText ? `${summaryText}\n\n[by ${this.id}]` : ""
    } catch (error) {
      console.error(`${this.id} summary generation failed:`, error)
      throw error
    }
  }

  private getPrompt(language: SupportedActionLanguage): string {
    switch (language) {
      case "en": {
        return "Please summarize the following content concisely"
      }
      case "zh-CN":
      case "zh-TW": {
        return "请简要总结以下内容"
      }
      case "ja": {
        return "以下の内容を要約してください"
      }
      default: {
        return "Please summarize the following content"
      }
    }
  }

  async generateTranslation(
    content: string,
    targetLanguage: SupportedActionLanguage,
  ): Promise<string> {
    const prompt = this.getTranslationPrompt(targetLanguage)

    try {
      const response = await fetch(this.getChatEndpoint(), {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({
          model: this.modelName,
          messages: [
            {
              role: "system",
              content:
                "You are a professional translator. Translate the given text accurately while preserving the original meaning and tone. Output only the translated text without any introduction or explanation.",
            },
            {
              role: "user",
              content: `${prompt}:\n\n${content.slice(0, 12000)}`,
            },
          ],
          stream: false,
        }),
      })

      if (!response.ok) {
        throw new Error(`${this.id} API Error: ${response.statusText}`)
      }

      const data = await response.json()
      return data.choices?.[0]?.message?.content?.trim() || ""
    } catch (error) {
      console.error(`${this.id} translation generation failed:`, error)
      throw error
    }
  }

  private getTranslationPrompt(language: SupportedActionLanguage): string {
    switch (language) {
      case "en": {
        return "Translate the following text to English"
      }
      case "zh-CN": {
        return "将以下文本翻译成简体中文"
      }
      case "zh-TW": {
        return "將以下文本翻譯成繁體中文"
      }
      case "ja": {
        return "以下のテキストを日本語に翻訳してください"
      }
      case "fr": {
        return "Traduisez le texte suivant en français"
      }
      case "de": {
        return "Übersetzen Sie den folgenden Text ins Deutsche"
      }
      case "es": {
        return "Traduzca el siguiente texto al español"
      }
      case "pt": {
        return "Traduza o seguinte texto para português"
      }
      case "ko": {
        return "다음 텍스트를 한국어로 번역해 주세요"
      }
      case "ru": {
        return "Переведите следующий текст на русский язык"
      }
      default: {
        return `Translate the following text to ${language}`
      }
    }
  }
}

class DeepseekProvider extends BaseProvider {
  id = "deepseek"
  protected modelName = "deepseek-chat"

  constructor(apiKey: string, baseURL?: string) {
    super(apiKey, baseURL || "https://api.deepseek.com")
  }
}

class OpenAIProvider extends BaseProvider {
  id = "openai"
  protected modelName = "gpt-4o-mini"

  constructor(apiKey: string, baseURL?: string) {
    super(apiKey, baseURL || "https://api.openai.com/v1")
  }
}

class GeminiProvider extends BaseProvider {
  id = "google"
  protected modelName = "gemini-1.5-flash"

  constructor(apiKey: string, baseURL?: string) {
    super(apiKey, baseURL || "https://generativelanguage.googleapis.com/v1beta/openai")
  }
}

class LLMService {
  private get settings() {
    try {
      return getClientAISettings()()
    } catch {
      return null
    }
  }

  getProvider(): LLMProvider | null {
    const { settings } = this
    if (!settings?.byok?.enabled) return null

    const providers = settings.byok.providers.filter((p) => p.apiKey)
    if (providers.length === 0) return null

    // Priority: OpenAI > Gemini > Deepseek (or based on which one is valid)
    // Actually, maybe we should respect the order in the list?
    // But for now, let's just pick the first valid matching one in a priority list.

    const openai = providers.find((p) => p.provider === "openai")
    if (openai?.apiKey) {
      return new OpenAIProvider(openai.apiKey, openai.baseURL || undefined)
    }

    const gemini = providers.find((p) => p.provider === "google")
    if (gemini?.apiKey) {
      return new GeminiProvider(gemini.apiKey, gemini.baseURL || undefined)
    }

    const deepseek = providers.find((p) => p.provider === "deepseek")
    if (deepseek?.apiKey) {
      return new DeepseekProvider(deepseek.apiKey, deepseek.baseURL || undefined)
    }

    return null
  }
}

export const llmService = new LLMService()
