# Expo in an App Studio pane

## Create the app (first brief)

```sh
node --version   # Expo SDK 58 needs Node 22.13 or newer (the host's PATH has 22.23)
mkdir -p "$HOME/agent-workspace/app-studio/<pane>" && cd "$HOME/agent-workspace/app-studio/<pane>"
CI=1 npx create-expo-app@5 app
cd app && npx expo install react-dom react-native-web @expo/metro-runtime
```

- The default template uses Expo Router (`app/` folder, file-based routes) and TypeScript. Keep it.
- Set the app's `name`, `slug`, `scheme` and `ios.bundleIdentifier` / `android.package` in `app.json` once the
  operator chose a name (ask; use `com.example.<slug>` until then and say so).
- Add packages with `npx expo install <package>` (it picks the version matching the SDK), never a plain `npm install`
  of a native module.

## Safe areas and the viewport

- Wrap the app in `SafeAreaProvider` and use `SafeAreaView` (or `useSafeAreaInsets`) from
  `react-native-safe-area-context` on every screen.
- The web export must ask for the full screen, or the preview shows no safe areas: add `+html.tsx` in the routes folder
  (`src/app/` in the SDK 58 template) with `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />`.
  SDK 58 streams this document: it must render `headNodes` and `bodyNodes` from `useServerDocumentContext()`, or the
  export has no scripts and no styles and the preview shows unstyled HTML:

  ```tsx
  import { ScrollViewStyleReset, useServerDocumentContext } from 'expo-router/html';
  import type { PropsWithChildren } from 'react';

  export default function Root({ children }: PropsWithChildren) {
    const { htmlAttributes, bodyAttributes, headNodes, bodyNodes } = useServerDocumentContext();
    return (
      <html lang="en" {...htmlAttributes}>
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          <ScrollViewStyleReset />
          {headNodes}
        </head>
        <body {...bodyAttributes}>
          {children}
          {bodyNodes}
        </body>
      </html>
    );
  }
  ```
- `app.json` → `"web": { "output": "static" }` (the template says `"server"`): one HTML file per route, built from
  `+html.tsx`, which the preview serves. `"single"` ignores `+html.tsx`, so its page has no `viewport-fit=cover`.

## Export and preview

```sh
npx expo export --platform web          # writes dist/
```

Then `space_appstudio_preview` with `dir` = `<project>/dist` and the `route` of the screen. Re-export after every change
before the next preview: the tool serves the files, not a dev server.

## Checklist per screen

- Nothing under the status bar, the notch or Dynamic Island, or the home indicator.
- Text fits at 360 pt wide without clipping; nothing scrolls sideways.
- Touch targets at least 44 x 44 pt; primary action reachable with a thumb.
- Readable contrast in light and dark mode; `accessibilityLabel` on icon-only controls.
- Loading, empty and error states exist for anything that loads data.

## What the preview cannot show

Native-only behaviour (push notifications, camera, haptics, background tasks, in-app purchases) runs only in a native
build; the web export shows its fallback. Building APK/IPA files and store publishing are not part of the pane yet:
tell the operator when a brief needs them.
