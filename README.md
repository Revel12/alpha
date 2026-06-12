# Alpha

Alpha is a local VS Code chat participant that mirrors the first slice of an OMP-style coding harness.

The important design constraint is that Alpha does not handle GitHub Copilot auth. Model-backed behavior goes through VS Code's chat participant request model, so VS Code and the installed GitHub Copilot extension remain responsible for auth, consent, policy, quota, and enterprise controls.

## MVP Tools

Use these from Copilot Chat with `@alpha`:

- `/read path` reads a workspace file and emits a hash anchor.
- `/read active` reads the active editor or selected text.
- `/search query` searches workspace text.
- `/find glob` finds workspace files.
- `/diff` shows git changed files and diff stats.
- `/edit` applies OMP-style hashline edits.
- `/write path` followed by file content writes a workspace file.
- `/resolve list`, `/resolve apply <id>`, `/resolve clear` manages queued edits.
- `/todo add item`, `/todo in_progress item`, `/todo completed item`, `/todo list` manages local todos.
- `/review text` sends review text to the selected VS Code/Copilot model.

## Hashline Edit Format

Run `/read path` first. It returns an anchor like:

```text
¶src/example.ts#abc123def456
```

Then send:

```text
/edit
¶src/example.ts#abc123def456
replace 10:12
+new line 1
+new line 2
```

By default, `edit` applies after validating the hash and range. Set `alpha.edit.defaultMode` to `preview` to queue edits and apply them later with `/resolve apply <id>` or the `Alpha: Apply Pending Edit` command.

## Development

```bash
npm install
npm run compile
```

Launch the extension with the `Run Alpha Extension` debug configuration.

## Intended Extension Points

- Replace the simple search implementation with ripgrep or VS Code text search APIs.
- Add LSP-backed `lsp` operations through VS Code language APIs.
- Add read-only internal Bitbucket tools.
- Add local `.alpha` persistence for todos, checkpoints, and memory if approved.
- Expose selected tools as VS Code language-model tools after the chat participant loop is stable.
