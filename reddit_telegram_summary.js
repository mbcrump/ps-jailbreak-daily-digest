const fs = require("node:fs/promises");
const path = require("node:path");

const SUBREDDITS = [
  "ps4homebrew",
  "ps5homebrew",
  "PS5_Jailbreak",
  "PS4Hacks2",
  "PS4Jailbreak",
  "PS4Mods",
];

const BLUESKY_QUERIES = [
  "playstation jailbreak",
  "ps5 jailbreak",
  "ps4 jailbreak",
  "ps5 homebrew",
  "ps4 homebrew",
];

const EXCLUDED_POST_TEXT = String(process.env.EXCLUDED_POST_TEXT || "")
  .split(/[\r\n,]+/)
  .map((text) => text.trim().toLocaleLowerCase("en-US"))
  .filter(Boolean);

const OUTPUT_DIR = path.resolve(process.env.DIGEST_OUTPUT_DIR || "docs");
const BLUESKY_HANDLE = process.env.BLUESKY_HANDLE || "crump-youtube.bsky.social";
const BLUESKY_FOLLOW_LIMIT = Number(process.env.BLUESKY_FOLLOW_LIMIT || 50);
const BLUESKY_POSTS_PER_FOLLOW = Number(process.env.BLUESKY_POSTS_PER_FOLLOW || 5);
const USER_AGENT = "PSJailbreakDailyDigest/2.0";
const DAY_MS = 24 * 60 * 60 * 1000;
const SITE_NAME = "PS Jailbreak Daily Digest";
const SITE_DESCRIPTION =
  "A daily roundup of PlayStation jailbreak and homebrew news from Reddit and Bluesky.";
const SITE_URL = `${String(
  process.env.DIGEST_SITE_URL || "https://mbcrump.github.io/ps-jailbreak-daily-digest/"
).replace(/\/+$/, "")}/`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatPacific(date) {
  return date.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}

function dateKeyPacific(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function shortError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 220);
}

function isExcludedPost(post) {
  const text = String(post?.title || "").toLocaleLowerCase("en-US");
  return EXCLUDED_POST_TEXT.some((excludedText) => text.includes(excludedText));
}

async function fetchWithRetry(url, options = {}, label = "request") {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(25_000),
      });
      if (response.ok) return response;

      const body = (await response.text()).replace(/\s+/g, " ").slice(0, 180);
      const contentType = response.headers.get("content-type") || "";
      const detail = contentType.includes("text/html") ? "" : body;
      const error = new Error(`HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
      if (response.status < 500 && response.status !== 429) {
        throw Object.assign(error, { retryable: false });
      }
      lastError = error;
    } catch (error) {
      if (error.retryable === false) throw new Error(`${label}: ${shortError(error)}`);
      lastError = error;
    }

    if (attempt < 4) await sleep(750 * 2 ** (attempt - 1));
  }
  throw new Error(`${label}: ${shortError(lastError)}`);
}

async function getRedditAccessToken() {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return "";

  const response = await fetchWithRetry(
    "https://www.reddit.com/api/v1/access_token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    },
    "Reddit token"
  );
  return String((await response.json()).access_token || "");
}

async function fetchReddit(now) {
  const posts = [];
  const sources = [];
  let token = "";
  let tokenError = "";

  try {
    token = await getRedditAccessToken();
  } catch (error) {
    tokenError = shortError(error);
  }

  for (const subreddit of SUBREDDITS) {
    try {
      const endpoint = token
        ? `https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/top?t=day&limit=15&raw_json=1`
        : `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/top.json?t=day&limit=15&raw_json=1`;
      const headers = {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      };
      if (token) headers.Authorization = `bearer ${token}`;

      const response = await fetchWithRetry(endpoint, { headers }, `Reddit r/${subreddit}`);
      const json = await response.json();
      let count = 0;
      for (const child of json.data?.children || []) {
        const item = child.data || {};
        const createdAt = Number(item.created_utc || 0) * 1000;
        if (!createdAt || now.getTime() - createdAt > DAY_MS) continue;
        const post = {
          platform: "Reddit",
          community: subreddit,
          title: String(item.title || "(untitled post)"),
          score: Number(item.score || 0),
          url: `https://www.reddit.com${item.permalink}`,
          createdAt: new Date(createdAt).toISOString(),
        };
        if (isExcludedPost(post)) continue;
        posts.push(post);
        count += 1;
      }
      sources.push({ name: `r/${subreddit}`, ok: true, count });
    } catch (error) {
      sources.push({ name: `r/${subreddit}`, ok: false, count: 0, error: shortError(error) });
    }
  }

  if (tokenError) {
    sources.push({
      name: "Reddit OAuth",
      ok: false,
      count: 0,
      error: `${tokenError}; public endpoints were used`,
    });
  }

  posts.sort((a, b) => b.score - a.score);
  return { posts, sources };
}

function blueskyPost(item, source) {
  const post = item.post || item;
  const record = post.record || {};
  const handle = String(post.author?.handle || "");
  const did = String(post.author?.did || "");
  const rkey = String(post.uri || "").split("/").pop() || "";
  const url =
    handle && rkey
      ? `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${rkey}`
      : `https://bsky.app/profile/${encodeURIComponent(handle || did)}`;
  return {
    platform: "Bluesky",
    community: source,
    title: String(record.text || "(untitled post)"),
    score:
      Number(post.likeCount || 0) +
      Number(post.repostCount || 0) * 2 +
      Number(post.replyCount || 0),
    url,
    createdAt: new Date(post.indexedAt || record.createdAt || 0).toISOString(),
    key: `${post.uri || ""}:${post.cid || ""}`,
  };
}

async function fetchBluesky(now) {
  const posts = [];
  const sources = [];
  const seen = new Set();
  const api = "https://public.api.bsky.app/xrpc";
  const addRecent = (post) => {
    const createdAt = new Date(post.createdAt).getTime();
    if (!createdAt || now.getTime() - createdAt > DAY_MS || seen.has(post.key) || isExcludedPost(post)) return;
    seen.add(post.key);
    posts.push(post);
  };

  let follows = [];
  try {
    const url = new URL(`${api}/app.bsky.graph.getFollows`);
    url.searchParams.set("actor", BLUESKY_HANDLE);
    url.searchParams.set("limit", String(Math.min(100, BLUESKY_FOLLOW_LIMIT)));
    const response = await fetchWithRetry(url, { headers: { "User-Agent": USER_AGENT } }, "Bluesky follows");
    follows = (await response.json()).follows || [];
    sources.push({ name: `Bluesky follows (${BLUESKY_HANDLE})`, ok: true, count: follows.length });
  } catch (error) {
    sources.push({
      name: `Bluesky follows (${BLUESKY_HANDLE})`,
      ok: false,
      count: 0,
      error: shortError(error),
    });
  }

  for (const follow of follows.slice(0, BLUESKY_FOLLOW_LIMIT)) {
    const actor = String(follow.handle || follow.did || "");
    const label = String(follow.displayName || follow.handle || follow.did || "");
    try {
      const url = new URL(`${api}/app.bsky.feed.getAuthorFeed`);
      url.searchParams.set("actor", actor);
      url.searchParams.set("limit", String(BLUESKY_POSTS_PER_FOLLOW));
      const response = await fetchWithRetry(url, { headers: { "User-Agent": USER_AGENT } }, `Bluesky ${label}`);
      for (const item of (await response.json()).feed || []) {
        addRecent(blueskyPost(item, `following:${label}`));
      }
    } catch (error) {
      sources.push({ name: `Bluesky ${label}`, ok: false, count: 0, error: shortError(error) });
    }
  }

  if (posts.length === 0) {
    for (const query of BLUESKY_QUERIES) {
      try {
        const url = new URL(`${api}/app.bsky.feed.searchPosts`);
        url.searchParams.set("q", query);
        url.searchParams.set("limit", "25");
        url.searchParams.set("sort", "latest");
        const response = await fetchWithRetry(
          url,
          { headers: { "User-Agent": USER_AGENT } },
          `Bluesky search "${query}"`
        );
        let count = 0;
        for (const item of (await response.json()).posts || []) {
          const before = posts.length;
          addRecent(blueskyPost(item, `search:${query}`));
          if (posts.length > before) count += 1;
        }
        sources.push({ name: `Bluesky search: ${query}`, ok: true, count });
      } catch (error) {
        sources.push({
          name: `Bluesky search: ${query}`,
          ok: false,
          count: 0,
          error: shortError(error),
        });
      }
    }
  }

  posts.sort((a, b) => b.score - a.score);
  return { posts, sources };
}

function buildDigest(now, reddit, bluesky) {
  const start = new Date(now.getTime() - DAY_MS);
  const topOverall = reddit.posts[0] || null;
  const topByCommunity = Object.fromEntries(
    SUBREDDITS.map((subreddit) => [
      subreddit,
      reddit.posts.find((post) => post.community === subreddit) || null,
    ])
  );
  const failures = [...reddit.sources, ...bluesky.sources].filter((source) => !source.ok);
  return {
    generatedAt: now.toISOString(),
    runTimePacific: formatPacific(now),
    windowStartPacific: formatPacific(start),
    windowEndPacific: formatPacific(now),
    status: reddit.posts.length || bluesky.posts.length ? (failures.length ? "partial" : "complete") : "unavailable",
    reddit: {
      posts: reddit.posts,
      topOverall,
      topByCommunity,
      sources: reddit.sources,
    },
    bluesky: {
      posts: bluesky.posts,
      topOverall: bluesky.posts[0] || null,
      sources: bluesky.sources,
    },
    failures,
  };
}

function postLink(post, detail = "") {
  if (!post) return "<span class=\"empty\">No qualifying posts found</span>";
  return `<a href="${escapeHtml(post.url)}">${escapeHtml(post.title)}</a>${detail}`;
}

function formatArchiveDate(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function renderPage(digest, { archived = false } = {}) {
  const dateKey = dateKeyPacific(new Date(digest.generatedAt));
  const pageTitle = archived ? `${formatArchiveDate(dateKey)} | ${SITE_NAME}` : SITE_NAME;
  const canonicalUrl = archived ? `${SITE_URL}archive/${dateKey}.html` : SITE_URL;
  const articleMetadata = archived
    ? `  <meta property="article:published_time" content="${escapeHtml(digest.generatedAt)}">\n`
    : "";
  const communityItems = SUBREDDITS.map((subreddit) => {
    const post = digest.reddit.topByCommunity[subreddit];
    const detail = post ? ` <span>score ${post.score}</span>` : "";
    return `<li><strong>r/${escapeHtml(subreddit)}</strong>${postLink(post, detail)}</li>`;
  }).join("");

  const notableReddit = digest.reddit.posts
    .slice(0, 8)
    .map((post) => {
      const label = post.community.toLowerCase().includes("ps5") ? "PS5" : "PS4";
      return `<li><span class="tag">${label}</span>${postLink(
        post,
        ` <span>r/${escapeHtml(post.community)} · score ${post.score}</span>`
      )}</li>`;
    })
    .join("");

  const blueskyItems = digest.bluesky.posts
    .slice(0, 8)
    .map((post) => `<li>${postLink(post, ` <span>score ${post.score} · ${escapeHtml(post.community)}</span>`)}</li>`)
    .join("");

  const failedSources = digest.failures.length
    ? `<details><summary>${digest.failures.length} source warning(s)</summary><ul>${digest.failures
        .map((source) => `<li><strong>${escapeHtml(source.name)}</strong>: ${escapeHtml(source.error)}</li>`)
        .join("")}</ul></details>`
    : "";

  const archiveHref = archived ? "index.html" : "archive/";
  const homeLink = archived ? '<a href="../">Latest digest</a><span aria-hidden="true">/</span>' : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#f4f0e5">
  <meta name="description" content="${escapeHtml(SITE_DESCRIPTION)}">
  <meta name="application-name" content="${escapeHtml(SITE_NAME)}">
  <meta name="robots" content="index,follow">
  <meta property="og:type" content="${archived ? "article" : "website"}">
  <meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="${escapeHtml(SITE_DESCRIPTION)}">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:locale" content="en_US">
${articleMetadata}  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escapeHtml(pageTitle)}">
  <meta name="twitter:description" content="${escapeHtml(SITE_DESCRIPTION)}">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <title>${escapeHtml(pageTitle)}</title>
  <style>
    :root { --ink:#10231d; --paper:#f4f0e5; --card:#fffdf7; --red:#d3422f; --green:#1d5a45; --muted:#64736d; }
    * { box-sizing:border-box; }
    body { margin:0; color:var(--ink); background:radial-gradient(circle at 90% 0,#e7c96555,transparent 28rem),var(--paper); font:16px/1.55 Georgia,serif; }
    header,main,footer { width:min(980px,calc(100% - 32px)); margin:auto; }
    header { padding:64px 0 30px; border-bottom:3px solid var(--ink); }
    nav { display:flex; gap:10px; align-items:center; margin-bottom:28px; font:700 13px ui-monospace,monospace; text-transform:uppercase; }
    .eyebrow,.tag { font:700 12px/1.2 ui-monospace,monospace; letter-spacing:.1em; text-transform:uppercase; color:var(--red); }
    h1 { max-width:760px; margin:.25rem 0 .75rem; font-size:clamp(2.5rem,8vw,5.5rem); line-height:.92; letter-spacing:-.055em; }
    .meta { color:var(--muted); }
    .status { display:inline-block; margin-top:14px; padding:5px 10px; border:1px solid currentColor; color:var(--green); font:700 12px ui-monospace,monospace; text-transform:uppercase; }
    main { display:grid; grid-template-columns:1fr 1fr; gap:20px; padding:28px 0 52px; }
    section,details { padding:24px; background:color-mix(in srgb,var(--card) 92%,transparent); border:1px solid #10231d24; box-shadow:0 14px 35px #28483a12; }
    section:first-child,details { grid-column:1/-1; }
    h2 { margin:0 0 14px; font-size:1.6rem; }
    ul { list-style:none; margin:0; padding:0; }
    li { padding:12px 0; border-top:1px solid #10231d1c; }
    li:first-child { border-top:0; }
    li strong { display:block; font:700 12px ui-monospace,monospace; color:var(--green); }
    a { color:var(--ink); text-decoration-thickness:1px; text-underline-offset:3px; }
    a:hover { color:var(--red); }
    li span:not(.tag),.empty { display:block; color:var(--muted); font-size:.85rem; }
    .tag { display:inline-block; margin-right:8px; }
    details { color:var(--muted); }
    summary { cursor:pointer; font-weight:bold; color:var(--ink); }
    footer { padding:0 0 40px; color:var(--muted); font-size:.85rem; }
    @media (max-width:700px) { header { padding-top:40px; } main { grid-template-columns:1fr; } section { grid-column:1; } }
  </style>
</head>
<body>
  <header>
    <nav aria-label="Digest navigation">${homeLink}<a href="${archiveHref}">Browse archive</a></nav>
    <div class="eyebrow">Independent daily monitor</div>
    <h1>PS Jailbreak Daily Digest</h1>
    <div class="meta">Run: ${escapeHtml(digest.runTimePacific)}<br>Window: ${escapeHtml(
      digest.windowStartPacific
    )} to ${escapeHtml(digest.windowEndPacific)}</div>
    <div class="status">${escapeHtml(digest.status)}</div>
  </header>
  <main>
    <section>
      <div class="eyebrow">Top overall Reddit post</div>
      <h2>${postLink(
        digest.reddit.topOverall,
        digest.reddit.topOverall
          ? ` <span>r/${escapeHtml(digest.reddit.topOverall.community)} · score ${digest.reddit.topOverall.score}</span>`
          : ""
      )}</h2>
    </section>
    <section><h2>Top by community</h2><ul>${communityItems}</ul></section>
    <section><h2>Notable PS5 / PS4</h2><ul>${notableReddit || "<li class=\"empty\">No qualifying Reddit posts found</li>"}</ul></section>
    <section><h2>Bluesky</h2><ul>${blueskyItems || "<li class=\"empty\">No qualifying Bluesky posts found</li>"}</ul></section>
    ${failedSources}
  </main>
  <footer>Generated automatically from Reddit and the ${escapeHtml(BLUESKY_HANDLE)} Bluesky follow feed/search.</footer>
</body>
</html>`;
}

function renderArchiveIndex(dateKeys) {
  const pageTitle = `Archive | ${SITE_NAME}`;
  const canonicalUrl = `${SITE_URL}archive/`;
  const items = dateKeys
    .map(
      (dateKey) =>
        `<li><a href="${dateKey}.html"><time datetime="${dateKey}">${escapeHtml(
          formatArchiveDate(dateKey)
        )}</time></a></li>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#f4f0e5">
  <meta name="description" content="Browse past editions of the ${escapeHtml(SITE_NAME)}.">
  <meta name="application-name" content="${escapeHtml(SITE_NAME)}">
  <meta name="robots" content="index,follow">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="Browse past editions of the ${escapeHtml(SITE_NAME)}.">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:locale" content="en_US">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escapeHtml(pageTitle)}">
  <meta name="twitter:description" content="Browse past editions of the ${escapeHtml(SITE_NAME)}.">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <title>${escapeHtml(pageTitle)}</title>
  <style>
    :root { --ink:#10231d; --paper:#f4f0e5; --card:#fffdf7; --red:#d3422f; --green:#1d5a45; --muted:#64736d; }
    * { box-sizing:border-box; }
    body { margin:0; color:var(--ink); background:radial-gradient(circle at 90% 0,#e7c96555,transparent 28rem),var(--paper); font:16px/1.55 Georgia,serif; }
    header,main,footer { width:min(760px,calc(100% - 32px)); margin:auto; }
    header { padding:64px 0 30px; border-bottom:3px solid var(--ink); }
    nav { margin-bottom:28px; font:700 13px ui-monospace,monospace; text-transform:uppercase; }
    .eyebrow { font:700 12px/1.2 ui-monospace,monospace; letter-spacing:.1em; text-transform:uppercase; color:var(--red); }
    h1 { margin:.25rem 0 .75rem; font-size:clamp(2.5rem,8vw,5rem); line-height:.92; letter-spacing:-.055em; }
    p { color:var(--muted); }
    main { padding:28px 0 52px; }
    ul { list-style:none; margin:0; padding:0; background:color-mix(in srgb,var(--card) 92%,transparent); border:1px solid #10231d24; box-shadow:0 14px 35px #28483a12; }
    li { border-top:1px solid #10231d1c; }
    li:first-child { border-top:0; }
    li a { display:block; padding:18px 22px; }
    a { color:var(--ink); text-decoration-thickness:1px; text-underline-offset:3px; }
    a:hover { color:var(--red); }
    footer { padding:0 0 40px; color:var(--muted); font-size:.85rem; }
    @media (max-width:700px) { header { padding-top:40px; } }
  </style>
</head>
<body>
  <header>
    <nav aria-label="Digest navigation"><a href="../">Latest digest</a></nav>
    <div class="eyebrow">Past editions</div>
    <h1>Digest archive</h1>
    <p>${dateKeys.length} daily ${dateKeys.length === 1 ? "digest" : "digests"}, newest first.</p>
  </header>
  <main>
    <ul>${items || '<li><span>No archived digests yet.</span></li>'}</ul>
  </main>
  <footer>PS Jailbreak Daily Digest</footer>
</body>
</html>`;
}

function renderTelegram(digest) {
  const lines = [
    "<b>PS jailbreak daily digest</b>",
    `Run time: ${escapeHtml(digest.runTimePacific)}`,
    `Window: ${escapeHtml(digest.windowStartPacific)} to ${escapeHtml(digest.windowEndPacific)}`,
    "",
    "<b>Top overall Reddit</b>",
  ];

  const top = digest.reddit.topOverall;
  lines.push(
    top
      ? `- <a href="${escapeHtml(top.url)}">${escapeHtml(top.title)}</a> (r/${escapeHtml(top.community)}, score ${top.score})`
      : "- No qualifying posts found"
  );
  lines.push("", "<b>Top by community</b>");
  for (const subreddit of SUBREDDITS) {
    const post = digest.reddit.topByCommunity[subreddit];
    lines.push(
      post
        ? `- r/${escapeHtml(subreddit)}: <a href="${escapeHtml(post.url)}">${escapeHtml(post.title)}</a> (score ${post.score})`
        : `- r/${escapeHtml(subreddit)}: no qualifying posts found`
    );
  }
  lines.push("", "<b>Notable PS5 / PS4</b>");
  for (const post of digest.reddit.posts.slice(0, 6)) {
    const label = post.community.toLowerCase().includes("ps5") ? "PS5" : "PS4";
    lines.push(
      `- ${label}: <a href="${escapeHtml(post.url)}">${escapeHtml(post.title)}</a> (r/${escapeHtml(post.community)}, score ${post.score})`
    );
  }
  lines.push("", "<b>Bluesky</b>");
  if (digest.bluesky.posts.length) {
    for (const post of digest.bluesky.posts.slice(0, 6)) {
      lines.push(
        `- <a href="${escapeHtml(post.url)}">${escapeHtml(post.title)}</a> (score ${post.score}, ${escapeHtml(post.community)})`
      );
    }
  } else {
    lines.push("- No qualifying Bluesky posts found");
  }
  if (digest.failures.length) {
    lines.push("", `<i>Partial data: ${digest.failures.length} source warning(s). The web digest has details.</i>`);
  }
  return lines.join("\n");
}

async function publishFiles(digest) {
  const archiveDir = path.join(OUTPUT_DIR, "archive");
  const dateKey = dateKeyPacific(new Date(digest.generatedAt));
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.writeFile(path.join(archiveDir, `${dateKey}.html`), renderPage(digest, { archived: true }), "utf8");

  const archiveDates = (await fs.readdir(archiveDir))
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.html$/.test(name))
    .map((name) => name.slice(0, -5))
    .sort((a, b) => b.localeCompare(a));

  await Promise.all([
    fs.writeFile(path.join(OUTPUT_DIR, "index.html"), renderPage(digest), "utf8"),
    fs.writeFile(path.join(OUTPUT_DIR, "latest.json"), `${JSON.stringify(digest, null, 2)}\n`, "utf8"),
    fs.writeFile(path.join(archiveDir, "index.html"), renderArchiveIndex(archiveDates), "utf8"),
    fs.writeFile(path.join(OUTPUT_DIR, ".nojekyll"), "", "utf8"),
  ]);
}

async function sendTelegram(digest) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { status: "disabled" };

  try {
    const response = await fetchWithRetry(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: renderTelegram(digest),
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      },
      "Telegram"
    );
    const json = await response.json();
    return { status: "sent", messageId: json.result?.message_id };
  } catch (error) {
    return { status: "failed", error: shortError(error) };
  }
}

async function main() {
  const now = new Date();
  const [reddit, bluesky] = await Promise.all([fetchReddit(now), fetchBluesky(now)]);
  const digest = buildDigest(now, reddit, bluesky);
  await publishFiles(digest);
  const telegram = await sendTelegram(digest);
  console.log(
    JSON.stringify(
      {
        status: digest.status,
        run_time_pt: digest.runTimePacific,
        window_start_pt: digest.windowStartPacific,
        window_end_pt: digest.windowEndPacific,
        reddit_posts: digest.reddit.posts.length,
        bluesky_posts: digest.bluesky.posts.length,
        source_warnings: digest.failures.length,
        output_dir: OUTPUT_DIR,
        telegram,
      },
      null,
      2
    )
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(shortError(error));
    process.exitCode = 1;
  });
}

module.exports = { isExcludedPost, publishFiles, renderArchiveIndex, renderPage };
