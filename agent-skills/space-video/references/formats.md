# Formats

`space_video_formats` lists every video preset: the Design pane's formats that take motion, plus the video-only ones. The sizes,
safe areas and longest durations are the networks' current ones; the engine renders each output at exactly these pixels.

| Id | Network | Pixels | Safe area (top/right/bottom/left) | Longest |
|---|---|---|---|---|
| `youtube` | YouTube | 1920×1080 | 0 | 60 min |
| `youtube-short` | YouTube Short | 1080×1920 | 200/60/400/60 | 180 s |
| `ig-reel` | Instagram Reel | 1080×1920 | 250/60/340/60 | 90 s |
| `story` | Instagram story / Reels | 1080×1920 | 250/60/340/60 | 90 s |
| `tiktok` | TikTok | 1080×1920 | 130/140/480/60 | 60 s |
| `square` | Instagram post | 1080×1080 | 0 | 60 s |
| `portrait` | Instagram portrait | 1080×1350 | 0 | 60 s |
| `ig-landscape` | Instagram landscape | 1080×566 | 0 | 60 s |
| `fb-post` | Facebook post | 1200×630 | 0 | 60 s |
| `x` | X post | 1600×900 | 0 | 140 s |
| `linkedin` | LinkedIn post | 1200×627 | 0 | 60 s |
| `pinterest` | Pinterest pin | 1000×1500 | 0 | 60 s |
| `ph-thumb` | Product Hunt thumbnail | 240×240 | 0 | 10 s |
| `custom-<w>x<h>` | any | 64–4096 px per side | 0 | 60 s |

The safe area is where the network's own UI (profile row, caption, buttons) covers the picture: captions, overlays and the
narration's on-screen text stay inside it; the engine places captions there by itself.

A landscape source into a 9:16 format: `reframe` FACE (follow the faces per shot) or CENTER; OFF letterboxes it on a blurred
copy. A 9:16 source into `youtube`: OFF (pillarbox on blur) is usually right.
