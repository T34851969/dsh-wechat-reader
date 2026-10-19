/** lib/parser.js 的离线单元测试：元信息、结构渲染、截断与错误分类。 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ArticleFetchError,
  articleMetaLine,
  countWords,
  decodeEntities,
  extractContentHtml,
  formatArticle,
  formatLocalTime,
  getAttr,
  localDateStamp,
  normalizeArticleUrl,
  parseArticle,
  truncateMarkdown,
  unescapeJs,
} from '../lib/parser.js';
import { ARTICLE_URL, fixture } from './helpers.mjs';

const ARTICLE_HTML = fixture('article.html');

test('decodeEntities 处理命名实体与数字实体', () => {
  assert.equal(decodeEntities('a&amp;b&lt;c&gt;d'), 'a&b<c>d');
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
  assert.equal(decodeEntities('&nbsp;&hellip;'), ' \u2026');
  assert.equal(decodeEntities('&unknown;'), '&unknown;');
  assert.equal(decodeEntities('没有实体'), '没有实体');
});

test('unescapeJs 还原 \\x 与 \\u 转义', () => {
  assert.equal(unescapeJs('\\x26quot;示例\\x26quot;'), '&quot;示例&quot;');
  assert.equal(unescapeJs('\\u4f60\\u597d'), '你好');
  assert.equal(unescapeJs('a\\"b'), 'a"b');
  assert.equal(unescapeJs('没有转义'), '没有转义');
});

test('getAttr 兼容三种引号写法', () => {
  const attrs = ' id="js_content" class=\'x y\' data-lang=js';
  assert.equal(getAttr(attrs, 'id'), 'js_content');
  assert.equal(getAttr(attrs, 'class'), 'x y');
  assert.equal(getAttr(attrs, 'data-lang'), 'js');
  assert.equal(getAttr(attrs, 'missing'), null);
  assert.equal(getAttr('', 'id'), null);
});

test('normalizeArticleUrl 规范化链接并执行主机白名单', () => {
  assert.equal(normalizeArticleUrl('mp.weixin.qq.com/s/AbC').href, 'https://mp.weixin.qq.com/s/AbC');
  assert.equal(normalizeArticleUrl('http://mp.weixin.qq.com/s/AbC').href, 'https://mp.weixin.qq.com/s/AbC');
  assert.equal(
    normalizeArticleUrl('https://MP.WEIXIN.QQ.COM/s/AbC#wechat_redirect').href,
    'https://mp.weixin.qq.com/s/AbC',
  );
  assert.equal(
    normalizeArticleUrl('https://mp.weixin.qq.com/s?__biz=1&mid=2&idx=1&sn=abc').search,
    '?__biz=1&mid=2&idx=1&sn=abc',
  );
  assert.equal(normalizeArticleUrl(new URL('https://mp.weixin.qq.com/s/AbC')).href, 'https://mp.weixin.qq.com/s/AbC');

  assert.throws(
    () => normalizeArticleUrl('https://example.com/s/a'),
    (error) => error instanceof ArticleFetchError
      && error.code === 'unsupported-host'
      && error.retryable === false,
  );
  assert.throws(() => normalizeArticleUrl('ftp://mp.weixin.qq.com/s/a'), (error) => error.code === 'invalid-url');
  assert.throws(() => normalizeArticleUrl('   '), (error) => error.code === 'invalid-url');
  assert.throws(() => normalizeArticleUrl(undefined), (error) => error.code === 'invalid-url');
});

test('extractContentHtml 按深度截取，不被脚本里的假标签骗到', () => {
  const content = extractContentHtml(ARTICLE_HTML);
  assert.ok(content.includes('语音后面的段落应该还在。'));
  assert.equal(
    extractContentHtml('<body><div id="js_content"><div>a</div><div>b</div></div><div id="after">c</div></body>'),
    '<div>a</div><div>b</div>',
  );
  assert.equal(extractContentHtml('<div><div class="rich_media_content x">y</div></div>'), 'y');
  assert.equal(extractContentHtml('<html><body><p>x</p></body></html>'), null);
  assert.equal(extractContentHtml(''), null);
});

test('parseArticle 提取元信息并渲染正文结构', () => {
  const article = parseArticle(ARTICLE_HTML, ARTICLE_URL);

  assert.equal(article.title, '测试文章：解析器笔记');
  assert.equal(article.account, '示例公众号');
  assert.equal(article.author, '张三');
  assert.equal(article.cover, 'https://mmbiz.qpic.cn/cover.jpg');
  assert.equal(article.publishedAt, new Date(1758414600 * 1000).toISOString());
  assert.equal(article.url, ARTICLE_URL);
  assert.equal(article.reason, 'ok');
  assert.equal(article.imageCount, 1);
  assert.deepEqual(article.images, ['https://mmbiz.qpic.cn/img1.jpg?wx_fmt=png']);
  assert.ok(article.wordCount > 0);
  assert.ok(article.readingMinutes >= 1);

  const md = article.markdown;
  assert.ok(md.includes('## 小标题一'), md);
  assert.ok(md.includes('**加粗**'));
  assert.ok(md.includes('*斜体*'));
  assert.ok(md.includes('~~删除~~'));
  assert.ok(md.includes('`inline()`'));
  assert.ok(md.includes('- 项目一'));
  assert.ok(md.includes('    - 子项 A'), md);
  assert.ok(md.includes('3. 第三项'));
  assert.ok(md.includes('> 引用一段话。'));
  assert.ok(md.includes('```js'));
  assert.ok(md.includes('if (a < 2) console.log("ok");'));
  assert.ok(md.includes('| 列一 | 列二 |'));
  assert.ok(md.includes('| a\\|b | 2 |'));
  assert.ok(md.includes('![图一](https://mmbiz.qpic.cn/img1.jpg?wx_fmt=png)'));
  assert.ok(md.includes('*图一说明*'));
  assert.ok(md.includes('[嵌入内容](https://mp.weixin.qq.com/mp/videoplayer?vid=abc)'));
  assert.ok(md.includes('（语音消息：MzA=）'));
  assert.ok(md.includes('语音后面的段落应该还在。'));
  assert.ok(!md.includes('data:image'));
  assert.ok(!md.includes('这不是真正的结束标签'));
});

test('parseArticle 区分验证页、删除页、失效链接、非正文页与空正文', () => {
  assert.equal(parseArticle(fixture('verify.html')).reason, 'blocked');
  assert.equal(parseArticle(fixture('removed.html')).reason, 'removed');
  assert.equal(
    parseArticle('<html><body><div class="weui-msg">参数错误</div></body></html>').reason,
    'invalid-link',
  );
  assert.equal(parseArticle(fixture('no-content.html')).reason, 'no-content');
  assert.equal(
    parseArticle('<html><body><div id="js_content"><img src="data:image/gif;base64,AA"></div></body></html>').reason,
    'empty',
  );
  assert.throws(
    () => parseArticle('   '),
    (error) => error instanceof ArticleFetchError && error.code === 'empty-body',
  );
});

test('countWords 中英混排计数', () => {
  assert.equal(countWords('你好世界'), 4);
  assert.equal(countWords('hello world'), 2);
  assert.equal(countWords('你好 hello world'), 4);
  assert.equal(countWords('![img](https://x/y.png)'), 0);
  assert.equal(countWords('```\nconst a = 1;\n```'), 0);
  assert.equal(countWords(''), 0);
});

test('truncateMarkdown 按段落截断并标注省略内容', () => {
  const text = ['第一段'.repeat(20), '第二段'.repeat(20), '## 后续小节', '第三段'.repeat(20)].join('\n\n');
  const out = truncateMarkdown(text, 100);

  assert.equal(out.truncated, true);
  assert.equal(out.originalChars, text.length);
  assert.ok(out.omittedChars > 0);
  assert.ok(out.text.startsWith('第一段'));
  assert.ok(out.text.includes('正文已截断'));
  assert.deepEqual(out.remainingHeadings, ['后续小节']);
});

test('truncateMarkdown 未超限或关闭截断时原样返回', () => {
  const short = truncateMarkdown('短文本', 100);
  assert.equal(short.truncated, false);
  assert.equal(short.text, '短文本');
  assert.equal(short.omittedChars, 0);
  assert.deepEqual(short.remainingHeadings, []);

  const unlimited = truncateMarkdown('短文本', 0);
  assert.equal(unlimited.truncated, false);
  assert.equal(truncateMarkdown('短文本').truncated, false);
});

test('truncateMarkdown 在代码块内截断时补齐围栏', () => {
  const text = '```js\n' + 'const x = 1;\n'.repeat(40) + '```\n\n## 后续\n\n' + '尾'.repeat(200);
  const out = truncateMarkdown(text, 200);

  assert.equal(out.truncated, true);
  assert.equal((out.text.match(/^```/gm) || []).length % 2, 0);
  assert.deepEqual(out.remainingHeadings, ['后续']);
});

test('articleMetaLine 与 formatArticle 组合元信息', () => {
  const article = {
    title: 'T',
    account: '号',
    author: '张三',
    publishedAt: '2026-01-01T00:00:00.000Z',
    wordCount: 800,
    readingMinutes: 2,
    imageCount: 3,
    cover: 'https://x/cover.jpg',
    markdown: '正文',
    url: 'https://mp.weixin.qq.com/s/a',
  };
  const meta = articleMetaLine(article);
  assert.ok(meta.includes('公众号：号'));
  assert.ok(meta.includes('作者：张三'));
  assert.ok(meta.includes('阅读：约 2 分钟'));
  assert.ok(meta.includes('封面：https://x/cover.jpg'));
  // 发布时间按本机时区渲染，不再直接暴露 ISO UTC 原文（微信客户端也是本地时区显示）。
  assert.ok(meta.includes('发布时间：' + formatLocalTime(article.publishedAt)));
  assert.ok(!meta.includes('2026-01-01T00:00:00.000Z'), meta);

  const doc = formatArticle(article);
  assert.ok(doc.startsWith('# T'));
  assert.ok(doc.includes('正文'));
  assert.ok(doc.includes('原文：https://mp.weixin.qq.com/s/a'));

  // 作者与公众号同名时只显示一次
  assert.ok(!articleMetaLine({ account: '号', author: '号' }).includes('作者：'));
});

test('formatLocalTime 按本机时区渲染并写明偏移量', () => {
  const iso = '2026-10-14T17:00:00.000Z';
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const expected = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())} `
    + `(UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)})`;

  assert.equal(formatLocalTime(iso), expected);
  // 该 ISO 在 +08:00 下正是微信页面里的 create_time（2026-10-15 01:00）。
  assert.equal(formatLocalTime('').length, 0);
  assert.equal(formatLocalTime(undefined), '');
  assert.equal(formatLocalTime('not-a-date'), 'not-a-date');
});

test('localDateStamp 取本机时区日期，异常输入回退到前 10 个字符', () => {
  const iso = '2026-10-14T17:00:00.000Z';
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, '0');
  assert.equal(localDateStamp(iso), `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`);
  assert.equal(localDateStamp(''), '');
  // 只有日期的字符串按 UTC 解析，换算到本机时区可能落到前一天。
  const bare = new Date('2026-01-02');
  assert.equal(localDateStamp('2026-01-02'), `${bare.getFullYear()}-${pad(bare.getMonth() + 1)}-${pad(bare.getDate())}`);
  assert.equal(localDateStamp('garbage-input'), 'garbage-in');
});