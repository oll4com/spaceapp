# Upstream

- Repository: https://github.com/alchaincyf/huashu-design
- Commit: `0830494ecb1c117e25b313a8114fe55a6bf2b125` (master, 2026-09-22)
- Files: `SKILL.md`, `references/`, `scripts/`, `demos/`, the non-media files of `assets/`, `LICENSE`, `SECURITY.md`, `README.en.md`, `package.json` and `test-prompts.json`, copied unchanged (file modes kept) into `huashu-design/`.
- Not vendored: audio and image media (`assets/*.mp3`, `assets/sfx/**`, the `.png`/`.jpg` files of `assets/showcases/**` and `assets/`, about 31 MB), `package-lock.json`, `.gitignore` and `.env.example`.

Space changes to vendored files (for the agent-skills quality gate; meaning unchanged):
- `SKILL.md`: the path placeholders `references/xxx.md`, `assets/xxx.jsx`, `scripts/xxx.sh` read `<file>` instead of `xxx`.
- `references/hero-animation-case-study.md`: the link to `demos/hero-animation-v9.mp4`, which upstream does not ship, is plain text.
- `references/camera-language.md`, `references/gsap-recipes.md`: the Greek letter pi is spelled `pi`; `assets/showcases/INDEX.md`: the benchmark name with the Greek letter tau is spelled `tau2-Bench` (Space docs are kept free of Greek characters).

This folder's index `SKILL.md` and this file are new. Previously installed on this host on 2026-04-28 as `~/.codex/skills/huashu-design` (plus the alias `huashu-desing`); reinstalled on 2026-10-12 as the built-in Space skill plugin `space-huashu-design` (one name per skill), whose nested skill keeps the upstream name `huashu-design`.

## License

MIT License

Copyright (c) 2026 alchaincyf (花叔 · 花生)

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
