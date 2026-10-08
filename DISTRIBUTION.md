# Distribution & installation

One repo → one Agent Plugins plugin + one DSH bundle wrapper. Two npm packages, one git repo.

## Packages

| Package | Consumers | Source |
|---|---|---|
| `explainer-video-from-coursework` | Claude Code, Codex | npm — repo root |
| `explainer-video-from-coursework-dsh` | DeepSeek Harness (DSH) | npm — `dsh/` |
| `akshayDev17/ai-explainer-video` | Antigravity (git) + the marketplace catalog | git |

## Publish (run these yourself)

```sh
cd <repo>
npm publish --otp <2FA_OTP>     # main plugin (Claude Code + Codex)

cd dsh
npm publish --otp <2FA_OTP>     # DSH wrapper
```

If the npm cache is root-owned and `EPERM` hits, retry each with a local cache:
`mkdir -p .npm-cache && npm publish --otp <2FA_OTP> --cache ./.npm-cache`

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
  and `customSkillDirs` pointing at the bundled `skills/`. Verified end-to-end against the
  local DSH checkout (`explainer-video-from-coursework` shows up in `ctx.skills.list()`).

## Sources

- Claude Code marketplace reference — https://code.claude.com/docs/en/plugins/marketplace-reference
- Codex packaging — https://developers.openai.com/plugins/build/plugins
- Antigravity plugins — https://www.agy.dev/docs/plugins/
- DSH — `@deepseek-ai/dsh` README (`dsh plugin` forwards to pnpm);
  `@deepseek-ai/dsh-skill-filesystem` (`customSkillDirs`/`bundledSkillDir`);
  `@deepseek-ai/dsh-app-boot` `profile.d.ts` (`dsh.bundle.patch`).
