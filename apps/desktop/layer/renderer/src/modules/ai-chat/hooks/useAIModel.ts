import { useEffect, useMemo } from "react"

import { setAIModelState, useAIModelState } from "../atoms/session"
import { useAIConfiguration } from "./useAIConfiguration"

export const useAIModel = () => {
  const { data: configuration, isLoading } = useAIConfiguration()
  const modelState = useAIModelState()

  // Validate and sync persistent model with available models
  useEffect(() => {
    if (isLoading || !configuration) return

    const { selectedModel } = modelState
    const { defaultModel, availableModels = [] } = configuration

    // If no model is selected or selected model is not available
    if ((!selectedModel || !availableModels.includes(selectedModel)) && defaultModel) {
      setAIModelState({
        selectedModel: defaultModel,
      })
    }
  }, [configuration, isLoading, modelState])

  // Get current effective model
  const currentModel = useMemo(() => {
    const { selectedModel } = modelState
    const { defaultModel, availableModels = [] } = configuration || {}

    // Return selected model if valid
    if (selectedModel && availableModels.includes(selectedModel)) {
      return selectedModel
    }

    // Default to configured default
    return defaultModel || null
  }, [configuration, modelState])

  const changeModel = (model: string) => {
    if (!configuration?.availableModels?.includes(model)) {
      console.warn(`Model ${model} is not available in current configuration`)
      return
    }

    setAIModelState({
      selectedModel: model,
    })
  }

  return {
    data: {
      defaultModel: configuration?.defaultModel,
      availableModels: configuration?.availableModels || [],
      availableModelsMenu: configuration?.availableModelsMenu || [],
      currentModel,
    },
    isLoading,
    changeModel,
  }
}
