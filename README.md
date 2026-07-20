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

Posts matching the private exclusion list are removed before ranking, allowing the next-highest-scoring eligible post to take their place.

## One-time GitHub setup

1. Create a GitHub repository and push the tracked files in this directory.
2. In **Settings > Pages**, select **GitHub Actions** as the source.
3. In **Settings > Secrets and variables > Actions**, optionally add:
   - `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` for authenticated Reddit access. Without them, public Reddit endpoints are used.
   - `EXCLUDED_POST_TEXT` with one private exclusion phrase per line. Comma-separated phrases are also supported.
   - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` only if Telegram delivery should continue.
   - A repository variable named `BLUESKY_HANDLE` to override the default account.
4. Run **Publish daily PS jailbreak digest** manually once to verify the page.

Do not commit credentials. If a credential has previously appeared in a tracked or shared file, rotate it before adding the replacement as a GitHub Actions secret.
