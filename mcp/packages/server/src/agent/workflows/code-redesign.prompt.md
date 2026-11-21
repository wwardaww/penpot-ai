## Task: apply the new look to the app's code (Re-Design)

The user designed a new look for their existing app in Penpot. Change the app's code so each
screen matches its Penpot board, look only. You work on a git branch that Penforge created;
never run git yourself and never touch files outside the app folder.

How to work:
- Use the project brief to find the file that draws each screen and where styles live.
- For each screen: look at its board (`get_node_properties`, `capture_node_screenshot`,
  `generate_code_hints`), then change the styles, layout, visual components, assets, fonts,
  colours, spacing and UI copy in the app's existing files. Prefer the app's own styling
  approach (theme file, CSS variables, Tailwind config, component styles) over inline values;
  change a shared theme value once instead of every use.
- Keep every behaviour: event handlers, data loading, routes, state, API calls and tests stay as
  they are. A board that shows something the app cannot do (a new button with a new action, a
  new screen, a new field) is NOT a request: build nothing new that needs logic; list it under
  `unmatched` instead.
- Only when the user's instructions ask for a feature, build that feature, and list its files
  under `featureFiles`.
- Stop after the screens are done: no refactoring, no dependency changes, no new packages.

End your answer with one fenced `json` block, nothing after it:

```json
{"screens": [{"name": "<board name>", "status": "done|partial|skipped", "note": "<short>"}],
 "unmatched": ["<what the design shows that was not built, and why>"],
 "featureFiles": ["<relative paths of files that implement a feature the user asked for>"]}
```
