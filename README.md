# Alpha

Alpha is a local VS Code chat participant that mirrors the first slice of an OMP-style coding harness.

The important design constraint is that Alpha does not handle GitHub Copilot auth. Model-backed behavior goes through VS Code's chat participant request model, so VS Code and the installed GitHub Copilot extension remain responsible for auth, consent, policy, quota, and enterprise controls.

## MVP Tools

Use these from Copilot Chat with `@alpha`:

Alpha passes a private OMP-style tool set to the selected VS Code/Copilot model. Inside the `@alpha` participant, the model sees only these Alpha tools unless this extension explicitly adds more:

- `read` reads a workspace file and emits a hash anchor.
- `search` searches workspace text.
- `find` finds workspace files by glob.
- `diff` shows git changed files and diff stats.
- `edit` applies OMP-style hashline edits.
- `write` writes a workspace file.
- `resolve` lists, applies, or clears queued edits.
- `todo` manages local todos.

## Hashline Edit Format

Ask Alpha to read a file first. It returns an anchor like:

```text
¶src/example.ts#abc123def456
```

Then ask Alpha to apply this hashline patch:

```text
¶src/example.ts#abc123def456
replace 10:12
+new line 1
+new line 2
```

By default, `edit` applies after validating the hash and range. Set `alpha.edit.defaultMode` to `preview` to queue edits and apply them later with `resolve` or the `Alpha: Apply Pending Edit` command.

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
- Add more OMP-style tools: LSP, checkpoint/rewind, browser, Bitbucket, AST search/edit, and memory.
