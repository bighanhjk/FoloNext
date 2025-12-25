import type { ParseResult } from "@ai-sdk/provider-utils"
import { env } from "@follow/shared/env.desktop"
import { llmService } from "@follow/store/llm"
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
 * BYOK Chat Transport that uses local llmService instead of server API
 */
class BYOKChatTransport implements ChatTransport<LocalBizUIMessage> {
  constructor(
    private options: {
      onValue?: (value: UIMessageChunk) => void
      titleHandler?: TitleHandlerOptions
    } = {},
  ) {}

  async sendMessages({
    messages,
    abortSignal,
  }: {
    messages: LocalBizUIMessage[]
    abortSignal?: AbortSignal
  } & ChatRequestOptions): Promise<ReadableStream<UIMessageChunk>> {
    const provider = llmService.getProvider()
    if (!provider) {
      throw new Error(
        "No BYOK provider configured. Please configure a BYOK provider in AI settings.",
      )
    }

    // Convert BizUIMessage to simple format for llmService
    const simpleMessages = messages.map((msg) => {
      // Try to extract text content from message parts first
      let textContent = ""

      if (msg.parts && Array.isArray(msg.parts)) {
        textContent = msg.parts
          .filter(
            (part): part is { type: "text"; text: string } =>
              part &&
              typeof part === "object" &&
              part.type === "text" &&
              typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("\n")
      }

      // Fallback to content if available (for older message format)
      if (!textContent && "content" in msg && typeof msg.content === "string") {
        textContent = msg.content
      }

      return {
        role: msg.role,
        content: textContent,
      }
    })

    // Get stream from BYOK provider
    const textStream = await provider.chatStream(simpleMessages, { signal: abortSignal })

    // Transform text stream to UIMessageChunk stream
    const { onValue } = this.options
    let isFirstChunk = true

    return textStream.pipeThrough(
      new TransformStream<string, UIMessageChunk>({
        transform(chunk, controller) {
          if (isFirstChunk) {
            // Send start chunk
            const startChunk: UIMessageChunk = {
              type: "start",
              messageId: crypto.randomUUID(),
            }
            onValue?.(startChunk)
            controller.enqueue(startChunk)
            isFirstChunk = false
          }

          // Send text delta chunk
          const textChunk: UIMessageChunk = {
            type: "text-delta",
            delta: chunk,
            id: "",
          }
          onValue?.(textChunk)
          controller.enqueue(textChunk)
        },
        flush(controller) {
          // Send finish chunk
          const finishChunk: UIMessageChunk = {
            type: "finish",
            finishReason: "stop",
          }
          onValue?.(finishChunk)
          controller.enqueue(finishChunk)
        },
      }),
    )
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
  const provider = llmService.getProvider()
  if (provider) {
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
