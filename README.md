# starfall

**Live**: [hamza-ali-shahjahan.github.io/starfall](https://hamza-ali-shahjahan.github.io/starfall/)

The GitHub night sky. Every repo is a star: size is stars gained, color is
language, constellations are topics forming in real time. Live star events
streak across the sky and flare their target. Search any repo to drop it into
the sky and crawl its full star history.

No backend. Your browser talks to GitHub (and the public GH Archive mirror)
directly.

## Views

- **Top today** — exact stars gained since 00:00 UTC, computed from stargazer
  timestamps (batched GraphQL), not sampled feeds
- **Session** — star events witnessed live while the sky is open, with
  DEBUT / ON A ROLL / ENCORE tiers
- **Rising** — repos born in the last 7/30/90 days (or since any date),
  ranked by stars
- **All-time** — the most-starred repositories ever

All views filter by language. Click any star (or leaderboard row) for the
detail panel: description, topics, star-history chart, and a track button.
Your own repos form a permanent golden constellation, with your most recent
stargazers listed below it.

## Star history

- Small repos: exact curve from a GraphQL walk over stargazer timestamps
- Large repos: monthly curve from the public ClickHouse GH Archive mirror,
  anchored to the live total (approximate; renamed repos are flagged partial)

## Setup

```bash
npm install
npm run dev    # http://localhost:5173
```

Click **⚙** and paste a GitHub fine-grained personal access token with
**Public repositories (read-only)** access. It is stored only in your
browser's localStorage and sent only to api.github.com. Without a token the
app runs degraded (slow polling, no exact daily counts).

`npm run build` produces a static `dist/` deployable anywhere.

## License

[MIT](LICENSE)

## Credits

- Historical star data from [GH Archive](https://www.gharchive.org/) via the
  public [ClickHouse playground](https://play.clickhouse.com/).
- Trending candidates partly from the [OSS Insight public API](https://ossinsight.io/).
- Original inspiration: [graykode/starquake](https://github.com/graykode/starquake).
