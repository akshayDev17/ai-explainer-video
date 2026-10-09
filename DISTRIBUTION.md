# Distribution & installation

One repo → one Agent Plugins plugin + one DSH bundle wrapper. Two npm packages, one git
repo. The wrapper carries **no skill files**: it depends on the main package and serves
*its* installed `skills/`, so the two cannot drift.

## Packages

| Package | Consumers | Source |
|---|---|---|
| `explainer-video-from-coursework` | Claude Code, Codex | npm — repo root |
| `explainer-video-from-coursework-dsh` | DeepSeek Harness (DSH) | npm — `dsh/` |
| `akshayDev17/ai-explainer-video` | Antigravity (git) + the marketplace catalog | git |

## Publish — a tag, not a command

Publishing runs in GitHub Actions on a version tag, over OIDC (no npm token):
[`.github/workflows/release.yml`](./.github/workflows/release.yml) publishes both packages,
root first. Setup and the full procedure live in [`RELEASING.md`](./RELEASING.md).

```sh
git tag v0.1.3 && git push origin main --tags
```

The manual fallback still works — `npm publish --otp <2FA_OTP>` from the repo root, then
again in `dsh/` — but it carries no provenance attestation.

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
dsh plugin --profile web add explainer-video-from-coursework-dsh
```

### Antigravity
```sh
agy plugin install https://github.com/akshayDev17/ai-explainer-video
```

## How each platform reads this repo

- **Claude Code** reads `.claude-plugin/marketplace.json` (catalog) and
  `.claude-plugin/plugin.json` (manifest); each catalog entry uses `source: npm`.
- **Codex** reads `.agents/plugins/marketplace.json` (canonical) or
  `.claude-plugin/marketplace.json` (legacy-compatible); same `source: npm` entries.
- **Antigravity** reads the root `plugin.json` (Agent Plugins schema) + `skills/` via
  `agy plugin install <git-url>`.
- **DSH** reads the `dsh/` npm package: `dsh.bundle.patch` → `cordis.patch.yml` →
  `lib/index.js` mounts `@deepseek-ai/dsh-skill-filesystem` with a unique `providerName`
  and `customSkillDirs` pointing at the **installed main package's** `skills/` — resolved
  with `require.resolve`, never bundled.

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
