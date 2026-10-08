# explainer-video-from-coursework-dsh

DSH bundle plugin that ships the `explainer-video-from-coursework` skill.

```sh
dsh plugin --profile web add explainer-video-from-coursework-dsh
```

The skill is bundled at `skills/explainer-video-from-coursework/` — a copy of the
repo's `skills/explainer-video-from-coursework/`. Re-sync it before publishing:

```sh
rm -rf skills && cp -R ../skills ./
```
