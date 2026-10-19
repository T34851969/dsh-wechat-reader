/**
 * dsh-wechat-reader — DeepSeek Harness 插件：读取微信公众号文章。
 *
 * 背景：DSH 内置的 web_fetch 对 mp.weixin.qq.com 常因环境校验、样式混淆
 * 而拿不到正文。本插件用一个零依赖的解析器抓取文章，把正文转成干净的
 * Markdown，再交给模型。
 *
 * 为什么不用子进程：DSH 沙箱会拦截 Node 对子进程管道的读取（EPERM），
 * 因此 url-md.exe 这类外部抓取器在插件内不可用；改用宿主 fetch（走
 * 进程既有的代理设置），并自行解析。
 *
 * 本文件刻意保持零外部 import：profile 的 node_modules 里不提供
 * @deepseek-ai/* 运行时依赖，只有纯 JS 插件才能稳定加载。
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ArticleFetchError,
  articleMetaLine,
  fetchArticle,
  formatArticle,
  normalizeArticleUrl,
  truncateMarkdown,
} from './lib/parser.js';

/** 插件名，与 package.json 的 dsh.bundle 行 id 保持一致。 */
export const name = 'dsh-wechat-reader';

/**
 * 需要的服务：tools 注册表（工具注册）。
 *
 * systemPrompt 与 workspaceRegistry 都是**可选**的：cordis 4 里读取一个没有
 * inject 的服务会直接抛错，而 `workspace` 这个服务名在 DSH 里根本不存在，
 * 所以这里一律用 `ctx.get(...)` 软查询，绝不写 `ctx.systemPrompt` 这种属性访问。
 */
export const inject = ['tools'];

/** 默认配置；所有可调项均可由 cordis.yml 的 config 覆盖。 */
const DEFAULTS = {
  timeoutMs: 30000,
  maxChars: 60000,
  saveToFile: false,
  saveDir: '',
  cacheTtlMs: 600000,
  maxCacheEntries: 20,
  retries: 2,
  retryDelayMs: 500,
  systemPromptOrder: 10120,
  userAgent: '',
};

/** 工具入参白名单。 */
const PARAMS = ['url', 'maxChars', 'saveToFile', 'saveDir', 'forceRefresh'];

/**
 * 校验并归一化插件配置。
 *
 * 配置写错时直接抛错（插件不激活），而不是静默使用默认值——一个拼错的
 * `maxChars` 会让「截断」看起来失效，排查成本远高于启动时报错。
 *
 * @param {unknown} raw cordis.yml 传入的 config
 * @returns {typeof DEFAULTS}
 */
function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const unknown = Object.keys(input).filter((key) => !Object.prototype.hasOwnProperty.call(DEFAULTS, key));
  if (unknown.length) {
    throw new Error(
      '[' + name + '] 未知配置项：' + unknown.join('、')
      + '；可用配置：' + Object.keys(DEFAULTS).join('、'),
    );
  }

  const config = { ...DEFAULTS };
  const integer = (key, min) => {
    const value = input[key];
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < min) {
      throw new Error('[' + name + '] config.' + key + ' 必须是 ≥ ' + min + ' 的整数，收到：' + JSON.stringify(value));
    }
    config[key] = value;
  };
  const boolean = (key) => {
    const value = input[key];
    if (value === undefined) return;
    if (typeof value !== 'boolean') {
      throw new Error('[' + name + '] config.' + key + ' 必须是布尔值，收到：' + JSON.stringify(value));
    }
    config[key] = value;
  };
  const string = (key) => {
    const value = input[key];
    if (value === undefined) return;
    if (typeof value !== 'string') {
      throw new Error('[' + name + '] config.' + key + ' 必须是字符串，收到：' + JSON.stringify(value));
    }
    config[key] = value;
  };

  integer('timeoutMs', 1);
  integer('maxChars', 0);       // 0 = 不截断
  integer('cacheTtlMs', 0);     // 0 = 关闭缓存
  integer('maxCacheEntries', 0);
  integer('retries', 0);
  integer('retryDelayMs', 0);
  integer('systemPromptOrder', 0);
  boolean('saveToFile');
  string('saveDir');
  string('userAgent');
  return config;
}

/**
 * 极简 LRU + TTL 文章缓存。
 * 同一篇文章在一轮对话里常被反复阅读（先摘要再细读），缓存能省掉重复抓取。
 */
class ArticleCache {
  /**
   * @param {number} ttlMs 存活时间；<= 0 关闭
   * @param {number} maxEntries 容量上限；<= 0 关闭
   */
  constructor(ttlMs, maxEntries) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  /** @param {string} key @returns {object | undefined} */
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.ttlMs <= 0 || Date.now() - entry.storedAt >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // 触摸：Map 的插入序即 LRU 序。
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.article;
  }

  /** @param {string} key @param {object} article */
  set(key, article) {
    if (this.ttlMs <= 0 || this.maxEntries <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { storedAt: Date.now(), article });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  get size() { return this.entries.size; }

  clear() { this.entries.clear(); }
}

/**
 * 校验工具入参（绕过 defineTool 直接 register 时不会自动校验）。
 * @param {unknown} args
 * @param {typeof DEFAULTS} config
 * @returns {{ url: URL, maxChars: number, saveToFile: boolean | undefined, saveDir: string, forceRefresh: boolean }}
 */
function validateArgs(args, config) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('参数必须是对象，且包含 url 字段。');
  }
  const extra = Object.keys(args).filter((key) => !PARAMS.includes(key));
  if (extra.length) throw new Error('不支持的参数：' + extra.join('、'));
  if (args.maxChars !== undefined && (!Number.isInteger(args.maxChars) || args.maxChars < 0)) {
    throw new Error('maxChars 必须是非负整数（0 表示不截断）。');
  }
  if (args.saveToFile !== undefined && typeof args.saveToFile !== 'boolean') {
    throw new Error('saveToFile 必须是布尔值。');
  }
  if (args.saveDir !== undefined && typeof args.saveDir !== 'string') {
    throw new Error('saveDir 必须是字符串（绝对路径，或相对于工作区的路径）。');
  }
  if (args.forceRefresh !== undefined && typeof args.forceRefresh !== 'boolean') {
    throw new Error('forceRefresh 必须是布尔值。');
  }

  const raw = typeof args.url === 'string' ? args.url.trim() : '';
  if (!raw) throw new Error('缺少参数 url，或它不是非空字符串。');

  return {
    url: normalizeArticleUrl(raw),
    maxChars: Number.isInteger(args.maxChars) ? args.maxChars : config.maxChars,
    saveToFile: args.saveToFile,
    saveDir: typeof args.saveDir === 'string' ? args.saveDir.trim() : '',
    forceRefresh: args.forceRefresh === true,
  };
}

/** 生成一个文件系统安全的文件名；同名文章用 URL 短哈希区分，避免互相覆盖。 */
export function safeFileName(article) {
  const title = String(article.title || 'weixin-article')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'weixin-article';
  const stamp = String(article.publishedAt || '').slice(0, 10);
  const hash = createHash('sha1').update(String(article.url || title)).digest('hex').slice(0, 8);
  return [stamp, title, hash].filter(Boolean).join('-') + '.md';
}

/**
 * 当前会话所属工作区根目录。
 *
 * `workspaceRegistry` 是 DSH 里真实存在的服务（`workspace` 不是），
 * 实体上有 `path`/`sessionIds`。服务缺失、会话未登记或结构变化时都返回空串，
 * 由调用方退回 process.cwd()。
 *
 * @param {object} ctx
 * @param {object} [exec] 工具执行上下文
 * @returns {string}
 */
export function resolveWorkspaceRoot(ctx, exec) {
  const registry = ctx.get('workspaceRegistry');
  if (!registry || typeof registry.list !== 'function') return '';
  const session = exec && exec.agent ? exec.agent.session : undefined;
  const sessionId = session && typeof session.id === 'string' ? session.id : '';
  if (!sessionId) return '';

  let workspaces;
  try {
    workspaces = registry.list();
  } catch {
    return '';
  }
  if (!Array.isArray(workspaces)) return '';

  for (const workspace of workspaces) {
    try {
      const ids = workspace.sessionIds;
      const path = workspace.path;
      if (Array.isArray(ids) && ids.includes(sessionId) && typeof path === 'string' && path) return path;
    } catch {
      // 单条记录读取失败不影响其它工作区。
    }
  }
  return '';
}

/**
 * 解析保存目标目录。
 *
 * 优先级：工具入参 saveDir → 插件 config.saveDir → `<会话工作区>/weixin-articles/`。
 * @returns {string} 绝对路径
 */
export function resolveSaveTarget(config, input, ctx, exec) {
  const explicit = input.saveDir || config.saveDir;
  if (explicit) return resolve(explicit);
  const root = resolveWorkspaceRoot(ctx, exec)
    || (typeof process.cwd === 'function' ? process.cwd() : '')
    || homedir();
  return join(root, 'weixin-articles');
}

/** 把文章写入文件，返回绝对路径。 */
async function saveArticle(article, target) {
  await mkdir(target, { recursive: true });
  const file = join(target, safeFileName(article));
  await writeFile(file, formatArticle(article), 'utf8');
  return file;
}

/**
 * 注册 weixin_read 工具。
 * @param {object} ctx Cordis 上下文
 * @param {typeof DEFAULTS} config 解析后的插件配置
 * @param {ArticleCache} cache
 */
function registerTool(ctx, config, cache) {
  ctx.tools.register({
    name: 'weixin_read',
    description:
      '读取微信公众号文章正文（mp.weixin.qq.com）。返回标题、公众号、作者、发布时间、字数与转成 Markdown 的正文，'
      + '适合需要阅读、总结或对比公众号文章的场景。仅接受 mp.weixin.qq.com 的文章链接；'
      + '正文过长时返回内容会被截断并标注，可改用 saveToFile 保存完整正文。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '微信公众号文章链接，形如 https://mp.weixin.qq.com/s/xxxxxxxx（可省略 https://）',
        },
        maxChars: {
          type: 'integer',
          description: '返回正文的最大字符数；0 表示不截断。不传则使用插件默认值。',
        },
        saveToFile: {
          type: 'boolean',
          description: '是否把完整正文写入工作区文件（默认 false；正文较长时建议开启）。',
        },
        saveDir: {
          type: 'string',
          description: '保存目录（绝对路径，或相对工作区的路径）；不传则用插件配置或 <工作区>/weixin-articles/。',
        },
        forceRefresh: {
          type: 'boolean',
          description: '跳过程序内缓存，强制重新抓取（默认 false）。',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          account: { type: 'string' },
          author: { type: 'string' },
          publishedAt: { type: 'string' },
          sourceUrl: { type: 'string' },
          cover: { type: 'string' },
          readingMinutes: { type: 'integer' },
          wordCount: { type: 'integer' },
          imageCount: { type: 'integer' },
          images: { type: 'array', items: { type: 'string' } },
          markdown: { type: 'string' },
          truncated: { type: 'boolean' },
          omittedChars: { type: 'integer' },
          remainingHeadings: { type: 'array', items: { type: 'string' } },
          savedTo: { type: 'string' },
          bodyChars: { type: 'integer' },
          cacheHit: { type: 'boolean' },
        },
        required: ['title', 'markdown'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const parts = ['# ' + (value.title || '(无标题)')];
        const meta = articleMetaLine(value);
        if (meta) parts.push(meta);
        if (value.sourceUrl) parts.push('原文：' + value.sourceUrl);
        if (value.cacheHit) parts.push('（来自本地缓存，可用 forceRefresh 重新抓取）');
        if (value.savedTo) parts.push('完整正文已保存到：' + value.savedTo);
        if (value.truncated) {
          parts.push(
            '（正文已截断：省略约 ' + value.omittedChars + ' 字'
            + (value.remainingHeadings && value.remainingHeadings.length
              ? '，后续小节：' + value.remainingHeadings.join('、')
              : '')
            + '）',
          );
        }
        parts.push('---', value.markdown || '');
        return [{ type: 'text', text: parts.join('\n\n') }];
      },
    },
    async execute(args, exec) {
      const input = validateArgs(args, config);
      const key = input.url.href;

      let article = input.forceRefresh ? undefined : cache.get(key);
      const cacheHit = article !== undefined;
      if (!article) {
        article = await fetchArticle(input.url, {
          timeoutMs: config.timeoutMs,
          retries: config.retries,
          retryDelayMs: config.retryDelayMs,
          signal: exec && exec.signal ? exec.signal : undefined,
          ...(config.userAgent ? { userAgent: config.userAgent } : {}),
        });
        cache.set(key, article);
      }

      // 规范值只承载正文本体；标题与元信息由 output.render 组合，
      // 避免渲染时出现重复标题。
      const clipped = truncateMarkdown(article.markdown, input.maxChars);

      let savedTo = '';
      const explicitSave = input.saveToFile === true;
      const wantSave = explicitSave || (input.saveToFile === undefined && config.saveToFile);
      if (wantSave) {
        try {
          savedTo = await saveArticle(article, resolveSaveTarget(config, input, ctx, exec));
        } catch (error) {
          // 模型明确要求保存时，失败必须报错；只是配置默认开启时降级为告警。
          if (explicitSave) {
            throw new ArticleFetchError('保存正文失败：' + error.message, { code: 'save-failed', cause: error });
          }
          if (ctx.logger && typeof ctx.logger.warn === 'function') {
            ctx.logger.warn('[' + name + '] 保存正文失败：' + error.message);
          }
        }
      }

      return {
        title: article.title || '',
        account: article.account || '',
        author: article.author || '',
        publishedAt: article.publishedAt || '',
        sourceUrl: article.url || input.url.href,
        cover: article.cover || '',
        readingMinutes: article.readingMinutes,
        wordCount: article.wordCount,
        imageCount: article.imageCount,
        images: article.images,
        markdown: clipped.text,
        truncated: clipped.truncated,
        omittedChars: clipped.omittedChars,
        remainingHeadings: clipped.remainingHeadings,
        savedTo,
        bodyChars: clipped.originalChars,
        cacheHit,
      };
    },
  });
}

/**
 * 插件入口。
 * @param {object} ctx Cordis 上下文
 * @param {object} [rawConfig] cordis.yml 传入的配置
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const cache = new ArticleCache(config.cacheTtlMs, config.maxCacheEntries);

  registerTool(ctx, config, cache);

  // 可选：在系统提示词里说明这个工具的存在，帮助模型优先选它而不是 web_fetch。
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    const dispose = systemPrompt.section({
      name: 'tool:wechat-reader',
      order: config.systemPromptOrder,
      text:
        '读取微信公众号文章时优先使用 weixin_read 工具，它能把 mp.weixin.qq.com 的正文解析成干净的 Markdown；'
        + '内置 web_fetch 对该站点常因环境校验拿不到正文。',
    });
    if (typeof dispose === 'function' && typeof ctx.effect === 'function') ctx.effect(() => dispose);
  }
}