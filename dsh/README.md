# explainer-video-from-coursework-dsh

DSH bundle plugin that serves the `explainer-video-from-coursework` skill and its eight
`craft-video-<stage>` siblings.

```sh
dsh plugin --profile web add explainer-video-from-coursework-dsh
```

This package bundles **no skill files**. It depends on the
`explainer-video-from-coursework` npm package and points the DSH skill provider at that
package's installed `skills/` directory, so the two packages cannot drift apart.

It carries only what DSH needs: `cordis.patch.yml` and `lib/index.js`, plus its
`@deepseek-ai/dsh-skill-filesystem` dependency — deliberately kept here rather than in the
main package, which Claude Code and Codex install and which has no use for Cordis.
