# Distribution & installation

**One** npm package and one git repo serve all four platforms. Each consumer reads its own
manifest surface out of the same package and ignores the rest, so the twelve skills exist once
and nothing can drift out of step.

## Packages

| package | read by | source |
|---|---|---|
| `explainer-video-from-coursework` | Claude Code, Codex, DeepSeek Harness | npm |
| `akshayDev17/ai-explainer-video` | Antigravity + the marketplace catalogue | git |

## Publish — a dispatch, not a commit

Commits to `main` do nothing. A release is a manual dispatch of the `release` workflow
(Actions → release → Run workflow), which computes the next version from the latest `v*` tag,
bumps every manifest **and both marketplace catalogue pins**, publishes straight to npm over
OIDC, and only then commits + tags. The click is the single gate and the release is live
immediately — there is no second approval step, deliberately (see
[`RELEASING.md`](./RELEASING.md#why-direct-not-staged)).

The publish is **confirmed against the registry, not assumed**: the workflow polls
`https://registry.npmjs.org/<package>/<version>` for up to 12 minutes, because npm answers 404
for a version it accepted seconds earlier — 7.5 minutes was measured. Nothing is committed or
tagged until it answers 200. If a run dies after publishing but before its bookkeeping,
re-dispatching the same version skips the publish and finishes the release.

The manual fallback still works — `npm publish --otp <2FA_OTP>` from the repo root — but it
bypasses the version computation, the catalogue pins and the tag, so treat it as break-glass.

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

All four surfaces resolve the same **twelve** skills: `explainer-video-from-coursework`, its
nine `craft-video-<stage>` siblings, the vendored `coursework-author`, and the in-progress
`explainer-video-from-codebase` (its tree-sitter runtime and grammars are vendored inside it,
so no host needs `npm install`) — all top-level under
`skills/` so a single-level scan finds every one.

Each catalogue pins the version a host installs from npm (`source: npm`, `version: ^x.y.z`).
That pin is written by `scripts/bump.mjs` during a release and checked in CI
(`scripts/check-marketplace-pins.mjs`), because a hand-maintained range rots without a symptom:
this one sat at `^0.1.0` while the package reached 0.4.0, so Claude, Codex and Gemini were
installing a six-release-old version with nine skills in it. The shelf repo
(`akshayDev17/my-skills-package`) carries the matching catalogue for `coursework-author`.

## Sources

- Claude Code marketplace reference — https://code.claude.com/docs/en/plugins/marketplace-reference
- Codex packaging — https://developers.openai.com/plugins/build/plugins
- Antigravity plugins — https://www.agy.dev/docs/plugins/
- DSH — `@deepseek-ai/dsh` README (`dsh plugin` forwards to pnpm);
  `@deepseek-ai/dsh-skill-filesystem` (`customSkillDirs`/`bundledSkillDir`);
  `@deepseek-ai/dsh-app-boot` `profile.d.ts` (`dsh.bundle.patch`).
