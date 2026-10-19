# dsh-wechat-reader

[English](README.md) | [中文](README.zh.md)

A WeChat Official Account (`mp.weixin.qq.com`) article reader for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): it fetches an
article and parses the body into clean Markdown for the model.

**Fork notice.** This is a fork of
[`jack1545/dsh-weixin-reader`](https://github.com/jack1545/dsh-weixin-reader)
(MIT, © 2026 jack1545), which has not been updated since 2026-09-21. Upstream
0.1.0 **does not activate** on the current Harness runtime: it reads services as
plain properties (`ctx.workspace`, `ctx.systemPrompt`), which cordis 4 rejects
with `cannot get property "workspace" without inject`, so `weixin_read` is never
registered. This fork fixes that, finishes the features upstream's README already
promised, and adds a test suite. See [CHANGELOG.md](CHANGELOG.md) for the full
list.

## Why

Harness's built-in `web_fetch` often fails on WeChat articles: the site returns an
environment-check page, the body is buried under heavy inline styles and nested
containers, and images load lazily through `data-src`. This plugin handles those
cases and exposes a single narrow tool.

## What it provides

One model-facing tool, `weixin_read`:

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Article link, e.g. `https://mp.weixin.qq.com/s/xxxxxxxx` (the scheme may be omitted) |
| `maxChars` | integer | no | Maximum body characters before truncation (`0` = no truncation); falls back to the plugin config |
| `saveToFile` | boolean | no | Write the full body to a workspace file; falls back to the plugin config |
| `saveDir` | string | no | Save directory (absolute, or relative to the workspace) |
| `forceRefresh` | boolean | no | Skip the in-process cache and re-fetch |

The canonical result carries `title`, `account`, `author`, `publishedAt`,
`sourceUrl`, `cover`, `readingMinutes`, `wordCount`, `imageCount`, `images`,
`markdown`, `truncated`, `omittedChars`, `remainingHeadings`, `savedTo`,
`bodyChars`, and `cacheHit`. What the model sees is rendered Markdown: title,
metadata line, then the body.

The plugin also registers a system-prompt section telling the model to prefer
`weixin_read` over `web_fetch` for WeChat articles.

## Install

```sh
dsh plugin --profile <name> add github:T34851969/dsh-wechat-reader
```

From a source checkout, use `pnpm dsh` instead of `dsh`. Restart the Harness
process to load the new layer.

If `git`-over-SSH is unavailable, install the release tarball instead — same
code, fetched over HTTPS, no `git` involved:

```sh
dsh plugin --profile <name> add \
  https://github.com/T34851969/dsh-wechat-reader/archive/refs/tags/v0.2.0.tar.gz
```

Pin whichever tag you want; a new release needs a new URL, whereas the
`github:` form follows the default branch.

> **DSH Desktop:** the `desktop` profile is owned by the app and its name is
> reserved in the CLI. Add the bundle from the app's plugin manager instead, or
> install into a non-desktop profile with the command above.

Verify the layer without starting:

```sh
dsh --profile <name> --dump-config   # should contain a "# == dsh-wechat-reader" layer
```

Uninstall:

```sh
dsh plugin --profile <name> remove dsh-wechat-reader
```

**Migrating from upstream 0.1.0?** Remove the old bundle first
(`dsh plugin --profile <name> remove dsh-weixin-reader`). Both register the same
`weixin_read` tool name, and duplicate names in one layer are a hard error.

## Configuration

Every tunable lives in the `config` block of `cordis.patch.yml` and can be
overridden by `id` in a profile's own `cordis.patch.yml`. Unknown keys and wrong
types fail loudly at startup instead of silently falling back to defaults.

| Key | Default | Description |
|---|---|---|
| `timeoutMs` | `30000` | Fetch timeout in milliseconds |
| `maxChars` | `60000` | Body character limit; `0` disables truncation |
| `saveToFile` | `false` | Whether to save the full body by default |
| `saveDir` | `""` | Save directory; empty writes to `<session workspace>/weixin-articles/` |
| `cacheTtlMs` | `600000` | In-process article cache TTL; `0` disables the cache |
| `maxCacheEntries` | `20` | Cache capacity (least-recently-used entries are evicted) |
| `retries` | `2` | Extra attempts for transport failures and HTTP 5xx/429/408 only |
| `retryDelayMs` | `500` | Base backoff delay; doubles per attempt |
| `systemPromptOrder` | `10120` | Prompt-section order; later sits closer to generation |
| `userAgent` | `""` | Overrides the default desktop browser UA |

## Design decisions

**Zero external imports.** A profile's `node_modules` does not provide
`@deepseek-ai/*` runtime dependencies, so the plugin uses only Node built-ins and
`ctx`, and does not use `defineTool`. The cost is manual argument validation,
which is implemented and whose failure messages match the declared schema.

**Optional services are soft lookups.** cordis 4 throws when a plugin reads a
service it did not declare in `inject`, and the service upstream relied on
(`workspace`) does not exist in DSH at all. This fork declares only `tools` and
reaches everything else through `ctx.get(...)`, so the same code runs on a
minimal runtime and on a full one.

**Workspace-aware saving.** `saveDir` wins; otherwise the plugin resolves the
workspace root from `workspaceRegistry` (session → workspace entity `path`) and
falls back to `process.cwd()`. Saved files carry an 8-character URL hash so two
articles with the same title cannot overwrite each other.

**No subprocess for fetching.** The Harness file sandbox blocks Node from reading
a child process's pipes; `execFileSync` and piped `spawn` both fail with `EPERM`,
so external fetchers such as `url-md.exe` cannot be used from inside a plugin.
This plugin uses the host `fetch` instead, which inherits the process's existing
proxy settings and is unaffected by that limit.

**Fails loudly rather than degrading.** An environment-check page, a deleted or
restricted article, an invalid link, and an unrecognizable page structure each
raise an explicit error with a distinct error code instead of silently retrying
or returning an empty body. Only transport-level failures and HTTP 5xx/429/408
are retried.

## Testing

Zero dependencies; the parser runs standalone:

```sh
node --test        # 34 tests: parser, fetch/retry policy, cache, tool layer
```

Covered: entity/escape decoding, container slicing (including `<script>` bodies
that contain fake closing tags), block and inline rendering, tables, nested
lists, code fences with languages, media placeholders, metadata extraction,
reason classification, paragraph-aware truncation with fence balancing, retry and
redirect policy, cache TTL/LRU, argument and config validation, workspace
resolution, and canonical-result/schema agreement. CI runs the suite on Node 20
and 22.

`lib/parser.js` also works outside Harness:

```js
import { fetchArticle, formatArticle } from './lib/parser.js';

const article = await fetchArticle('https://mp.weixin.qq.com/s/xxxxxxxx');
console.log(article.title, article.account, article.wordCount, article.images.length);
console.log(formatArticle(article));
```

## Verification

Verified on 2026-10-20:

- **Activation on the real runtime.** Mounted with real `cordis@4.0.4`, real
  `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-system-prompt`: the plugin
  activates, `weixin_read` is registered (the tool registry accepts both
  `parameters` and the extended `output.schema`, arrays included), the prompt
  section lands in the real registry, and `ctx.get(...)` soft lookups do not
  throw.
- **Live transport.** From this machine, `mp.weixin.qq.com` is reachable and an
  invalid link is classified as `invalid-link` with a readable message at both
  the parser and the tool layer.
- **Unit tests.** 34 of 34 pass on Node 22.
- **Not verified here:** a full parse of a currently-live article. That needs a
  real link, and this environment had no search access to obtain one. If you have
  a link:

  ```sh
  node -e "const {fetchArticle}=await import('./lib/parser.js'); \
    const a=await fetchArticle(process.argv[1]); \
    console.log(a.title, a.account, a.wordCount, a.imageCount); \
    console.log(a.markdown.slice(0, 400))" 'https://mp.weixin.qq.com/s/xxxxxxxx'
  ```

## Limitations

- **`mp.weixin.qq.com` only.** Other hosts are rejected, so it cannot be
  repurposed as a general fetcher.
- **The body is a parse result, not raw HTML.** Rich layouts (custom cards,
  interactive components) degrade to text or links; images stay as Markdown image
  syntax and are not downloaded. Videos and voice messages become links or
  readable placeholders.
- **The cache is per process.** It lives in memory, is not shared between
  sessions, and disappears on restart.
- **No bulk fetching.** Keep the request rate low and respect WeChat's platform
  terms; this plugin is for personal reading and research.

## Layout

```
dsh-wechat-reader/
├── package.json         # declares dsh.bundle
├── cordis.patch.yml     # the layer applied on install
├── index.js             # plugin entry: registration, cache, saving, prompt section
├── lib/parser.js        # zero-dependency parser, testable outside Harness
└── test/                # node:test suite + HTML fixtures
```

## License

MIT. Original work © 2026
[jack1545](https://github.com/jack1545/dsh-weixin-reader); fork © 2026
[T34851969](https://github.com/T34851969/dsh-wechat-reader). The upstream
copyright notice is retained in [LICENSE](LICENSE) as the license requires.

This plugin is not affiliated with Tencent or WeChat, and is intended for
personal reading and research.