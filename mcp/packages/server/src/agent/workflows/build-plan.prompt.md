## Task: plan the app

You plan how to turn the open design into a working {{platform}} app in `app-src/`. You only plan
now: do not write files and do not change the design. The user confirms the plan before anything
is built.

Look at the design before you decide: the boards (screenshots of the main ones with
`capture_node_screenshot`), their structure and styles (`generate_code_hints`,
`get_node_properties`), the prototype navigation (`get_prototype_graph`) and the components and
colors that repeat across boards.

Choose the stack:
{{#web}}
- Default for web: React + Vite + TypeScript with npm, plain CSS modules, `react-router-dom`.
  Pick something else only when the design clearly needs it.
{{/web}}
{{#mobile}}
- Default for mobile: Expo (React Native + TypeScript) with `react-native-web`, so the app can be
  previewed in a browser; navigation with `expo-router` or React Navigation.
{{/mobile}}
- Commands are argument lists for npm, npx, pnpm, yarn or bun only, with no shell operators.
- `install` installs dependencies, `build` must fail on errors (include a type check when the
  stack has one, or give it as `typecheck`), `dev` starts a dev server on `127.0.0.1`. Penforge
  picks the port: it replaces the argument `{port}` and also sets the environment variable named
  by `portEnv` (default `PORT`). Vite ignores `PORT`, so pass `--port {port} --strictPort`.

Decide which top-level boards are screens (skip boards that only hold components, notes or
assets) and give each screen a route; the first screen of the main flow gets `/`.

{{#designer}}
The `summary` is for a designer: 3 to 6 short sentences in plain words about what the app will do
and how its screens connect ("Login leads to the Dashboard when you press Sign in"). No technical
terms, no stack names, no file names.
{{/designer}}
{{#developer}}
The `summary` is for a developer: 3 to 6 sentences on the architecture, stack, routing and how
screens and shared components map to the design.
{{/developer}}

End your reply with exactly one fenced ```json block in this shape:

```json
{
  "summary": "…",
  "stack": {
    "name": "React + Vite + TypeScript",
    "version": "react 19, vite 6",
    "packageManager": "npm",
    "commands": {
      "install": ["npm", "install"],
      "build": ["npm", "run", "build"],
      "dev": ["npm", "run", "dev", "--", "--port", "{port}", "--strictPort"]
    },
    "portEnv": "PORT"
  },
  "screens": [{ "boardId": "…", "name": "Login", "route": "/" }],
  "components": [{ "name": "PrimaryButton", "purpose": "Filled button used on Login and Dashboard" }],
  "tree": "app-src/\n  src/\n    screens/\n    components/",
  "notes": "Anything the build steps must know (fonts, assets, tricky layouts)."
}
```
