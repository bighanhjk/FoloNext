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

// Helper to get display name for provider
export function getProviderName(provider: string): string {
  switch (provider) {
    case "openai": {
      return "OpenAI"
    }
    case "deepseek": {
      return "DeepSeek"
    }
    case "google": {
      return "Google"
    }
    case "local": {
      return "Local"
    }
    default: {
      return provider.charAt(0).toUpperCase() + provider.slice(1)
    }
  }
}

/**
 * Gets the configured AI SDK model based on BYOK settings.
 * Supports OpenAI, Deepseek, and Google (Gemini) providers.
 * @param modelId Optional specific model ID (e.g., "byok/openai"). If omitted, picks first available.
 */
export function getModel(modelId?: string): ModelConfig | null {
  let settings
  try {
    settings = getClientAISettings()()
  } catch {
    return null
  }

  if (!settings?.byok?.enabled) return null

  // Allow local provider without API key, others require it
  const providers = settings.byok.providers.filter(
    (p) => p.apiKey || (p.provider as string) === "local",
  )
  if (providers.length === 0) return null

  // If specific model requested, try to find it
  let targetProviderType: ProviderType | "local" | undefined
  if (modelId?.startsWith("byok/")) {
    targetProviderType = modelId.split("/")[1] as ProviderType | "local"
  }

  // Helper to create config from provider setting
  const createConfig = (p: (typeof providers)[0]): ModelConfig | null => {
    switch (p.provider as string) {
      case "openai": {
        if (!p.apiKey) return null
        return {
          model: createOpenAI({
            apiKey: p.apiKey,
            baseURL: p.baseURL || undefined,
          })("gpt-4o-mini"),
          providerId: "openai",
          modelName: "gpt-4o-mini",
        }
      }
      case "deepseek": {
        if (!p.apiKey) return null
        return {
          model: createDeepSeek({
            apiKey: p.apiKey,
            baseURL: p.baseURL || undefined,
          })("deepseek-chat"),
          providerId: "deepseek",
          modelName: "deepseek-chat",
        }
      }
      case "google": {
        if (!p.apiKey) return null
        return {
          model: createGoogleGenerativeAI({
            apiKey: p.apiKey,
            baseURL: p.baseURL || undefined,
          })("gemini-2.0-flash"),
          providerId: "google",
          modelName: "gemini-2.0-flash",
        }
      }
      case "local": {
        // For local, we default to OpenAI compatible interface for now (e.g. Ollama)
        // This is a placeholder for future deeper local integration
        if (!p.baseURL) return null
        return {
          model: createOpenAI({
            apiKey: p.apiKey || "not-needed",
            baseURL: p.baseURL,
          })("llama3"), // Default local model name, user might need to config this later
          providerId: "local" as any,
          modelName: "local-model",
        }
      }
      default: {
        return null
      }
    }
  }

  // If specific target requested
  if (targetProviderType) {
    const provider = providers.find((p) => p.provider === targetProviderType)
    if (provider) {
      return createConfig(provider)
    }
    // If requested provider not found/valid, return null or fallback? returning null is safer for explicit choice
    return null
  }

  // Fallback: Priority OpenAI > Deepseek > Google > Local
  const order: (ProviderType | "local")[] = ["openai", "deepseek", "google", "local"]
  for (const type of order) {
    const p = providers.find((p) => p.provider === type)
    if (p) {
      const config = createConfig(p)
      if (config) return config
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
  options?: { signal?: AbortSignal; modelId?: string },
) {
  const config = getModel(options?.modelId)
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
