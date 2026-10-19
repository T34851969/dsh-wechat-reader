# dsh-wechat-reader

[English](README.md) | [中文](README.zh.md)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的微信公众号
（`mp.weixin.qq.com`）文章阅读插件：抓取文章并把正文解析成干净的 Markdown 交给模型。

**Fork 说明。** 本项目 fork 自
[`jack1545/dsh-weixin-reader`](https://github.com/jack1545/dsh-weixin-reader)
（MIT，© 2026 jack1545），上游自 2026-09-21 起未再更新。上游 0.1.0 在当前的 Harness
运行时上**根本无法激活**：它用属性方式读取服务（`ctx.workspace`、`ctx.systemPrompt`），
cordis 4 会直接抛出 `cannot get property "workspace" without inject`，导致
`weixin_read` 从未注册成功。本 fork 修好了这个问题，补齐了上游 README 已经承诺但
没有实现的功能，并补上测试。完整改动见 [CHANGELOG.md](CHANGELOG.md)。

## 为什么需要它

Harness 内置的 `web_fetch` 抓公众号文章经常失败：站点会返回环境校验页，正文被大量
内联样式和嵌套容器包裹，图片走 `data-src` 懒加载。本插件专门处理这些情况，并且只暴露
一个窄接口工具。

## 提供的能力

一个面向模型的工具 `weixin_read`：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | 是 | 文章链接，如 `https://mp.weixin.qq.com/s/xxxxxxxx`（可省略协议） |
| `maxChars` | integer | 否 | 返回正文的最大字符数（`0` = 不截断）；不传则用插件配置 |
| `saveToFile` | boolean | 否 | 是否把完整正文写入工作区文件；不传则用插件配置 |
| `saveDir` | string | 否 | 保存目录（绝对路径，或相对于工作区） |
| `forceRefresh` | boolean | 否 | 跳过程序内缓存，强制重新抓取 |

规范结果包含 `title`、`account`、`author`、`publishedAt`、`sourceUrl`、`cover`、
`readingMinutes`、`wordCount`、`imageCount`、`images`、`markdown`、`truncated`、
`omittedChars`、`remainingHeadings`、`savedTo`、`bodyChars`、`cacheHit`。模型实际
看到的是渲染后的 Markdown：标题、元信息行、正文。`publishedAt` 是 ISO UTC；元信息行与
落盘文件名使用读者本机时区，与微信页面渲染 `ct` 的方式一致。

插件还会注册一段系统提示词，告诉模型读公众号文章时优先用它而不是 `web_fetch`。

## 安装

```sh
dsh plugin --profile <name> add github:T34851969/dsh-wechat-reader
```

从源码检出运行时用 `pnpm dsh` 代替 `dsh`。加载新图层需要重启 Harness 进程。

如果本机 `git`/SSH 不可用（例如 SSH 配置损坏导致 `git+ssh` 拉取失败），可以改装
release tarball：代码相同，走 HTTPS，完全不经过 `git`：

```sh
dsh plugin --profile <name> add \
  https://github.com/T34851969/dsh-wechat-reader/archive/refs/tags/v0.2.1.tar.gz
```

按需替换 tag；tarball 方式版本固定，换新版本要换新 URL，而 `github:` 形式跟随默认分支。

> **DSH 桌面版：** `desktop` profile 由应用自己管理，其名字在 CLI 中是保留的。
> 请改用应用内的插件管理页添加该 bundle，或用上面的命令装到非 desktop 的 profile。

不启动进程也能校验图层：

```sh
dsh --profile <name> --dump-config   # 应能看到 "# == dsh-wechat-reader" 图层
```

卸载：

```sh
dsh plugin --profile <name> remove dsh-wechat-reader
```

**从上游 0.1.0 迁移？** 请先卸掉旧 bundle
（`dsh plugin --profile <name> remove dsh-weixin-reader`）：两者注册的工具名都是
`weixin_read`，同一层里重名会直接报错。

## 配置

所有可调项都在 `cordis.patch.yml` 的 `config` 块里，也可以在 profile 自己的
`cordis.patch.yml` 里按 `id` 覆盖。写错的键或类型会在启动时直接报错，而不是静默退回
默认值。

| 键 | 默认值 | 说明 |
|---|---|---|
| `timeoutMs` | `30000` | 抓取超时（毫秒） |
| `maxChars` | `60000` | 正文字符上限；`0` 表示不截断 |
| `saveToFile` | `false` | 是否默认保存完整正文 |
| `saveDir` | `""` | 保存目录；留空写入 `<会话工作区>/weixin-articles/` |
| `cacheTtlMs` | `600000` | 进程内文章缓存存活时间；`0` 关闭缓存 |
| `maxCacheEntries` | `20` | 缓存容量（超出时淘汰最久未用条目） |
| `retries` | `2` | 仅对传输层失败与 HTTP 5xx/429/408 的额外重试次数 |
| `retryDelayMs` | `500` | 退避基数，逐次翻倍 |
| `systemPromptOrder` | `10120` | 提示段顺序，越靠后越接近生成位置 |
| `userAgent` | `""` | 覆盖默认的桌面浏览器 UA |

## 设计取舍

**零外部 import。** profile 的 `node_modules` 不提供 `@deepseek-ai/*` 运行时依赖，
所以插件只用 Node 内置能力与 `ctx`，也不使用 `defineTool`。代价是手工做参数校验——
这部分已实现，且失败信息与声明的 schema 一致。

**可选服务一律软查询。** cordis 4 里读取未在 `inject` 中声明的服务会抛错，而上游依赖
的 `workspace` 服务在 DSH 里根本不存在。本 fork 只声明 `tools`，其它服务全部通过
`ctx.get(...)` 获取，因此同一份代码在最小运行时和完整运行时都能跑。

**保存路径感知工作区。** `saveDir` 优先；否则从 `workspaceRegistry`（会话 → 工作区
实体的 `path`）解析工作区根目录，最后才退回 `process.cwd()`。落盘文件名带 8 位 URL
哈希，标题相同的两篇文章不会互相覆盖。

**抓取不用子进程。** Harness 的文件沙箱会拦截 Node 读取子进程管道，`execFileSync` 与
管道式 `spawn` 都会 `EPERM`，所以 `url-md.exe` 这类外部抓取器在插件内不可用。本插件
改用宿主 `fetch`，它沿用进程既有的代理设置，也不受该限制影响。

**宁可明确报错，也不静默降级。** 环境校验页、被删除或违规的文章、失效链接、无法识别
的页面结构，都会抛出带明确错误码的异常，而不是悄悄重试或返回空正文。只有传输层失败与
HTTP 5xx/429/408 才会重试。

## 测试

零依赖，解析器可脱离 Harness 单独运行：

```sh
node --test        # 36 个测试：解析器、抓取/重试策略、缓存、工具层
```

覆盖范围：实体与转义解码、正文容器截取（包括 `<script>` 里带假闭合标签的情况）、
块级与行内渲染、表格、嵌套列表、带语言标注的代码块、媒体占位、元信息提取、失败原因
分类、按段落边界截断并补齐代码围栏、重试与重定向策略、缓存 TTL/LRU、入参与配置校验、
工作区解析、规范结果与 schema 一致性。CI 在 Node 20 与 22 上跑这套测试。

`lib/parser.js` 也可以独立使用：

```js
import { fetchArticle, formatArticle } from './lib/parser.js';

const article = await fetchArticle('https://mp.weixin.qq.com/s/xxxxxxxx');
console.log(article.title, article.account, article.wordCount, article.images.length);
console.log(formatArticle(article));
```

## 验证情况

2026-10-20 实测：

- **真实运行时激活。** 用真实 `cordis@4.0.4`、真实 `@deepseek-ai/dsh-tools` 与
  `@deepseek-ai/dsh-system-prompt` 挂载：插件成功激活，`weixin_read` 注册成功（工具
  注册表同时接受 `parameters` 与扩展后的 `output.schema`，含数组），提示段进入真实
  注册表，`ctx.get(...)` 软查询不会抛错。
- **实站文章端到端。** 用
  [`/s/Wg4ZwhEJB4yT4S3XpY8HpQ`](https://mp.weixin.qq.com/s/Wg4ZwhEJB4yT4S3XpY8HpQ)
  （公众号 `xyang-class`，从 Word 粘贴出来的 6.6 MB 页面）实测：19451 字、4 张
  `data-src` 懒加载图片、27 个表格，解析出 61728 字符干净 Markdown；工具层返回全部
  17 个字段，完整正文落盘成功，截断时给出省略字数与后续标题。
- **默认 User-Agent 是必需的。** 同一个链接改用最简 `Mozilla/5.0` UA 会被重定向到微信
  的 `wappoc_appmsgcaptcha` 环境校验页，而插件默认的桌面浏览器 UA 能拿到正文。如果遇到
  `blocked`，优先调整 `userAgent`。
- **单元测试。** Node 22 上 36/36 通过，在 `TZ=Asia/Hong_Kong`、`UTC`、
  `America/Los_Angeles`、`Pacific/Kiritimati` 下结果一致。

自己复现：

```sh
node -e "const {fetchArticle}=await import('./lib/parser.js'); \
  const a=await fetchArticle(process.argv[1]); \
  console.log(a.title, a.account, a.wordCount, a.imageCount); \
  console.log(a.markdown.slice(0, 400))" 'https://mp.weixin.qq.com/s/xxxxxxxx'
```

## 已知限制

- **只支持 `mp.weixin.qq.com`。** 其它 host 会被拒绝，因此不能当作通用抓取器。
- **正文是解析结果，不是原始 HTML。** 富交互布局（自定义卡片、互动组件）会退化成文字
  或链接；图片保留 Markdown 图片语法但不会下载，视频与语音会变成链接或可读占位。
- **缓存是进程内的。** 只存在内存中，不跨会话共享，重启即失效。
- **不做批量抓取。** 请保持较低请求频率并遵守微信平台条款；本插件面向个人阅读与研究。

## 目录结构

```
dsh-wechat-reader/
├── package.json         # 声明 dsh.bundle
├── cordis.patch.yml     # 安装时应用的图层
├── index.js             # 插件入口：注册、缓存、落盘、提示段
├── lib/parser.js        # 零依赖解析器，可脱离 Harness 测试
└── test/                # node:test 测试与 HTML 夹具
```

## 许可证

MIT。原始工作 © 2026
[jack1545](https://github.com/jack1545/dsh-weixin-reader)；fork © 2026
[T34851969](https://github.com/T34851969/dsh-wechat-reader)。按许可证要求，
上游版权声明保留在 [LICENSE](LICENSE) 中。

本插件与腾讯/微信无关联，仅用于个人阅读与研究。