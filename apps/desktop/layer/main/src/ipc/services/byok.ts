import type { IpcContext } from "electron-ipc-decorator"
import { IpcMethod, IpcService } from "electron-ipc-decorator"

import { logger } from "~/logger"

interface ProxyRequestInput {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

interface ProxyStreamChunk {
  type: "data" | "error" | "done"
  data?: string
  error?: string
}

/**
 * ByokService - IPC service for proxying BYOK API requests through main process
 *
 * This service allows the renderer process to make HTTP requests to external APIs
 * (like DeepSeek, OpenAI, Google) without being blocked by CORS/webSecurity restrictions.
 */
export class ByokService extends IpcService {
  static override readonly groupName = "byok"

  /**
   * Proxy a non-streaming HTTP request
   */
  @IpcMethod()
  async proxyRequest(
    _context: IpcContext,
    input: ProxyRequestInput,
  ): Promise<{
    status: number
    statusText: string
    headers: Record<string, string>
    body: string
  }> {
    const { url, method = "POST", headers = {}, body } = input

    logger.info(`[ByokService] proxyRequest: ${method} ${url}`)

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
      })

      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })

      const responseBody = await response.text()

      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: responseBody,
      }
    } catch (error) {
      logger.error("[ByokService] proxyRequest failed:", error)
      throw error
    }
  }

  /**
   * Proxy a streaming HTTP request (for chat completions)
   * Returns chunks via callback pattern
   */
  @IpcMethod()
  async proxyStreamRequest(
    context: IpcContext,
    input: ProxyRequestInput,
  ): Promise<{ success: boolean; error?: string }> {
    const { url, method = "POST", headers = {}, body } = input

    logger.info(`[ByokService] proxyStreamRequest: ${method} ${url}`)

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
      })

      if (!response.ok) {
        const errorBody = await response.text()
        logger.error(`[ByokService] Stream request failed: ${response.status} ${errorBody}`)
        // Send error via IPC event
        context.sender.send("byok:stream-chunk", {
          type: "error",
          error: `HTTP ${response.status}: ${errorBody}`,
        } satisfies ProxyStreamChunk)
        return { success: false, error: `HTTP ${response.status}` }
      }

      if (!response.body) {
        context.sender.send("byok:stream-chunk", {
          type: "error",
          error: "No response body",
        } satisfies ProxyStreamChunk)
        return { success: false, error: "No response body" }
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          context.sender.send("byok:stream-chunk", {
            type: "done",
          } satisfies ProxyStreamChunk)
          break
        }

        const chunk = decoder.decode(value, { stream: true })
        context.sender.send("byok:stream-chunk", {
          type: "data",
          data: chunk,
        } satisfies ProxyStreamChunk)
      }

      return { success: true }
    } catch (error) {
      logger.error("[ByokService] proxyStreamRequest failed:", error)
      context.sender.send("byok:stream-chunk", {
        type: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      } satisfies ProxyStreamChunk)
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
    }
  }
}
