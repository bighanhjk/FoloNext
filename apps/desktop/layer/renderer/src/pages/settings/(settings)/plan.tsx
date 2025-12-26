import { SettingPlan } from "~/modules/settings/tabs/plan"
import { SettingsTitle } from "~/modules/settings/title"
import { defineSettingPageData } from "~/modules/settings/utils"

const iconName = "i-mgc-power-outline"
const priority = (1000 << 1) + 17

export const loader = defineSettingPageData({
  icon: iconName,
  name: "titles.plan.short",
  title: "titles.plan.long",
  priority,
  // TODO: Subscription features disabled for BYOK mode
  hideIf: () => true,
})

export function Component() {
  return (
    <>
      <SettingsTitle />
      <SettingPlan />
    </>
  )
}
