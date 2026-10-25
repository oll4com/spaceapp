# Upstream

- Repository: https://github.com/wshobson/agents
- Commit: `46891e7e60da0e52baf1050b7b6391b64e84c6d9`
- Plugins (version at that commit): `javascript-typescript` 1.2.3, `security-scanning` 1.3.2, `incident-response` 1.4.0, `observability-monitoring` 1.2.3
- Files: every file under `plugins/<plugin>/skills/` of those four plugins (17 skills, `SKILL.md` plus `references/`), copied unchanged into one folder per skill so their relative links between skills keep working.

Space changes: none to the vendored skills. This folder's index `SKILL.md` and this file are new. The plugins' agents and commands are not installed.

## License

MIT License

Copyright (c) 2024 Seth Hobson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE. 
