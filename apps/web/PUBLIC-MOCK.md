# Current Space public mock

The public `/demoappnew/` build mounts the current `App.tsx`, styles, pane components, docks and User settings through the local Space runtime. The production UI source remains unchanged. Build adapters replace YouTube playback, noVNC transport and the Live conversation transport with local examples.

Build from the repository root:

```sh
node scripts/build-public-mock.mjs /absolute/path/to/output
```

Deploy the output under `/demoappnew/`. Copy hashed assets before `index.html`, retain previous hashed assets for open tabs, and regenerate compressed siblings of stable files. The build writes `mock-version.json` and the demo bundle boundary report.

Only the mock media, shared brand assets, favicon and entry stylesheet are copied from the public directory. Desktop/mobile installers and authenticated proof pages are excluded. The included `.htaccess` scopes a same-origin policy to this directory, allowing embedded local previews and uploaded data while keeping external scripts and frames blocked. Preview scripts are separate same-origin files.

The host compresses HTML, JavaScript and styles through Apache DEFLATE. The build adds preload links for the initial app dependency graph and styles so boot downloads start together. A small independent `mock-loader.js` offers retry after a boot asset error or a long wait; it preserves existing mock data.

The mock uses the User role. Room 1 starts with four CLI panes in a 2×2 grid. Research Lab starts with Chat, YouTube, Browser and Files in that order in a 2×2 grid. Operations starts empty. The toolbar is collapsed into the right rail, matching the operator's screenshots, and each page load selects Room 1. Browser fullscreen remains an explicit user gesture.

Rooms, panes, files, links, tasks, clipboard, chat, browser tabs and sample uploads are local data. Changes persist under the dedicated `spaceapp.demoappnew.current.v2.` storage namespace; previous v1 data is retained separately. Invalid workspace snapshots and sticky note records fall back safely. Uploads are limited to 5 MB in the public mock.

Terminal processes, AI replies, remote browsers/desktops, Harness and external integrations are simulated. Microphone, SSH, VM operations and production services are not connected. Local file previews and media may load static assets from `/demoappnew/`; API requests, external transports and external windows are blocked.

UI source identity establishes parity with the selected live revision. Browser and regression proofs cover specific surfaces and workflows; they are not a certification of every production backend behavior or every possible UI interaction.
