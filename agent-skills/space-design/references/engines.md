# Engines

| Engine | Model (Space Gateway) | Best for | Notes |
|---|---|---|---|
| `NANO_BANANA` | `gemini-3.1-flash-image` | Photos, illustrations, scenes; fast | The default. Google AI Pro pool. |
| `NANO_BANANA_PRO` | `gemini-3-pro-image` | Detailed, high-fidelity images | Slower; use when Nano Banana is not good enough. |
| `GPT_IMAGE` | `gpt-image` | Illustrations, product-style renders, images with a little text | ChatGPT accounts pool. |
| `TEMPLATE` | none | Exact text, logos, release cards, thumbnails | No generation cost; always exact. |
| `MOTION` | none (HyperFrames in this pane) | MP4/GIF | See `motion.md`. |

`space_design_generate_image` generates at the image model's nearest aspect ratio to the format (16:9 for `x`, 9:16 for
`story`, 21:9 for wide banners) and saves the image to the library. It is rarely the final asset: compose it with
`space_design_render` (`photo-headline`, `wide-banner`, `bold-thumbnail`) at each exact size, with the text as template
fields. Image models draw text badly: never ask them for the headline, a URL or a logo.

## Prompts

- Describe the subject, the setting, the light, the palette (name the brand colours: deep navy `#0A0E24`, cyan
  `#67D9F5`) and the composition ("subject on the right third, calm empty space on the left for text").
- Leave room for the template's text where the safe area is; say so in the prompt.
- No real people, no third-party logos or trademarks, no screenshots of other products.
- Reference images (`referenceArtifactIds`, at most 3) guide style or content: a screenshot of the app, a photo the
  operator supplied.

## Cost and limits

Every generation runs on the `space-design` gateway key, which has a daily cost cap the operator set. When the gateway
answers DESIGN_ENGINE_UNAVAILABLE (no key, the cap reached, no account available), use a template and say so in the
delivery message. Generate once per design and re-render the template for text changes and resizes.
