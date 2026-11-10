import { uiText, useUiLanguage } from "./ui-language.js";

/** One text in the operator's language, for markup that takes no hook of its own (the room layers' empty states in App.tsx). */
export function UiText({ text }: { text: string }) {
  return <>{uiText(useUiLanguage(), text)}</>;
}
