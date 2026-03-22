# How to Scan and Convert Claude Code Resources

A guide for using the `acplugin` CLI to scan a project for Claude Code resources and convert them to other platform formats. The source argument is positional and auto-detects GitHub repos vs local paths.

1. **Build the project:** Run `npm run build` to compile TypeScript to `dist/`.

2. **Scan a local project:** Run `acplugin scan .` or `acplugin scan /path/to/project` to list all discoverable resources. This is read-only and produces no output files.

3. **Scan a GitHub repo:** Run `acplugin scan owner/repo` to download and scan a GitHub repository without cloning. Also supports `github:owner/repo#branch` and full GitHub URLs. Use `-p <subpath>` for monorepos.

4. **Convert to specific platforms:** Run `acplugin convert . --to codex,opencode,cursor` to generate output for specified platforms. When `--to` is omitted, an interactive checkbox lets you choose platforms.

5. **Convert a marketplace repo:** Run `acplugin convert owner/repo` on a repo with `.claude-plugin/marketplace.json`. An interactive TUI lets you select which plugins to convert. Use `--all` (`-a`) to skip selection.

6. **Preview without writing:** Add `--dry-run` to see what files would be generated without writing anything to disk.

7. **Custom output directory:** Use `-o <output-dir>` to write generated files to a different location. For GitHub sources, output defaults to the current directory instead of the temp download path.
