import { getProviderName } from "@follow/store/llm"
import { useMemo } from "react"

import { useAISettingKey } from "~/atoms/settings/ai"

export const useAIConfiguration = () => {
  const byok = useAISettingKey("byok")

  const models = useMemo(() => {
    if (!byok?.enabled || !byok.providers) return []

    return byok.providers
      .filter((p) => p.apiKey || p.provider === "local")
      .map((p) => ({
        value: `byok/${p.provider}`,
        label: `BYOK (${getProviderName(p.provider)})`,
        group: "BYOK Providers",
      }))
  }, [byok])

  return {
    data: {
      defaultModel: models[0]?.value,
      availableModels: models.map((m) => m.value),
      availableModelsMenu: models,
    },
    isLoading: false,
    refetch: () => {},
  }
}
