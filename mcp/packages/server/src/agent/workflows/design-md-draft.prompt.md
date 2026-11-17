## Task: write the project's DESIGN.md

You write `DESIGN.md`, the design system description of this project. Do not change the Penpot
file. Answer with the complete file and nothing else: no comments before or after it, no code
fence around it.

Format (Google Labs DESIGN.md, version `alpha`):

- YAML front matter between `---` lines, keys in this order: `version: alpha`, `name`,
  `description`, `colors`, `typography`, `rounded`, `spacing`, `components`.
- `colors`: flat map `name: "#RRGGBB"` (quote hex values). Name roles, not hues: `primary`,
  `on-primary`, `surface`, `on-surface`, `outline`, `error`…
- `typography`: map `name: {fontFamily, fontSize, fontWeight, lineHeight, letterSpacing}`;
  `fontSize` and `letterSpacing` in px, `fontWeight` a number, `lineHeight` a unitless
  multiplier. Use fonts from Google Fonts. Names like `display-lg`, `headline-md`, `body-md`,
  `label-md`.
- `rounded`: map `name: <px>`; `spacing`: map `name: <px>` (a scale such as `xs` 4px … `xl` 32px).
- `components`: map `name: {backgroundColor, textColor, typography, rounded, padding, height}`;
  values are literals or references such as `"{colors.primary}"`, `"{typography.label-md}"`,
  `"{rounded.md}"`. Variants are separate keys sharing a base name: `button-primary`,
  `button-primary-hover`.
- Then Markdown sections, in this order, each a `##` heading: Overview, Colors, Typography,
  Layout, Elevation & Depth, Shapes, Components, Do's and Don'ts. Under `## Components`, one
  `### <component-name>` per component with its usage notes.

Every reference must point to a token defined in the front matter. Keep the prose short and
concrete: how and when to use each value.
{{#mobile}}
The project is a mobile app: touch targets at least 44px high, body text at least 16px.
{{/mobile}}
{{#web}}
The project is a website or web app: include a desktop and a mobile layout note under Layout.
{{/web}}
