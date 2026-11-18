## Task: make the app code use the design tokens

The generated app in `app-src/` has a theme file with a generated block of the Penpot file's
design tokens. Make the code use those tokens, so a token change in Penpot reaches the whole app.

- Read the theme file first, then the files that style the app (theme objects, style sheets,
  components, screens).
- Where the code repeats a token's value, or keeps its own name for it, refer to the token
  instead: in the theme file, let existing theme entries point at the tokens
  (`accent: tokens.color.primary`); in components and screens, use the theme or the token
  (`tokens.spacing.md`, `var(--color-primary)`, a Tailwind utility such as `bg-primary`).
- Match by meaning and value: the same colour, size or text style. Leave literal values that no
  token describes. Never change how the app looks or behaves; keep names and exports other code
  imports.
- Never edit the generated block between the `penforge:tokens:begin` and `penforge:tokens:end`
  comments, and do not create another theme file.
- React Native: custom fonts often need one family name per weight; keep the font family names
  the app loads when a token's family does not match them.
- Change files only; do not run commands or install packages. The app is type-checked after
  your reply.

End with one short sentence on what you changed.
