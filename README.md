# .ch domains

This project queries and tracks .ch domains. Updated daily using github action.

Stats: [./ch-summary.txt](./ch-summary.txt) \
Domains: [./ch/](./ch/)

## Dashboard

A static dashboard in [./site/](./site/) visualises daily registrations &
deregistrations with a draggable timeline. It reads precomputed JSON from
`site/data/` (no backend).

Per-day stats are derived from git history: because each daily snapshot is
sorted, `git diff <prevDay>..<day>` over `ch/` gives added lines
(registrations) and removed lines (deregistrations).

Build the stats:

```
node scripts/build-stats.mjs --all   # backfill entire history (full clone)
node scripts/build-stats.mjs         # incremental: only the newest day
```

The daily GitHub Action runs the incremental build after each update.

Serve locally:

```
npx serve site            # or: (cd site && python3 -m http.server)
```

## Run Manually 

```
./query.sh
```
