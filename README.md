# PS Jailbreak Daily Digest

This repository generates a daily digest from:

- r/ps4homebrew
- r/ps5homebrew
- r/PS5_Jailbreak
- r/PS4Hacks2
- r/PS4Jailbreak
- r/PS4Mods
- The `crump-youtube.bsky.social` Bluesky follow feed, with jailbreak/homebrew search fallback

GitHub Actions makes three staggered attempts each day and publishes `docs/` through GitHub Pages. Each network source retries independently. A partial digest is still published when individual sources fail, and Telegram delivery is optional. Later attempts can replace a partial morning digest if a source recovers.

Each edition is retained at `docs/archive/YYYY-MM-DD.html`. The generator also rebuilds `docs/archive/index.html`, which lists every available edition newest-first and is linked from the current digest. Repeated runs on the same Pacific date update that day's edition instead of creating duplicates.
