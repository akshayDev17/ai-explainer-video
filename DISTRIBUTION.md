# Distribution & installation

**One** npm package and one git repo serve all four platforms. Each consumer reads its own
manifest surface out of the same package and ignores the rest, so the nine skills exist once
and nothing can drift out of step.

## Packages

| package | read by | source |
|---|---|---|
| `explainer-video-from-coursework` | Claude Code, Codex, DeepSeek Harness | npm |
| `akshayDev17/ai-explainer-video` | Antigravity + the marketplace catalogue | git |

## Publish — a tag, not a command

Publishing runs in GitHub Actions on a version tag, over OIDC (no npm token) and **staged** —
a maintainer approves before anything becomes installable.
[`RELEASING.md`](./RELEASING.md) owns the one-time Trusted Publisher setup and the full flow.

```sh
git tag v0.1.3 && git push origin main --tags     # CI stages it; you approve on npmjs.com
```

The manual fallback still works — `npm publish --otp <2FA_OTP>` from the repo root — but it
carries no provenance attestation.

## Install — four one-liners

### Claude Code
```sh
claude plugin marketplace add akshayDev17/ai-explainer-video
claude plugin install explainer-video-from-coursework@akshaydev17
```

### Codex
```sh
codex plugin marketplace add akshayDev17/ai-explainer-video
codex plugin add explainer-video-from-coursework@akshaydev17
```

### DeepSeek Harness (DSH)
```sh
dsh plugin --profile web add explainer-video-from-coursework
```

### Antigravity
```sh
agy plugin install https://github.com/akshayDev17/ai-explainer-video
```

## How each platform reads the one package

| file / field | read by |
|---|---|
| `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` | Claude Code |
| `plugin.json` (root) + `.agents/plugins/marketplace.json` | Codex, Antigravity |
| `dsh.bundle.patch` → `cordis.patch.yml` → `lib/index.js` | DeepSeek Harness |

- **Claude Code** reads `.claude-plugin/marketplace.json` (catalogue) and
  `.claude-plugin/plugin.json` (manifest); each catalogue entry uses `source: npm`. Note npm
  works as a **plugin** source here but *not* as a **marketplace** source — Claude Code fails
  with `NPM marketplace sources not yet implemented` — so the catalogue itself must stay a
  git repo, which is what `.claude-plugin/marketplace.json` in this repo provides.
- **Codex** reads `.agents/plugins/marketplace.json` (canonical) or
  `.claude-plugin/marketplace.json` (legacy-compatible); same `source: npm` entries.
- **Antigravity** reads the root `plugin.json` (Agent Plugins schema) + `skills/` via
  `agy plugin install <git-url>`.
- **DSH** reads the same npm package: `dsh.bundle.patch` → `cordis.patch.yml` →
  `lib/index.js` mounts `@deepseek-ai/dsh-skill-filesystem` with a unique `providerName` and
  `customSkillDirs` at this package's own `skills/`. It declares **no** DeepSeek dependency:
  the harness supplies `dsh-skill-filesystem` through its own module fallback, verified end
  to end. That keeps the manifest Claude Code and Codex install free of it.

All four surfaces resolve the same **nine** skills: `explainer-video-from-coursework` plus
its eight `craft-video-<stage>` siblings, all top-level under `skills/` so a single-level
scan finds every one.

## Sources

- Claude Code marketplace reference — https://code.claude.com/docs/en/plugins/marketplace-reference
- Codex packaging — https://developers.openai.com/plugins/build/plugins
- Antigravity plugins — https://www.agy.dev/docs/plugins/
- DSH — `@deepseek-ai/dsh` README (`dsh plugin` forwards to pnpm);
  `@deepseek-ai/dsh-skill-filesystem` (`customSkillDirs`/`bundledSkillDir`);
  `@deepseek-ai/dsh-app-boot` `profile.d.ts` (`dsh.bundle.patch`).
