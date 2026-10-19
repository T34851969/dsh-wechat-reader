/**
 * dsh-wechat-reader — 微信公众号文章解析器：HTML → 结构化 Markdown。
 *
 * 零依赖，只用 Node 内置能力，可脱离 DSH 独立测试：
 *
 *   import { fetchArticle, formatArticle } from './lib/parser.js';
 *   const article = await fetchArticle('https://mp.weixin.qq.com/s/xxxxxxxx');
 *   console.log(article.title, article.wordCount, article.images.length);
 *
 * 导出：
 *   normalizeArticleUrl(url)    规范化/校验文章链接（附带主机白名单）
 *   fetchArticle(url, options)  抓取并解析一篇文章（含重试、重定向校验）
 *   parseArticle(html, url)     纯函数解析（便于离线测试）
 *   extractContentHtml(html)    截出正文容器 HTML
 *   renderBlocks(nodes)         节点数组 → Markdown
 *   truncateMarkdown(text, max) 按段落边界截断，避免截出半个代码块
 *   countWords(markdown)        中英混排字数统计
 *   articleMetaLine(article)    元信息行（供工具渲染与文件落盘共用）
 *   formatArticle(article)      渲染成完整 Markdown 文档
 */

/** 桌面浏览器 UA：微信对无 UA 的请求会返回验证页。 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 只有这些 host 的文章走本解析器。 */
const ALLOWED_HOSTS = new Set(['mp.weixin.qq.com']);

/** 自闭合/空元素，不参与树的嵌套。 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * 视作叶子处理的媒体/自定义标签：不进入树栈。
 * 微信的 `<mpvoice>` 等自定义元素经常没有闭合标签，一旦压栈会把后续正文吞成子节点。
 */
const LEAF_TAGS = new Set([
  'iframe', 'video', 'audio', 'mpvoice', 'mp-common-videosnippet',
  'mp-common-mpaudio', 'qqmusic', 'mpcpc',
]);

/** 需要渲染成「媒体链接/占位」的叶子标签。 */
const MEDIA_TAGS = new Set([
  'iframe', 'video', 'audio', 'embed', 'mpvoice', 'mp-common-videosnippet',
  'mp-common-mpaudio', 'qqmusic', 'mpcpc',
]);

/** 整块丢弃的标签（内容也不保留）。 */
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'svg']);

/** 块级标签：在 Markdown 中独占段落。 */
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote',
  'pre', 'table', 'thead', 'tbody', 'tr', 'hr', 'figure', 'figcaption',
  'iframe', 'video', 'audio', 'embed', 'mpvoice', 'mp-common-videosnippet',
  'mp-common-mpaudio', 'qqmusic', 'mpcpc',
]);

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', middot: '\u00b7',
  times: '\u00d7', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  deg: '\u00b0', plusmn: '\u00b1', laquo: '\u00ab', raquo: '\u00bb',
  bull: '\u2022', dagger: '\u2020', prime: '\u2032', Prime: '\u2033',
  euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
  sect: '\u00a7', para: '\u00b6', permil: '\u2030',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '',
};

/** URL 级失败：`retryable` 只对传输层与 5xx/429 为真。 */
export class ArticleFetchError extends Error {
  /**
   * @param {string} message 面向模型的可读信息
   * @param {{ code?: string, retryable?: boolean, status?: number, cause?: unknown }} [options]
   */
  constructor(message, options) {
    const opts = options || {};
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ArticleFetchError';
    this.code = opts.code || 'fetch-failed';
    this.retryable = opts.retryable === true;
    if (opts.status !== undefined) this.status = opts.status;
  }
}

/**
 * 解码 HTML 实体（命名实体 + 十进制/十六进制数字实体）。
 * @param {string} text
 * @returns {string}
 */
export function decodeEntities(text) {
  if (!text || text.indexOf('&') === -1) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const codePoint = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, body) ? HTML_ENTITIES[body] : match;
  });
}

/**
 * 还原微信内联 JS 字符串里的转义（`\x26`、`\u0026`、`\"` 等）。
 * 公众号名/标题常写成 `nickname = htmlDecode("\x26quot;...")` 这类形式。
 * @param {string} value
 * @returns {string}
 */
export function unescapeJs(value) {
  if (!value || value.indexOf('\\') === -1) return value;
  return value
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\(["'\\/])/g, '$1');
}

/**
 * 读取一个标签属性值，兼容单引号、双引号与无引号写法。
 * @param {string} attrs
 * @param {string} name
 * @returns {string | null}
 */
export function getAttr(attrs, name) {
  if (!attrs) return null;
  const re = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i');
  const m = re.exec(attrs);
  if (!m) return null;
  const value = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : (m[3] || ''));
  return decodeEntities(value).trim();
}

/**
 * 规范化并校验文章链接。
 *
 * - 只接受 http/https；缺失协议时按 https 补全（可以直接粘贴 `mp.weixin.qq.com/s/...`）
 * - host 白名单为 `mp.weixin.qq.com`（大小写不敏感，容忍结尾的点）
 * - http 升级为 https
 * - 去掉 `#wechat_redirect` 之类的 fragment；保留 `__biz/mid/idx/sn` 等身份参数
 *
 * @param {string | URL} input
 * @returns {URL}
 * @throws {ArticleFetchError} code `invalid-url` / `unsupported-host`（均不可重试）
 */
export function normalizeArticleUrl(input) {
  const raw = input instanceof URL
    ? input.href
    : (typeof input === 'string' ? input.trim() : '');
  if (!raw) {
    throw new ArticleFetchError('缺少文章链接。', { code: 'invalid-url' });
  }
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : 'https://' + raw;

  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new ArticleFetchError('不是合法的 URL：' + raw, { code: 'invalid-url' });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ArticleFetchError('只支持 http/https 链接：' + raw, { code: 'invalid-url' });
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!ALLOWED_HOSTS.has(host)) {
    throw new ArticleFetchError(
      '只支持微信公众号文章（mp.weixin.qq.com），收到：' + parsed.hostname,
      { code: 'unsupported-host' },
    );
  }

  if (parsed.protocol === 'http:') parsed.protocol = 'https:';
  parsed.hash = '';
  return parsed;
}

/** 把 `//host/path` 与 `http://` 媒体地址规范成 https 绝对地址。 */
function normalizeMediaUrl(raw) {
  if (!raw) return '';
  const value = String(raw).trim();
  if (!value || /^data:/i.test(value)) return '';
  if (value.startsWith('//')) return 'https:' + value;
  if (/^http:\/\//i.test(value)) return 'https://' + value.slice('http://'.length);
  return value;
}

/** 图片地址：优先懒加载属性，跳过内联占位图。 */
function imageUrl(node) {
  const raw = getAttr(node.attrs, 'data-src')
    || getAttr(node.attrs, 'src')
    || getAttr(node.attrs, 'data-original')
    || getAttr(node.attrs, 'data-croporisrc')
    || '';
  return normalizeMediaUrl(raw);
}

/** 媒体节点的地址：先看自身属性，再看 `<source>` 之类的子节点。 */
function mediaUrl(node) {
  const own = getAttr(node.attrs, 'data-src')
    || getAttr(node.attrs, 'src')
    || getAttr(node.attrs, 'data-url')
    || '';
  if (own) return normalizeMediaUrl(own);
  for (const child of node.children || []) {
    if (child.tag === '#text') continue;
    const nested = getAttr(child.attrs, 'src') || getAttr(child.attrs, 'data-src');
    if (nested) return normalizeMediaUrl(nested);
  }
  return '';
}

/**
 * 把 HTML 解析成极简节点树，只保留结构信息。
 * @param {string} html
 * @returns {Array<object>} 根节点数组
 */
function buildTree(html) {
  const roots = [];
  const stack = [{ tag: '#root', children: roots }];
  const tagRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/gi;
  let lastIndex = 0;
  let match;
  let dropDepth = 0;

  const pushText = (text) => {
    if (!text) return;
    stack[stack.length - 1].children.push({ tag: '#text', text: decodeEntities(text) });
  };

  while ((match = tagRe.exec(html)) !== null) {
    if (dropDepth === 0) pushText(html.slice(lastIndex, match.index));
    lastIndex = tagRe.lastIndex;

    const raw = match[0];
    if (raw.startsWith('<!--') || raw.startsWith('<!')) continue;

    const closing = match[1];
    const tag = (match[2] || '').toLowerCase();
    const attrs = match[3] || '';
    const selfClosing = match[4];
    if (!tag) continue;

    if (closing) {
      if (dropDepth > 0) {
        if (DROP_TAGS.has(tag)) dropDepth -= 1;
        continue;
      }
      for (let i = stack.length - 1; i >= 1; i -= 1) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }

    if (dropDepth > 0) {
      if (DROP_TAGS.has(tag) && !VOID_TAGS.has(tag)) dropDepth += 1;
      continue;
    }
    if (DROP_TAGS.has(tag)) {
      if (!VOID_TAGS.has(tag) && !selfClosing) dropDepth += 1;
      continue;
    }
    // 媒体/自定义标签一律当叶子：即使写成 `<mpvoice ...>` 不闭合，也不会吞掉后续正文。
    if (VOID_TAGS.has(tag) || LEAF_TAGS.has(tag)) {
      stack[stack.length - 1].children.push({ tag, attrs, children: [] });
      continue;
    }

    const node = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  if (dropDepth === 0) pushText(html.slice(lastIndex));
  return roots;
}

/**
 * 行内渲染：把节点数组渲染成 Markdown 文本。
 * @param {Array<object>} nodes
 * @returns {string}
 */
function renderInline(nodes) {
  const out = [];
  for (const node of nodes) {
    if (node.tag === '#text') {
      out.push(node.text.replace(/\s+/g, ' '));
      continue;
    }
    if (node.tag === 'br') { out.push('\n'); continue; }
    if (node.tag === 'img') {
      const src = imageUrl(node);
      if (!src) continue;
      out.push('![' + (getAttr(node.attrs, 'alt') || '') + '](' + src + ')');
      continue;
    }
    if (MEDIA_TAGS.has(node.tag)) {
      const text = renderMedia(node);
      if (text) out.push(text);
      continue;
    }
    const inner = renderInline(node.children || []);
    const trimmed = inner.trim();
    switch (node.tag) {
      case 'strong': case 'b': out.push(trimmed ? '**' + trimmed + '**' : ''); break;
      case 'em': case 'i': out.push(trimmed ? '*' + trimmed + '*' : ''); break;
      case 'del': case 's': case 'strike': out.push(trimmed ? '~~' + trimmed + '~~' : ''); break;
      case 'code': out.push(trimmed ? '`' + trimmed.replace(/`/g, '') + '`' : ''); break;
      case 'a': {
        const href = normalizeMediaUrl(getAttr(node.attrs, 'href') || '');
        if (!trimmed) break;
        out.push(href && href !== trimmed ? '[' + trimmed + '](' + href + ')' : trimmed);
        break;
      }
      default: out.push(inner);
    }
  }
  return out.join('');
}

/** 媒体节点渲染：有地址给链接，没有就退化成可读占位（不静默丢内容）。 */
function renderMedia(node) {
  const label = (node.tag === 'audio' || node.tag === 'mp-common-mpaudio' || node.tag === 'qqmusic')
    ? '音频'
    : (node.tag === 'iframe' || node.tag === 'embed' || node.tag === 'mpcpc' ? '嵌入内容' : '视频');
  const src = mediaUrl(node);
  if (src) return '[' + label + '](' + src + ')';
  if (node.tag === 'mpvoice') {
    const fileId = getAttr(node.attrs, 'voice_encode_fileid') || '';
    return fileId ? '（语音消息：' + fileId + '）' : '（语音消息）';
  }
  const vid = getAttr(node.attrs, 'vid') || getAttr(node.attrs, 'data-mpvid') || getAttr(node.attrs, 'data-vid') || '';
  return vid ? '（' + label + '：vid=' + vid + '，需在微信中播放）' : '（' + label + '）';
}

/** 代码块按原样取出，不解释其中的标签文本。 */
function collectCodeText(node) {
  let text = '';
  const walk = (n) => {
    if (n.tag === '#text') { text += n.text; return; }
    if (n.tag === 'br') { text += '\n'; return; }
    for (const child of n.children || []) walk(child);
  };
  walk(node);
  return text.replace(/^\n+/, '').replace(/\n+$/, '');
}

/** 代码块语言：`<pre data-lang>` / `<code class="language-js">` / `<pre lang>`. */
function codeLanguage(node) {
  const direct = getAttr(node.attrs, 'data-lang') || getAttr(node.attrs, 'lang') || '';
  if (direct) return direct;
  for (const child of node.children || []) {
    if (child.tag !== 'code') continue;
    const cls = getAttr(child.attrs, 'class') || '';
    const m = /(?:language|lang)-([a-zA-Z0-9#+._-]+)/.exec(cls);
    if (m) return m[1];
  }
  return '';
}

/** 列表渲染，支持嵌套与 `<ol start>`。 */
function renderList(node, ordered, indent) {
  const lines = [];
  let index = Number.parseInt(getAttr(node.attrs, 'start') || '', 10);
  if (!Number.isFinite(index) || index < 1) index = 1;
  const items = (node.children || []).filter((c) => c.tag === 'li');
  for (const item of items) {
    const body = renderBlocks(item.children || [], indent + '  ');
    const collapsed = body.replace(/\n{2,}/g, '\n').trim();
    const marker = ordered ? (index + '. ') : '- ';
    index += 1;
    if (!collapsed) { lines.push((indent + marker).replace(/\s+$/, '')); continue; }
    const parts = collapsed.split('\n');
    lines.push(indent + marker + parts[0]);
    const pad = ' '.repeat(indent.length + marker.length);
    for (const line of parts.slice(1)) lines.push(line ? pad + line : '');
  }
  return lines.join('\n');
}

/** 表格渲染成 GitHub 风格 Markdown；优先用带 `<th>` 的行做表头。 */
function renderTable(node) {
  const rows = [];
  const walk = (n) => {
    if (n.tag === 'tr') {
      const cells = (n.children || []).filter((c) => c.tag === 'td' || c.tag === 'th');
      const values = cells
        .map((c) => renderInline(c.children || []).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim());
      if (values.length) rows.push({ values, header: cells.some((c) => c.tag === 'th') });
      return;
    }
    for (const child of n.children || []) walk(child);
  };
  walk(node);
  if (!rows.length) return '';

  const headerIndex = rows.findIndex((r) => r.header);
  if (headerIndex > 0) rows.unshift(rows.splice(headerIndex, 1)[0]);

  const width = Math.max.apply(null, rows.map((r) => r.values.length));
  const pad = (r) => { const c = r.values.slice(); while (c.length < width) c.push(''); return c; };
  const head = pad(rows[0]);
  const lines = ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |'];
  for (const row of rows.slice(1)) lines.push('| ' + pad(row).join(' | ') + ' |');
  return lines.join('\n');
}

/**
 * 块级渲染：把节点数组渲染成 Markdown 段落流。
 * @param {Array<object>} nodes
 * @param {string} [indent] 当前嵌套缩进（列表内使用）
 * @returns {string}
 */
export function renderBlocks(nodes, indent) {
  const pad = indent || '';
  const parts = [];
  let inlineBuffer = [];

  const flushInline = () => {
    if (!inlineBuffer.length) return;
    const text = renderInline(inlineBuffer)
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .filter((line, i, arr) => line || (i > 0 && i < arr.length - 1))
      .join('\n')
      .trim();
    inlineBuffer = [];
    if (text) parts.push(pad + text.replace(/\n/g, '\n' + pad));
  };

  for (const node of nodes) {
    if (node.tag === '#text') { inlineBuffer.push(node); continue; }
    if (!BLOCK_TAGS.has(node.tag)) { inlineBuffer.push(node); continue; }
    flushInline();

    switch (node.tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const level = Number(node.tag[1]);
        const text = renderInline(node.children || []).replace(/\s+/g, ' ').trim();
        if (text) parts.push('#'.repeat(level) + ' ' + text);
        break;
      }
      case 'hr': parts.push('---'); break;
      case 'pre': {
        const code = collectCodeText(node);
        if (code.trim()) {
          const lang = codeLanguage(node);
          parts.push('```' + lang + '\n' + code + '\n```');
        }
        break;
      }
      case 'blockquote': {
        const inner = renderBlocks(node.children || [], '').trim();
        if (inner) parts.push(inner.split('\n').map((l) => ('> ' + l).replace(/\s+$/, '')).join('\n'));
        break;
      }
      case 'ul': { const list = renderList(node, false, pad); if (list) parts.push(list); break; }
      case 'ol': { const list = renderList(node, true, pad); if (list) parts.push(list); break; }
      case 'table': { const table = renderTable(node); if (table) parts.push(table); break; }
      case 'figcaption': {
        const text = renderInline(node.children || []).replace(/\s+/g, ' ').trim();
        if (text) parts.push(pad + '*' + text + '*');
        break;
      }
      case 'li': {
        const text = renderInline(node.children || []).replace(/\s+/g, ' ').trim();
        if (text) parts.push(pad + '- ' + text);
        break;
      }
      default: {
        if (MEDIA_TAGS.has(node.tag)) {
          const media = renderMedia(node);
          if (media) parts.push(pad + media);
          break;
        }
        const inner = renderBlocks(node.children || [], pad).trim();
        if (inner) parts.push(inner);
      }
    }
  }
  flushInline();
  return parts.join('\n\n');
}

/** 扫描标签时跳过的整块内容（注释、脚本、样式、textarea）。 */
const SCAN_RE = /<!--[\s\S]*?-->|<(script|style|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/gi;

/** 找到某个容器标签的开标签位置。 */
function findContainerStart(html, tag, attrsTest) {
  const re = new RegExp('<' + tag + '((?:"[^"]*"|\'[^\']*\'|[^>])*?)>', 'gi');
  let match;
  while ((match = re.exec(html)) !== null) {
    if (attrsTest(match[1] || '')) return { tag, end: re.lastIndex };
  }
  return null;
}

/** 从开标签位置按同名标签深度计数，截出容器内部 HTML。 */
function sliceContainer(html, open) {
  SCAN_RE.lastIndex = open.end;
  let depth = 1;
  let match;
  while ((match = SCAN_RE.exec(html)) !== null) {
    if (match[1] !== undefined || match[0].startsWith('<!--')) continue; // script/style/注释整块跳过
    if ((match[3] || '').toLowerCase() !== open.tag) continue;
    if (match[2]) {
      depth -= 1;
      if (depth === 0) return html.slice(open.end, match.index);
    } else if (!match[4]) {
      depth += 1;
    }
  }
  return html.slice(open.end);
}

/** 属性等值匹配（支持单引号/双引号/无引号）。 */
function attrEquals(name, value) {
  const re = new RegExp('\\b' + name + '\\s*=\\s*(?:"' + value + '"|\'' + value + '\'|' + value + ')(?=[\\s/>]|$)', 'i');
  return (attrs) => re.test(attrs);
}

/** 属性值里包含某个 class（按空白分词）。 */
function attrHasWord(name, value) {
  const re = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  const wordRe = new RegExp('(?:^|\\s)' + value + '(?:\\s|$)');
  return (attrs) => {
    const m = re.exec(attrs);
    if (!m) return false;
    const raw = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : (m[3] || ''));
    return wordRe.test(raw);
  };
}

/**
 * 正文容器候选，按优先级排列。
 * `js_content` 是微信一贯的正文 id；后两个是结构与分享页的兜底。
 */
const CONTENT_MARKERS = [
  { tag: 'div', test: attrEquals('id', 'js_content') },
  { tag: 'div', test: attrHasWord('class', 'rich_media_content') },
  { tag: 'div', test: attrEquals('id', 'js_article') },
];

/**
 * 按深度计数截出正文片段（比贪婪正则可靠：正文含大量嵌套 div/section）。
 * @param {string} html
 * @returns {string | null} 找不到任何容器时返回 null
 */
export function extractContentHtml(html) {
  if (typeof html !== 'string' || !html) return null;
  for (const marker of CONTENT_MARKERS) {
    const open = findContainerStart(html, marker.tag, marker.test);
    if (open) return sliceContainer(html, open);
  }
  return null;
}

/**
 * 去掉整体包裹的引号。
 * 微信把公众号名写成 `htmlDecode("\x26quot;名称\x26quot;")`，解码后名称本身还带着一对引号。
 * @param {string} value
 * @returns {string}
 */
function stripWrappingQuotes(value) {
  const text = value.trim();
  if (text.length >= 2
    && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/** 从 meta 或 JS 变量里取第一个命中的值。 */
function firstMatch(html, patterns) {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1] !== undefined) {
      const value = stripWrappingQuotes(decodeEntities(unescapeJs(m[1])));
      if (value) return value;
    }
  }
  return null;
}

/** 发布时间：`var ct` 优先，其次 og:release_date 与页面上的 publish_time。 */
function extractPublishedAt(html) {
  const ctRaw = firstMatch(html, [
    /var\s+ct\s*=\s*"(\d{9,})"/i,
    /var\s+ct\s*=\s*'(\d{9,})'/i,
    /var\s+ct\s*=\s*(\d{9,})/i,
  ]);
  if (ctRaw) {
    const date = new Date(Number(ctRaw) * 1000);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const release = firstMatch(html, [
    /property\s*=\s*"og:release_date"\s+content\s*=\s*"([^"]*)"/i,
    /content\s*=\s*"([^"]*)"\s+property\s*=\s*"og:release_date"/i,
  ]);
  if (release) {
    const date = new Date(release.replace(/-/g, '/').replace(/\.\d+Z?$/, ''));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const shown = firstMatch(html, [
    /id\s*=\s*"publish_time"[^>]*>([^<]{4,})</i,
  ]);
  if (shown) {
    const date = new Date(shown.replace(/-/g, '/'));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

/**
 * 中英混排字数统计：中日韩字符按字计，拉丁语按词计。
 * 代码块、图片链接与 Markdown 标记不参与计数。
 * @param {string} markdown
 * @returns {number}
 */
export function countWords(markdown) {
  const text = String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*`~|]/g, ' ')
    .replace(/\s+/g, ' ');
  const cjkRe = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
  const cjk = (text.match(cjkRe) || []).length;
  const latin = (text.replace(cjkRe, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’._-]*/g) || []).length;
  return cjk + latin;
}

/** 收集正文里的图片地址（去重、保序）。 */
function collectImages(markdown) {
  const seen = new Set();
  const images = [];
  const re = /!\[[^\]]*\]\(([^)\s]+)/g;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    images.push(m[1]);
  }
  return images;
}

/**
 * 解析微信文章 HTML（纯函数）。
 * @param {string} html
 * @param {string} [url]
 * @returns {object} 解析结果
 */
export function parseArticle(html, url) {
  if (typeof html !== 'string' || !html.trim()) {
    throw new ArticleFetchError('页面内容为空', { code: 'empty-body' });
  }

  const blocked = /环境异常|wappoc_appmsgcaptcha/.test(html);
  const removed = /该内容已被发布者删除|此内容因违规无法查看|该内容已被删除|账号已迁移|内容已被删除/.test(html);
  const invalidLink = /参数错误|链接已过期|该链接已过期|链接地址错误|链接已失效/.test(html);

  const title = firstMatch(html, [
    /property\s*=\s*"og:title"\s+content\s*=\s*"([^"]*)"/i,
    /content\s*=\s*"([^"]*)"\s+property\s*=\s*"og:title"/i,
    /var\s+msg_title\s*=\s*'([^']*)'/i,
    /var\s+msg_title\s*=\s*"([^"]*)"/i,
  ]) || (firstMatch(html, [/<title[^>]*>([\s\S]*?)<\/title>/i]) || '')
    .replace(/\s*[-|｜]\s*微信公众平台\s*$/, '')
    .trim();

  const account = firstMatch(html, [
    /var\s+nickname\s*=\s*htmlDecode\s*\(\s*"([^"]*)"\s*\)/i,
    /var\s+nickname\s*=\s*htmlDecode\s*\(\s*'([^']*)'\s*\)/i,
    /var\s+nickname\s*=\s*"([^"]*)"/i,
    /var\s+nickname\s*=\s*'([^']*)'/i,
    /var\s+user_name\s*=\s*"([^"]*)"/i,
    /id\s*=\s*"js_name"[^>]*>([\s\S]*?)<\//i,
    /property\s*=\s*"og:article:author"\s+content\s*=\s*"([^"]*)"/i,
  ]);

  const author = firstMatch(html, [
    /var\s+author\s*=\s*"([^"]*)"/i,
    /var\s+author\s*=\s*'([^']*)'/i,
    /var\s+author_name\s*=\s*"([^"]*)"/i,
  ]) || account;

  const publishedAt = extractPublishedAt(html);

  const cover = firstMatch(html, [
    /property\s*=\s*"og:image"\s+content\s*=\s*"([^"]*)"/i,
    /var\s+msg_cdn_url\s*=\s*"([^"]*)"/i,
  ]);

  const contentHtml = extractContentHtml(html);
  const nodes = contentHtml ? buildTree(contentHtml) : [];
  const markdown = renderBlocks(nodes)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const images = collectImages(markdown);
  const wordCount = countWords(markdown);
  const readingMinutes = Math.max(1, Math.round(wordCount / 400));
  const reason = blocked
    ? 'blocked'
    : removed
      ? 'removed'
      : invalidLink
        ? 'invalid-link'
        : !contentHtml
          ? 'no-content'
          : (!markdown ? 'empty' : 'ok');

  return {
    url: url || '',
    title,
    account: account || '',
    author: author || '',
    publishedAt,
    cover,
    markdown,
    wordCount,
    imageCount: images.length,
    images,
    readingMinutes,
    empty: markdown.length === 0,
    blocked,
    removed,
    reason,
  };
}

/** 等待若干毫秒，可被取消信号打断。 */
function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      done();
    }
    function onAbort() { finish(); }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 按解析结果决定是抛出明确错误还是返回文章。 */
function ensureReadable(article) {
  switch (article.reason) {
    case 'blocked':
      throw new ArticleFetchError('触发微信环境验证（页面返回“环境异常”），请稍后重试。', { code: 'blocked' });
    case 'removed':
      throw new ArticleFetchError('文章不可访问：已被发布者删除或因违规无法查看。', { code: 'removed' });
    case 'invalid-link':
      throw new ArticleFetchError(
        '链接无效或已过期：微信返回“参数错误”。请确认链接完整（形如 https://mp.weixin.qq.com/s/xxxxxxxx）。',
        { code: 'invalid-link' },
      );
    case 'no-content':
      throw new ArticleFetchError(
        '未能定位正文容器（页面缺少 js_content），该链接可能是分享页、视频页或需要微信内打开。',
        { code: 'not-article' },
      );
    case 'empty':
      throw new ArticleFetchError('未能提取正文：页面结构可能已变化。', { code: 'empty-body' });
    default:
      return article;
  }
}

/** 单次抓取：超时、取消、状态码与重定向主机都在这里判定。 */
async function fetchOnce(parsed, options) {
  const { timeoutMs, userAgent, signal } = options;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let response;
  try {
    response = await fetch(parsed.href, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': userAgent,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
  } catch (error) {
    if (timedOut) {
      throw new ArticleFetchError('抓取超时（' + timeoutMs + 'ms）：' + parsed.href, {
        code: 'timeout', retryable: true, cause: error,
      });
    }
    if (signal && signal.aborted) {
      throw new ArticleFetchError('抓取已取消。', { code: 'aborted', cause: error });
    }
    const reason = error && error.message ? error.message : String(error);
    throw new ArticleFetchError('抓取失败：' + reason, { code: 'network', retryable: true, cause: error });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!response.ok) {
    const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
    throw new ArticleFetchError(
      '抓取失败：HTTP ' + response.status + ' ' + (response.statusText || ''),
      { code: 'http-error', status: response.status, retryable },
    );
  }

  const finalUrl = response.url || parsed.href;
  const finalHost = (() => {
    try { return new URL(finalUrl).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; }
  })();
  if (finalHost && !ALLOWED_HOSTS.has(finalHost)) {
    throw new ArticleFetchError(
      '抓取被重定向到非文章页（' + finalHost + '），通常是微信环境校验，请稍后重试：' + finalUrl,
      { code: 'redirected', retryable: true },
    );
  }

  const html = await response.text();
  return ensureReadable(parseArticle(html, finalUrl));
}

/**
 * 抓取并解析一篇微信公众号文章。
 * @param {string | URL} url
 * @param {{ timeoutMs?: number, userAgent?: string, signal?: AbortSignal,
 *           retries?: number, retryDelayMs?: number }} [options]
 *   `retries` 为额外重试次数（仅传输层失败与 5xx/429/408 会重试）。
 * @returns {Promise<object>}
 */
export async function fetchArticle(url, options) {
  const opts = options || {};
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 30000;
  const userAgent = opts.userAgent || DEFAULT_USER_AGENT;
  const retries = Number.isInteger(opts.retries) && opts.retries > 0 ? opts.retries : 0;
  const retryDelayMs = Number.isFinite(opts.retryDelayMs) && opts.retryDelayMs >= 0 ? opts.retryDelayMs : 500;
  const signal = opts.signal;
  const parsed = normalizeArticleUrl(url);

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal && signal.aborted) {
      throw new ArticleFetchError('抓取已取消。', { code: 'aborted' });
    }
    try {
      return await fetchOnce(parsed, { timeoutMs, userAgent, signal });
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ArticleFetchError && error.retryable;
      if (!retryable || attempt === retries) throw error;
      await sleep(retryDelayMs * (2 ** attempt), signal);
    }
  }
  throw lastError;
}

/**
 * 按段落边界截断 Markdown。
 *
 * 行为：优先在 `\n\n` 处切；切点太靠前时退化为换行处；补齐未闭合的代码围栏；
 * 末尾附上省略字数与后续小节标题，模型据此知道还有什么内容。
 *
 * @param {string} text
 * @param {number} maxChars 上限；<= 0 或非有限值时表示不截断
 * @returns {{ text: string, truncated: boolean, originalChars: number,
 *             omittedChars: number, remainingHeadings: string[] }}
 */
export function truncateMarkdown(text, maxChars) {
  const source = typeof text === 'string' ? text : '';
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0;
  if (!limit || source.length <= limit) {
    return { text: source, truncated: false, originalChars: source.length, omittedChars: 0, remainingHeadings: [] };
  }

  let cut = source.lastIndexOf('\n\n', limit);
  if (cut < limit * 0.5) cut = source.lastIndexOf('\n', limit);
  if (cut < limit * 0.5) cut = limit;

  let head = source.slice(0, cut).replace(/\s+$/, '');
  const fences = (head.match(/^```/gm) || []).length;
  if (fences % 2 === 1) head += '\n```';

  const rest = source.slice(cut);
  const remainingHeadings = [];
  const headingRe = /^#{1,6}\s+(.+?)\s*$/gm;
  let m;
  while ((m = headingRe.exec(rest)) !== null) {
    remainingHeadings.push(m[1].replace(/[#*`]/g, '').trim());
    if (remainingHeadings.length >= 8) break;
  }

  const omittedChars = source.length - cut;
  const note = '（正文已截断：省略约 ' + omittedChars + ' 字'
    + (remainingHeadings.length ? '，后续小节：' + remainingHeadings.join('、') : '')
    + '。需要完整正文可改用 saveToFile=true，或调大 maxChars。）';
  return {
    text: head + '\n\n---\n\n' + note,
    truncated: true,
    originalChars: source.length,
    omittedChars,
    remainingHeadings,
  };
}

/**
 * 元信息行：工具渲染与文件落盘共用，避免两处格式漂移。
 * @param {object} article
 * @returns {string}
 */
export function articleMetaLine(article) {
  const parts = [];
  if (article.account) parts.push('公众号：' + article.account);
  if (article.author && article.author !== article.account) parts.push('作者：' + article.author);
  if (article.publishedAt) parts.push('发布时间：' + article.publishedAt);
  if (article.wordCount) parts.push('字数：约 ' + article.wordCount);
  if (article.readingMinutes) parts.push('阅读：约 ' + article.readingMinutes + ' 分钟');
  if (article.imageCount) parts.push('图片：' + article.imageCount + ' 张');
  if (article.cover) parts.push('封面：' + article.cover);
  return parts.join(' ｜ ');
}

/**
 * 把解析结果渲染成适合模型阅读的 Markdown 全文。
 * @param {object} article
 * @returns {string}
 */
export function formatArticle(article) {
  const blocks = ['# ' + (article.title || '(无标题)')];
  const meta = articleMetaLine(article);
  if (meta) blocks.push(meta);
  if (article.url) blocks.push('原文：' + article.url);
  return blocks.join('\n\n') + '\n\n---\n\n' + (article.markdown || '');
}