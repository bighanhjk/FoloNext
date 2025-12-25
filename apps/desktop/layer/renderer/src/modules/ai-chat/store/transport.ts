import type { ParseResult } from "@ai-sdk/provider-utils"
import { env } from "@follow/shared/env.desktop"
import { hasProvider } from "@follow/store/llm"
import type { BizUIMessage } from "@folo-services/ai-tools"
import type {
  ChatRequestOptions,
  ChatTransport,
  HttpChatTransportInitOptions,
  UIMessageChunk,
} from "ai"
import { HttpChatTransport, parseJsonEventStream, uiMessageChunkSchema } from "ai"

import { getAIModelState } from "../atoms/session"
import { AIPersistService } from "../services"
import type { BizUIMessage as LocalBizUIMessage } from "./types"

type TitleHandlerPersistOption = boolean | ((title: string) => void | Promise<void>)

export interface TitleHandlerOptions {
  chatId?: string
  shouldHandle?: () => boolean
  onTitleChange?: (title: string) => void
  persist?: TitleHandlerPersistOption
}

export interface CreateChatTransportOptions {
  onValue?: (value: UIMessageChunk) => void
  titleHandler?: TitleHandlerOptions
}

export interface CreateChatTitleHandlerOptions {
  chatId: string
  getActiveChatId: () => string | null | undefined
  onTitleChange?: (title: string) => void
  persist?: TitleHandlerPersistOption
}

export function createChatTitleHandler(
  options: CreateChatTitleHandlerOptions,
): TitleHandlerOptions {
  const { chatId, getActiveChatId, onTitleChange, persist } = options

  return {
    chatId,
    persist,
    onTitleChange,
    shouldHandle: () => getActiveChatId() === chatId,
  }
}

/**
 * BYOK Chat Transport that uses AI SDK streamText instead of server API
 */
class BYOKChatTransport implements ChatTransport<LocalBizUIMessage> {
  constructor(
    private options: {
      onValue?: (value: UIMessageChunk) => void
      titleHandler?: TitleHandlerOptions
    } = {},
  ) {}

  /**
   * Extract context information from data-block parts
   */
  private extractContextFromBlocks(messages: LocalBizUIMessage[]): {
    entryId?: string
    feedId?: string
  } {
    // Look for data-block parts in user messages
    for (const msg of messages) {
      if (msg.role !== "user" || !msg.parts) continue

      for (const part of msg.parts) {
        if (
          part &&
          typeof part === "object" &&
          part.type === "data-block" &&
          "data" in part &&
          Array.isArray(part.data)
        ) {
          for (const block of part.data) {
            if (block.type === "mainEntry" && block.value) {
              return { entryId: block.value }
            }
            if (block.type === "mainFeed" && block.value) {
              return { feedId: block.value }
            }
          }
        }
      }
    }
    return {}
  }

  /**
   * Build system prompt with article context
   */
  private async buildContextPrompt(entryId?: string): Promise<string | null> {
    if (!entryId) return null

    // Dynamically import to avoid circular dependencies
    const { getEntry } = await import("@follow/store/entry/getter")
    const { useSummaryStore } = await import("@follow/store/summary/store")

    const entry = getEntry(entryId)
    if (!entry) return null

    const parts: string[] = []

    // Add article metadata
    if (entry.title) {
      parts.push(`**Article Title:** ${entry.title}`)
    }
    if (entry.url) {
      parts.push(`**URL:** ${entry.url}`)
    }
    if (entry.author) {
      parts.push(`**Author:** ${entry.author}`)
    }

    // Add summary if available
    const summaryState = useSummaryStore.getState()
    const languages = Object.keys(summaryState.data[entryId] || {}) as Array<
      keyof (typeof summaryState.data)[string]
    >
    for (const lang of languages) {
      const summaryData = summaryState.data[entryId]?.[lang]
      if (summaryData?.summary) {
        parts.push(`**Summary (${String(lang)}):** ${summaryData.summary}`)
        break // Use first available summary
      }
    }

    // Add content (truncated for context window)
    if (entry.content) {
      const truncatedContent = entry.content.slice(0, 8000)
      parts.push(`**Article Content:**\n${truncatedContent}`)
    }

    if (parts.length === 0) return null

    return `You are a helpful assistant discussing the following article:\n\n${parts.join("\n\n")}\n\nPlease answer user questions based on this context.`
  }

  async sendMessages({
    messages,
    abortSignal,
  }: {
    messages: LocalBizUIMessage[]
    abortSignal?: AbortSignal
  } & ChatRequestOptions): Promise<ReadableStream<UIMessageChunk>> {
    // Import AI SDK functions
    const { chatStream, getModel } = await import("@follow/store/llm")

    const modelState = getAIModelState()
    const config = getModel(modelState.selectedModel || undefined)

    if (!config) {
      throw new Error(
        "No BYOK provider configured or selected model is invalid. Please check AI settings.",
      )
    }

    // Extract context from data-block
    const { entryId } = this.extractContextFromBlocks(messages)
    const contextPrompt = await this.buildContextPrompt(entryId)

    // Convert BizUIMessage to AI SDK message format
    const simpleMessages: Array<{ role: "user" | "assistant" | "system"; content: string }> = []

    // Add context as system message if available
    if (contextPrompt) {
      simpleMessages.push({
        role: "system",
        content: contextPrompt,
      })
    }

    // Process user/assistant messages
    for (const msg of messages) {
      let textContent = ""

      if (msg.parts && Array.isArray(msg.parts)) {
        textContent = msg.parts
          .map((part) => {
            if (part && typeof part === "object") {
              // Handle newer data-rich-text format
              if (
                part.type === "data-rich-text" &&
                part.data &&
                typeof part.data === "object" &&
                "text" in part.data &&
                typeof part.data.text === "string"
              ) {
                return part.data.text
              }

              // Handle simple text format
              if (part.type === "text" && "text" in part && typeof part.text === "string") {
                return part.text
              }
            }
            return ""
          })
          .filter(Boolean)
          .join("\n")
      }

      // Fallback to content if available (for older message format)
      if (!textContent && "content" in msg && typeof msg.content === "string") {
        textContent = msg.content
      }

      if (textContent) {
        simpleMessages.push({
          role: msg.role as "user" | "assistant" | "system",
          content: textContent,
        })
      }
    }

    // Use AI SDK streamText and get UI message stream
    const result = await chatStream(simpleMessages, {
      signal: abortSignal,
      modelId: modelState.selectedModel || undefined,
    })

    // Return the native UI message stream from AI SDK
    return result.toUIMessageStream() as ReadableStream<UIMessageChunk>
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    // BYOK doesn't support stream reconnection
    return null
  }
}

/**
 * Create a chat transport for AI SDK
 * This is used by the AbstractChat instance to communicate with AI providers
 * Uses BYOK provider if available, otherwise falls back to server API
 */
export function createChatTransport({ onValue, titleHandler }: CreateChatTransportOptions = {}) {
  // Check if BYOK is available
  if (hasProvider()) {
    return new BYOKChatTransport({ onValue, titleHandler })
  }

  // Fallback to server transport (for paid users)
  return new ExtendChatTransport({
    onValue,
    titleHandler,
    // Custom fetch configuration
    api: `${env.VITE_API_URL}/ai/chat`,
    credentials: "include",
    // Add selected model to request body
    body: () => {
      const modelState = getAIModelState()
      const { selectedModel } = modelState

      return selectedModel ? { model: selectedModel } : {}
    },
  })
}

const coerceFinishChunk = (chunk: ParseResult<UIMessageChunk>): UIMessageChunk | null => {
  const { rawValue } = chunk
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return null
  }

  if ((rawValue as { type?: unknown }).type !== "finish") {
    return null
  }

  const { finishReason, messageMetadata } = rawValue as {
    finishReason?: unknown
    messageMetadata?: unknown
  }

  return {
    type: "finish",
    finishReason: typeof finishReason === "string" ? finishReason : undefined,
    messageMetadata,
  } as UIMessageChunk
}

class ExtendChatTransport extends HttpChatTransport<BizUIMessage> {
  constructor(
    private options: HttpChatTransportInitOptions<BizUIMessage> & {
      onValue?: (value: UIMessageChunk) => void
      titleHandler?: TitleHandlerOptions
    },
  ) {
    super(options)
  }

  protected processResponseStream(
    stream: ReadableStream<Uint8Array<ArrayBufferLike>>,
  ): ReadableStream<UIMessageChunk> {
    const { onValue } = this.options || {}
    const handleGeneratedTitle = this.handleGeneratedTitle.bind(this)
    return parseJsonEventStream({
      stream,
      schema: uiMessageChunkSchema,
    }).pipeThrough(
      new TransformStream<ParseResult<UIMessageChunk>, UIMessageChunk>({
        async transform(chunk, controller) {
          const parsedChunk = chunk.success ? chunk.value : coerceFinishChunk(chunk)
          if (!parsedChunk) {
            throw chunk.error
          }

          await handleGeneratedTitle(parsedChunk)
          onValue?.(parsedChunk)
          controller.enqueue(parsedChunk)
        },
      }),
    )
  }

  private async handleGeneratedTitle(chunk: UIMessageChunk) {
    const { titleHandler } = this.options
    if (!titleHandler) {
      return
    }

    if (chunk.type !== "data-generated-title" || typeof chunk.data !== "string") {
      return
    }

    const shouldHandle = titleHandler.shouldHandle?.() ?? true
    if (!shouldHandle) {
      return
    }

    titleHandler.onTitleChange?.(chunk.data)

    const persistOption = titleHandler.persist
    const shouldPersist = persistOption === undefined ? true : persistOption

    if (!shouldPersist) {
      return
    }

    try {
      if (typeof persistOption === "function") {
        await persistOption(chunk.data)
        return
      }

      if (titleHandler.chatId) {
        await AIPersistService.updateSessionTitle(titleHandler.chatId, chunk.data)
      }
    } catch (error) {
      console.error("Failed to persist generated title:", error)
    }
  }

  override reconnectToStream(
    options: Parameters<HttpChatTransport<BizUIMessage>["reconnectToStream"]>[0],
  ) {
    options.chatId = encodeURIComponent(options.chatId)
    return super.reconnectToStream(options)
  }
}
