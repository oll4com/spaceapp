# Space Dots original character assets

Six original, individually hand-authored SVG vector illustrations: `orbit.svg` (astronaut), `nova.svg` (star), `byte.svg` (robot), `comet.svg` (comet), `luna.svg` (crescent moon), and `cosmo.svg` (ringed planet).

Authored directly by the assistant through original Bézier paths, ellipses, layered vector shapes, gradients, and procedural SVG grain. These are vector illustrations, not outputs from an AI image-generation tool, traced images, emoji, or adaptations of existing character brands. Orbit's glass visor serves as its face; the other characters share small, expressive navy facial features.

Every asset has a `320 × 320` viewBox and transparent background. The illustration and diffuse shadow fit within the central `240 × 240` area, leaving ample alpha margin. Upper-left lighting, softly shaded volume, subtle seeded grain, and restrained details tie the family together. Silhouettes and facial contrast are designed for recognition at `32 × 32`; fine texture is intended for larger sizes. Each SVG has an identifying `<title>`, `role="img"`, and character-prefixed resource IDs. All references are internal; there are no scripts, external resources, text artwork, or embedded raster images.

The shared palette uses deep navy `#263447`, warm ivory `#FFFCED`, cream `#FFF0CF`, blue-grey `#6E8A99`, amber `#EFC585`, muted cyan `#93C8CB`, coral-peach `#EEA38B`, silver-blue `#BACCD7`, and lavender-blue `#A2AED6`. Related lighter and darker tones provide volume rather than hard outlines. Shadows remain translucent so assets work on varied surfaces.

Assets are static: no CSS, JavaScript, or built-in animation. UI controls and motion belong to the application layer. The app draws the animated Dots from these bodies in `apps/web/src/features/agent-pane/dot-avatar-art.tsx` (faces and moods in `DotAvatar.tsx`); these files stay the static artwork for notifications and thumbnails. Redraw a body in both places.

License: inherited from the project's [MIT License](../../../../../LICENSE). No separate asset license is granted.
