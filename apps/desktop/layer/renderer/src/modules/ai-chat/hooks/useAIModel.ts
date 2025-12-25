import { llmService } from "@follow/store/llm"
import { useEffect, useMemo } from "react"

import { setAIModelState, useAIModelState } from "../atoms/session"
import { useAIConfiguration } from "./useAIConfiguration"

// BYOK model identifier
export const BYOK_MODEL_ID = "byok/local"

export const useAIModel = () => {
  const { data: configuration, isLoading } = useAIConfiguration()
  const modelState = useAIModelState()

  // Check if BYOK provider is available
  const hasByokProvider = !!llmService.getProvider()

  // Validate and sync persistent model with available models
  useEffect(() => {
    if (isLoading) return

    const { selectedModel } = modelState
    const { defaultModel, availableModels = [] } = configuration || {}

    // Include BYOK in available models check
    const allAvailableModels = hasByokProvider
      ? [BYOK_MODEL_ID, ...availableModels]
      : availableModels

    // If no model is selected or selected model is not available
    if (!selectedModel || !allAvailableModels.includes(selectedModel)) {
      // Default to BYOK if available, otherwise server default
      const newDefault = hasByokProvider ? BYOK_MODEL_ID : defaultModel || null
      setAIModelState({
        selectedModel: newDefault,
      })
    }
  }, [configuration, isLoading, modelState, hasByokProvider])

  // Get current effective model
  const currentModel = useMemo(() => {
    const { selectedModel } = modelState
    const { defaultModel, availableModels = [] } = configuration || {}

    // Include BYOK in available models
    const allAvailableModels = hasByokProvider
      ? [BYOK_MODEL_ID, ...availableModels]
      : availableModels

    // Return selected model if valid, otherwise fallback
    if (selectedModel && allAvailableModels.includes(selectedModel)) {
      return selectedModel
    }

    // Default to BYOK if available
    return hasByokProvider ? BYOK_MODEL_ID : defaultModel || null
  }, [configuration, modelState, hasByokProvider])

  // Get available models with BYOK injected
  const availableModels = useMemo(() => {
    const serverModels = configuration?.availableModels || []
    return hasByokProvider ? [BYOK_MODEL_ID, ...serverModels] : serverModels
  }, [configuration, hasByokProvider])

  // Get available models menu with BYOK injected
  const availableModelsMenu = useMemo(() => {
    const serverMenu = configuration?.availableModelsMenu || []
    if (hasByokProvider) {
      const provider = llmService.getProvider()
      const byokMenuItem = {
        label: `BYOK (${provider?.id || "Local"})`,
        value: BYOK_MODEL_ID,
        group: "BYOK - Bring Your Own Key",
        paidLevel: undefined as string | undefined,
      }
      return [byokMenuItem, ...serverMenu]
    }
    return serverMenu
  }, [configuration, hasByokProvider])

  const changeModel = (model: string) => {
    // Allow BYOK model or server models
    if (model !== BYOK_MODEL_ID && !configuration?.availableModels?.includes(model)) {
      console.warn(`Model ${model} is not available in current configuration`)
      return
    }

    setAIModelState({
      selectedModel: model,
    })
  }

  return {
    data: {
      defaultModel: hasByokProvider ? BYOK_MODEL_ID : configuration?.defaultModel,
      availableModels,
      availableModelsMenu,
      currentModel,
    },
    isLoading,
    changeModel,
  }
}
