import { uiText, useUiLanguage } from "../ui-language/ui-language.js";

function SettingsCardLoading() {
  const language = useUiLanguage();
  return <div className="empty-mini" role="status">{uiText(language, "Loading settings…")}</div>;
}

export const settingsCardLoadingFallback = <SettingsCardLoading />;
