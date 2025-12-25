import { getProviderName } from "@follow/store/llm"
import { useMemo } from "react"

import { useAISettingKey } from "~/atoms/settings/ai"

export const useAIConfiguration = () => {
  const byok = useAISettingKey("byok")

  const models = useMemo(() => {
    if (!byok?.enabled || !byok.providers) return []

    return byok.providers
      .filter((p) => p.apiKey || (p.provider as string) === "local")
      .map((p) => ({
        value: `byok/${p.provider}`,
        label: `BYOK (${getProviderName(p.provider)})`,
        group: "BYOK Providers",
        paidLevel: undefined as string | undefined,
      }))
  }, [byok])

  return {
    data: {
      defaultModel: models[0]?.value,
      availableModels: models.map((m) => m.value),
      availableModelsMenu: models,
      // Stubs for TypeScript compatibility (not used in BYOK mode)
      usage: undefined as { used: number; total: number } | undefined,
      rateLimit: undefined as
        | { warningLevel?: string; projectedLimitTime?: number | null; usageRate?: number }
        | undefined,
      attachmentLimits: undefined,
      freeQuota: undefined,
    },
    isLoading: false,
    refetch: () => {},
  }
}
