# tidebound-bugs

Auto-collected bug reports for the **Tidebound** Unity game. Each report arrives as a GitHub issue
plus the player's real `save.json` (committed under `assets/<date>/<uuid>/`) and a `meta` block
(platform, app version, device, recent error logs). The game source itself is in the private repo
`Shaler404/tidebound`.

## Flow

```
Unity (in-game "Сообщить о баге" button) --multipart POST--> Cloudflare Worker
  --GitHub REST API--> this repo: commit save.json + open issue (label: bug-report)
  --owner manually adds the `triage` label--> GitHub Action runs claude-code-action
  --checks out ./game (private source), analyses save + description + meta + comments--> comments in Russian
```

## Triggering triage

Reports arrive labelled **`bug-report`** (this label does **not** run Claude). To get an analysis,
**add the `triage` label** to the issue — that, and only that, runs the
`claude-bug-triage` workflow, which checks out the private game source and posts a Russian analysis
comment. Re-add the label to re-run.
