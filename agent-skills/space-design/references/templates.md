# Templates

`space_design_render` renders one HTML template at the format's exact pixel size, server side, in a Chrome with no
network and no script from your fields. Every field is plain text (HTML is escaped); colours are `#rrggbb`.

| Template | Use it for | Images |
|---|---|---|
| `photo-headline` | A generated or real photo as the background, headline and subline over it | `backgroundAssetId` |
| `gradient-headline` | Brand gradient with a headline; quick announcements | none |
| `quote-card` | A quote with its author | optional background |
| `release-announcement` | A version release: version badge, headline, what is new, URL | optional background |
| `screenshot-frame` | An app screenshot in a device frame with a headline | `screenshotArtifactId` (required) |
| `wide-banner` | Headers and covers (X header, LinkedIn banner, YouTube banner): text kept inside the safe area | optional background |
| `bold-thumbnail` | YouTube thumbnails and small cards: big short text, high contrast | optional background |

## Fields (`params`)

| Field | Limit | Notes |
|---|---|---|
| `headline` | 140 characters | The main line. Short beats long. |
| `subline` | 280 | One supporting sentence. |
| `cta` | 40 | Button-like call to action ("Install in one command"). |
| `quote`, `author` | 400, 80 | `quote-card`. |
| `badge` | 40 | A small label ("New", "Open source"). |
| `version` | 24 | `release-announcement` ("0.3.0"). |
| `url` | 80 | Shown as text, never fetched. |
| `colors` | `background`, `surface`, `primary`, `accent`, `text` | Override the brand kit's colours for this render only. |
| `focalX`, `focalY` | 0-100 (default 50) | The part of the background image the crop keeps. |
| `overlay` | 0-90 (default 45) | How much the background darkens under the text. |

The brand kit's colours, fonts and first logo apply to every template; `colors` overrides a single render.

## Versions and resizes

Every render is a library asset that keeps its template and fields. Render again with changed `params` for a text edit
(no new image generation), or with another `formatId` for the same design at another size; pass `parentAssetId` (the
asset you started from) so the library keeps the versions together.
