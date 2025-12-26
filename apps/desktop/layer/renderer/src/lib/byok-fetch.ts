import { IN_ELECTRON } from "@follow/shared/constants"

import { ipcServices } from "./client"

interface ProxyRequestInput {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

/**
 * Custom fetch that routes through main process IPC in Electron
 * to avoid CORS restrictions in production builds
 */
export async function byokFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // Convert input to string URL
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url

  // In non-Electron environment, use native fetch
  if (!IN_ELECTRON) {
    return fetch(input, init)
  }

  // Convert RequestInit to our simpler format
  const headers: Record<string, string> = {}
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value
      })
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) {
        headers[key] = value
      }
    } else {
      Object.assign(headers, init.headers)
    }
  }

  const proxyInput: ProxyRequestInput = {
    url,
    method: init?.method || "GET",
    headers,
    body: typeof init?.body === "string" ? init.body : undefined,
  }

  try {
    if (!ipcServices) {
      throw new Error("IPC services not available")
    }
    const result = await ipcServices.byok.proxyRequest(proxyInput)

    // Create a Response-like object from the result
    const responseHeaders = new Headers(result.headers)

    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: responseHeaders,
    })
  } catch (error) {
    // Re-throw with a more descriptive message
    throw new Error(
      `BYOK proxy request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    )
  }
}

/**
 * Create a custom fetch function that AI SDK providers can use
 */
export function createByokFetch(): typeof fetch {
  return byokFetch as typeof fetch
}
