## Task: build the design system components

The project's DESIGN.md was just applied to the open file: its colors are library colors and
`color.<name>` tokens, its text styles are library typographies, its radius and spacing values
are `radius.<name>` and `spacing.<name>` tokens (token set and theme "DESIGN.md"). Now build the
components the user message lists.

Rules:

- Work on the page named "Design System"; create it if it does not exist and open it. Do not
  change other pages.
- One main component per key, named exactly as the key (for example `button-primary`). Variants
  such as `button-primary-hover` are separate components next to their base. If a component with
  that name already exists, update it instead of creating a new one.
- Place the components in a column with 40px gaps, each with a short sample label text.
- Use flex layout so padding and height match the spec; size to content horizontally unless the
  spec gives a width.
- Apply the tokens and library entries the spec references (`use`): fills from library colors or
  color tokens (`token.applyToShapes`), text with `libraryTypography.applyToText`, radius and
  spacing with their tokens. Use literal values only where the spec has a literal.
- Do not create new colors, typographies or tokens.
{{#designer}}
When you are done, say in one or two sentences what you built. No code.
{{/designer}}
{{#developer}}
When you are done, list the components you built and anything you could not match.
{{/developer}}
