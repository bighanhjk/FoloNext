import { createDeepSeek } from "@ai-sdk/deepseek"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import type { SupportedActionLanguage } from "@follow/shared"
import { generateText, streamText } from "ai"

import { getClientAISettings } from "../../context"

// Provider types supported
type ProviderType = "openai" | "google" | "deepseek"

interface ModelConfig {
  model: any // Use any to avoid LanguageModelV2/V3 type conflicts between AI SDK versions
  providerId: ProviderType
  modelName: string
}

/**
 * Gets the configured AI SDK model based on BYOK settings.
 * Supports OpenAI, Deepseek, and Google (Gemini) providers.
 */
export function getModel(): ModelConfig | null {
  let settings
  try {
    settings = getClientAISettings()()
  } catch {
    return null
  }

  if (!settings?.byok?.enabled) return null

  const providers = settings.byok.providers.filter((p) => p.apiKey)
  if (providers.length === 0) return null

  // Priority: OpenAI > Deepseek > Google
  const openai = providers.find((p) => p.provider === "openai")
  if (openai?.apiKey) {
    const provider = createOpenAI({
      apiKey: openai.apiKey,
      baseURL: openai.baseURL || undefined,
    })
    return {
      model: provider("gpt-4o-mini"),
      providerId: "openai",
      modelName: "gpt-4o-mini",
    }
  }

  const deepseek = providers.find((p) => p.provider === "deepseek")
  if (deepseek?.apiKey) {
    const provider = createDeepSeek({
      apiKey: deepseek.apiKey,
      baseURL: deepseek.baseURL || undefined,
    })
    return {
      model: provider("deepseek-chat"),
      providerId: "deepseek",
      modelName: "deepseek-chat",
    }
  }

  const google = providers.find((p) => p.provider === "google")
  if (google?.apiKey) {
    const provider = createGoogleGenerativeAI({
      apiKey: google.apiKey,
      baseURL: google.baseURL || undefined,
    })
    // Support Gemini 2.0 Flash as default, can be extended
    return {
      model: provider("gemini-2.0-flash"),
      providerId: "google",
      modelName: "gemini-2.0-flash",
    }
  }

  return null
}

/**
 * Checks if BYOK provider is available
 */
export function hasProvider(): boolean {
  return getModel() !== null
}

// Prompt helpers
function getSummaryPrompt(language: SupportedActionLanguage): string {
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

function getTranslationPrompt(language: SupportedActionLanguage): string {
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
    default: {
      return `Translate the following text to ${language}`
    }
  }
}

/**
 * Generate summary using AI SDK
 */
export async function generateSummary(
  content: string,
  language: SupportedActionLanguage,
): Promise<string> {
  const config = getModel()
  if (!config) {
    throw new Error("No BYOK provider configured")
  }

  const prompt = getSummaryPrompt(language)

  const { text } = await generateText({
    model: config.model,
    system:
      "You are a helpful assistant that summarizes articles. Output only the summary text without any introduction or markdown formatting unless requested.",
    prompt: `${prompt}:\n\n${content.slice(0, 12000)}`,
  })

  return text ? `${text}\n\n[by ${config.providerId}]` : ""
}

/**
 * Generate translation using AI SDK
 */
export async function generateTranslation(
  content: string,
  targetLanguage: SupportedActionLanguage,
): Promise<string> {
  const config = getModel()
  if (!config) {
    throw new Error("No BYOK provider configured")
  }

  const prompt = getTranslationPrompt(targetLanguage)

  const { text } = await generateText({
    model: config.model,
    system:
      "You are a professional translator. Translate the given text accurately while preserving the original meaning and tone. Output only the translated text without any introduction or explanation.",
    prompt: `${prompt}:\n\n${content.slice(0, 12000)}`,
  })

  return text
}

/**
 * Stream chat with AI SDK - returns UI message stream for chat interface
 */
export async function chatStream(
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
  options?: { signal?: AbortSignal },
) {
  const config = getModel()
  if (!config) {
    throw new Error("No BYOK provider configured. Please configure a BYOK provider in AI settings.")
  }

  const result = streamText({
    model: config.model,
    messages,
    abortSignal: options?.signal,
  })

  return result
}

// Legacy interface for backwards compatibility
interface LegacyLLMProvider {
  id: string
  generateSummary: (content: string, language: SupportedActionLanguage) => Promise<string>
  generateTranslation: (content: string, targetLanguage: SupportedActionLanguage) => Promise<string>
  chatStream: (
    messages: { role: string; content: string }[],
    options?: { signal?: AbortSignal },
  ) => Promise<ReadableStream<string>>
}

class LLMService {
  getProvider(): LegacyLLMProvider | null {
    const config = getModel()
    if (!config) return null

    return {
      id: config.providerId,
      generateSummary,
      generateTranslation,
      // Legacy chatStream for compatibility - shouldn't be used for chat anymore
      chatStream: async (messages, options) => {
        const result = await chatStream(
          messages.map((m) => ({
            role: m.role as "user" | "assistant" | "system",
            content: m.content,
          })),
          options,
        )
        return result.textStream
      },
    }
  }
}

export const llmService = new LLMService()
