# Motion (MP4 and GIF)

Motion is rendered in this pane with HyperFrames (read the `space-hyperframes` skill first) and uploaded with
`space_design_save_asset`.

1. Pick the format: a `VIDEO` or `BOTH` format (`story`, `tiktok`, `square`, `x`, `linkedin` …) and keep the duration at
   or under its `maxDurationSec` (`references/formats.md`); the pane's default is `motion.defaultDurationSec`.
2. Build the composition at the format's exact pixel size, with the brand kit's colours and fonts; keep text inside the
   safe area for the whole animation.
3. Render the MP4 with the pinned `hyperframes` CLI into a scratch directory of this session (never the repository).
   When the pane's `motion.gif` is on, also make a GIF of the same composition (short, at most 10 s, palette-optimised).
4. Look at frames from the start, the middle and the end before uploading.
5. `space_design_save_asset` with the absolute path, the `formatId`, `engine: "MOTION"`, a label and the `requestId`.
   The API checks the file's bytes (MP4, GIF, PNG, JPEG, WebP only) and stores it as a Media artifact of this room.
6. Deliver the MP4 (and the GIF) with `space_design_deliver`. Delete the scratch files afterwards.
