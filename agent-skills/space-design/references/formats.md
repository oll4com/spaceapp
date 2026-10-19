# Formats

Every final design is composed at the exact pixel size of its format. Keep text, logos and faces inside the safe area:
the network's own interface (profile photos, story bars, mobile crops) may cover the rest.

| Id | Network | Format | Pixels | Safe area (top / right / bottom / left px) | Kind | Max motion (s) |
|---|---|---|---|---|---|---|
| `og` | Web | Open Graph link preview | 1200×630 | 0 / 0 / 0 / 0 | IMAGE | - |
| `square` | Instagram | Instagram post | 1080×1080 | 0 / 0 / 0 / 0 | BOTH | 60 |
| `portrait` | Instagram | Instagram portrait | 1080×1350 | 0 / 0 / 0 / 0 | BOTH | 60 |
| `ig-landscape` | Instagram | Instagram landscape | 1080×566 | 0 / 0 / 0 / 0 | BOTH | 60 |
| `story` | Instagram | Instagram story / Reels | 1080×1920 | 250 / 60 / 340 / 60 | BOTH | 90 |
| `fb-post` | Facebook | Facebook post | 1200×630 | 0 / 0 / 0 / 0 | BOTH | 60 |
| `fb-cover` | Facebook | Facebook cover | 1640×624 | 0 / 220 / 0 / 220 | IMAGE | - |
| `x` | X | X post | 1600×900 | 0 / 0 / 0 / 0 | BOTH | 140 |
| `x-header` | X | X header | 1500×500 | 60 / 60 / 60 / 60 | IMAGE | - |
| `linkedin` | LinkedIn | LinkedIn post | 1200×627 | 0 / 0 / 0 / 0 | BOTH | 60 |
| `linkedin-banner` | LinkedIn | LinkedIn banner | 1584×396 | 40 / 60 / 40 / 420 | IMAGE | - |
| `linkedin-company` | LinkedIn | LinkedIn company cover | 1128×191 | 20 / 40 / 20 / 40 | IMAGE | - |
| `yt-thumb` | YouTube | YouTube thumbnail | 1280×720 | 0 / 0 / 0 / 0 | IMAGE | - |
| `yt-banner` | YouTube | YouTube banner | 2560×1440 | 508 / 507 / 509 / 507 | IMAGE | - |
| `tiktok` | TikTok | TikTok video | 1080×1920 | 130 / 140 / 480 / 60 | BOTH | 60 |
| `pinterest` | Pinterest | Pinterest pin | 1000×1500 | 0 / 0 / 0 / 0 | BOTH | 60 |
| `ph-gallery` | Product Hunt | Product Hunt gallery | 1270×760 | 0 / 0 / 0 / 0 | IMAGE | - |
| `ph-thumb` | Product Hunt | Product Hunt thumbnail | 240×240 | 0 / 0 / 0 / 0 | BOTH | 10 |
| `github-social` | GitHub | GitHub social preview | 1280×640 | 40 / 40 / 40 / 40 | IMAGE | - |
| `devto-cover` | dev.to | dev.to cover | 1000×420 | 0 / 0 / 0 / 0 | IMAGE | - |
| `blog-hero` | Blog | Blog hero | 1600×900 | 0 / 0 / 0 / 0 | IMAGE | - |

Custom sizes: `custom-<width>x<height>`, 64–4096 px per side (for example `custom-1920x1080`).

## Marketing Copilot channels

A "Make graphic" request from a Marketing Copilot post uses the channel's format unless the brief names others.

| Channel | Format |
|---|---|
| X | `x` |
| LINKEDIN | `linkedin` |
| PRODUCT_HUNT | `ph-gallery` |
| YOUTUBE | `yt-thumb` |
| GITHUB | `github-social` |
| DEVTO | `devto-cover` |
| BLOG | `blog-hero` |
| REDDIT | `og` |
| HACKER_NEWS | no graphic |
