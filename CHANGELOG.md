# Changelog

All notable changes to this fork are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-10-20

Fork of [`jack1545/dsh-weixin-reader`](https://github.com/jack1545/dsh-weixin-reader)
(upstream `0.1.0`, commit `f6d9973`). The upstream plugin never activated on the
current DeepSeek Harness / cordis 4 runtime; this release fixes that and finishes
the features its own README promised but did not implement.

### Fixed

- **The plugin now activates at all.** Upstream read services as plain properties
  (`ctx.workspace`, `ctx.systemPrompt`), which cordis 4 rejects with
  `cannot get property "workspace" without inject` — the entry failed at startup
  and `weixin_read` was never registered. All optional services are now read with
  `ctx.get(...)`, and the non-existent `workspace` service is no longer referenced.
- **`saveToFile` actually saves into the workspace.** Upstream fell back to the
  process working directory, because the service it used does not exist. The save
  root now comes from `workspaceRegistry` (session → workspace entity `path`),
  with `process.cwd()` only as a last resort.
- **Same-titled articles no longer overwrite each other.** Saved file names carry
  an 8-character URL hash.
- **Silent data loss in media and custom tags.** `<mpvoice>` and friends are
  frequently written without a closing tag; they used to swallow the rest of the
  article into their subtree. They are now parsed as leaves.
- **Truncation no longer cuts inside a code fence** and no longer cuts mid-line
  when a paragraph boundary is available.
- **Word count** ignores fenced code, image URLs and Markdown markers, and counts
  CJK characters plus Latin words instead of raw characters.
- **`htmlDecode("\x26quot;名称\x26quot;")`** forms (公众号名/标题) produced escaped
  garbage or a quote-wrapped string upstream; escapes and wrapping quotes are now
  unwrapped.

### Added

- **In-memory article cache** (`cacheTtlMs`, `maxCacheEntries`) with `forceRefresh`.
- **Retries with exponential backoff** (`retries`, `retryDelayMs`) for transport
  failures and HTTP 5xx/429/408 only; content-level failures never retry.
- **Redirect guard**: a redirect to a non-`mp.weixin.qq.com` host (WeChat's
  environment check) is reported as such instead of an empty parse.
- **New tool result fields**: `account` (公众号名), `cover`, `readingMinutes`,
  `images`, `omittedChars`, `remainingHeadings`, `cacheHit`.
- **Per-call `saveDir`** and a `saveToFile: false` override for config defaults.
- **Explicit save failures now throw** when the model asked for a file; only
  config-default saving degrades to a warning.
- **Structured config validation**: unknown keys and wrong types fail loudly at
  startup instead of silently falling back to defaults.
- **Parser coverage**: `<pre data-lang>` / `language-*` code fences, `<ol start>`,
  `<th>`-based table headers, `data-original`/`data-croporisrc` images, `data:`
  placeholder images skipped, iframe/video/audio rendered as links or readable
  placeholders, `publish_time` and `og:release_date` publication-time fallbacks,
  `<title>` title fallback, and extra content-container markers.
- **Test suite** (`node --test`, 33 tests, zero dependencies) with fixtures,
  plus a GitHub Actions workflow on Node 20 and 22.
- Shared `articleMetaLine()` so the tool rendering and the saved file cannot drift.

### Changed

- Package and bundle row renamed to `dsh-wechat-reader` (repo name); the tool is
  still called `weixin_read`, and `lib/parser.js` keeps its exported API.
- `maxChars: 0` now means "no truncation"; `cacheTtlMs: 0` disables the cache.
- cordis peer range widened to include 4.x.
- README rewritten: fork provenance, upstream attribution, honest limitations.

### Upstream

- `0.1.0` — initial release: zero-dependency parser, `weixin_read` tool, bundle
  patch layer, English and Chinese READMEs (MIT, © 2026 jack1545).

[0.2.0]: https://github.com/T34851969/dsh-wechat-reader/releases/tag/v0.2.0