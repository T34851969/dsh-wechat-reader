/** 工具层测试：注册、参数校验、规范结果与 schema 一致性、落盘与工作区解析。 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveSaveTarget, resolveWorkspaceRoot, safeFileName } from '../index.js';
import { ARTICLE_URL, fixture, register, stubFetch } from './helpers.mjs';

const ARTICLE_HTML = fixture('article.html');

test('注册 weixin_read、参数 schema 与系统提示段', () => {
  const harness = register();
  assert.equal(harness.tools.length, 1);

  const tool = harness.tools[0];
  assert.equal(tool.name, 'weixin_read');
  assert.deepEqual(tool.parameters.required, ['url']);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(
    Object.keys(tool.parameters.properties),
    ['url', 'maxChars', 'saveToFile', 'saveDir', 'forceRefresh'],
  );

  assert.equal(harness.sections.length, 1);
  assert.equal(harness.sections[0].name, 'tool:wechat-reader');
  assert.ok(harness.sections[0].text.includes('weixin_read'));
});

test('规范结果与 output.schema 完全一致', async () => {
  const harness = register();
  const tool = harness.tools[0];
  const fetch = stubFetch(() => ARTICLE_HTML);
  try {
    const value = await tool.execute({ url: ARTICLE_URL }, {});

    assert.deepEqual(Object.keys(value).sort(), Object.keys(tool.output.schema.properties).sort());
    assert.equal(value.title, '测试文章：解析器笔记');
    assert.equal(value.account, '示例公众号');
    assert.equal(value.author, '张三');
    assert.equal(value.sourceUrl, ARTICLE_URL);
    assert.equal(value.truncated, false);
    assert.equal(value.omittedChars, 0);
    assert.deepEqual(value.remainingHeadings, []);
    assert.equal(value.savedTo, '');
    assert.equal(value.cacheHit, false);
    assert.equal(value.bodyChars, value.markdown.length);
    assert.equal(value.imageCount, 1);
    assert.equal(value.images.length, 1);
    assert.ok(value.wordCount > 0);
    assert.ok(value.readingMinutes >= 1);

    const rendered = tool.output.render({}, value);
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].type, 'text');
    assert.ok(rendered[0].text.includes('# 测试文章：解析器笔记'));
    assert.ok(rendered[0].text.includes('公众号：示例公众号'));
    assert.ok(rendered[0].text.includes('语音后面的段落应该还在。'));
  } finally {
    fetch.restore();
  }
});

test('超过 maxChars 时截断并标注', async () => {
  const harness = register();
  const tool = harness.tools[0];
  const fetch = stubFetch(() => ARTICLE_HTML);
  try {
    const value = await tool.execute({ url: ARTICLE_URL, maxChars: 120 }, {});
    assert.equal(value.truncated, true);
    assert.ok(value.omittedChars > 0);
    assert.equal(value.bodyChars > value.markdown.length, true);
    assert.ok(value.markdown.includes('正文已截断'));
  } finally {
    fetch.restore();
  }
});

test('缓存命中与 forceRefresh', async () => {
  const harness = register();
  const tool = harness.tools[0];
  const fetch = stubFetch(() => ARTICLE_HTML);
  try {
    const first = await tool.execute({ url: ARTICLE_URL }, {});
    const second = await tool.execute({ url: ARTICLE_URL }, {});
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.equal(fetch.calls.length, 1);

    // 带 #wechat_redirect 的同一篇文章命中同一个缓存键
    const alias = await tool.execute({ url: ARTICLE_URL + '#wechat_redirect' }, {});
    assert.equal(alias.cacheHit, true);
    assert.equal(fetch.calls.length, 1);

    const refreshed = await tool.execute({ url: ARTICLE_URL, forceRefresh: true }, {});
    assert.equal(refreshed.cacheHit, false);
    assert.equal(fetch.calls.length, 2);
  } finally {
    fetch.restore();
  }
});

test('参数校验与主机白名单', async () => {
  const harness = register();
  const tool = harness.tools[0];

  await assert.rejects(() => tool.execute(null, {}), /参数必须是对象/);
  await assert.rejects(() => tool.execute([], {}), /参数必须是对象/);
  await assert.rejects(() => tool.execute({}, {}), /缺少参数 url/);
  await assert.rejects(() => tool.execute({ url: '   ' }, {}), /缺少参数 url/);
  await assert.rejects(() => tool.execute({ url: ARTICLE_URL, nope: 1 }, {}), /不支持的参数/);
  await assert.rejects(() => tool.execute({ url: ARTICLE_URL, maxChars: 1.5 }, {}), /maxChars/);
  await assert.rejects(() => tool.execute({ url: ARTICLE_URL, maxChars: -1 }, {}), /maxChars/);
  await assert.rejects(() => tool.execute({ url: ARTICLE_URL, saveToFile: 'yes' }, {}), /saveToFile/);
  await assert.rejects(() => tool.execute({ url: ARTICLE_URL, saveDir: 5 }, {}), /saveDir/);
  await assert.rejects(() => tool.execute({ url: ARTICLE_URL, forceRefresh: 'yes' }, {}), /forceRefresh/);
  await assert.rejects(() => tool.execute({ url: 'https://example.com/s/a' }, {}), /mp\.weixin\.qq\.com/);
});

test('saveToFile 写入会话工作区，且入参 saveDir 覆盖配置', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-reader-'));
  const harness = register({ registry: { list: () => [{ sessionIds: ['s1'], path: dir }] } });
  const tool = harness.tools[0];
  const fetch = stubFetch(() => ARTICLE_HTML);
  const exec = { agent: { session: { id: 's1' } } };
  try {
    const value = await tool.execute({ url: ARTICLE_URL, saveToFile: true }, exec);
    assert.equal(value.savedTo.startsWith(join(dir, 'weixin-articles')), true);
    const saved = await readFile(value.savedTo, 'utf8');
    assert.ok(saved.startsWith('# 测试文章：解析器笔记'));
    assert.ok(saved.includes('语音后面的段落应该还在。'));
    assert.ok(saved.includes('公众号：示例公众号'));

    const custom = await tool.execute({ url: ARTICLE_URL, saveToFile: true, saveDir: join(dir, 'custom') }, exec);
    assert.equal(custom.savedTo.startsWith(join(dir, 'custom')), true);

    const skipped = await tool.execute({ url: ARTICLE_URL, saveToFile: false }, exec);
    assert.equal(skipped.savedTo, '');
  } finally {
    fetch.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test('配置默认开启保存时写入，模型显式关闭则不写', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-reader-'));
  const harness = register({ config: { saveToFile: true } });
  const tool = harness.tools[0];
  const fetch = stubFetch(() => ARTICLE_HTML);
  try {
    const value = await tool.execute({ url: ARTICLE_URL, saveDir: dir }, {});
    assert.equal(value.savedTo.startsWith(dir), true);

    const off = await tool.execute({ url: ARTICLE_URL, saveDir: dir, saveToFile: false }, {});
    assert.equal(off.savedTo, '');
  } finally {
    fetch.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test('显式保存失败时报错，配置默认保存失败时只告警', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-reader-'));
  const blocker = join(dir, 'blocker');
  await writeFile(blocker, 'x');
  const unusable = join(blocker, 'sub');

  const explicit = register();
  const fetch = stubFetch(() => ARTICLE_HTML);
  try {
    await assert.rejects(
      () => explicit.tools[0].execute({ url: ARTICLE_URL, saveToFile: true, saveDir: unusable }, {}),
      /保存正文失败/,
    );
  } finally {
    fetch.restore();
  }

  const byConfig = register({ config: { saveToFile: true } });
  const fetch2 = stubFetch(() => ARTICLE_HTML);
  try {
    const value = await byConfig.tools[0].execute({ url: ARTICLE_URL, saveDir: unusable }, {});
    assert.equal(value.savedTo, '');
    assert.equal(byConfig.warnings.length, 1);
    assert.match(byConfig.warnings[0], /保存正文失败/);
  } finally {
    fetch2.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test('配置校验：类型错误、未知键与合法边界', () => {
  assert.throws(() => register({ config: { maxChars: '60000' } }), /maxChars/);
  assert.throws(() => register({ config: { saveToFile: 1 } }), /saveToFile/);
  assert.throws(() => register({ config: { retries: -1 } }), /retries/);
  assert.throws(() => register({ config: { nope: 1 } }), /未知配置项/);
  assert.doesNotThrow(() => register({ config: { maxChars: 0, cacheTtlMs: 0, retries: 0 } }));
});

test('resolveWorkspaceRoot 对缺失服务、未登记会话与异常结构都容错', () => {
  const withRegistry = (registry) => ({ get: (name) => (name === 'workspaceRegistry' ? registry : undefined) });
  const exec = { agent: { session: { id: 's1' } } };

  assert.equal(resolveWorkspaceRoot(withRegistry(undefined), exec), '');
  assert.equal(resolveWorkspaceRoot(withRegistry({}), exec), '');
  assert.equal(
    resolveWorkspaceRoot(withRegistry({ list: () => [{ sessionIds: ['s1'], path: '/tmp/ws' }] }), exec),
    '/tmp/ws',
  );
  assert.equal(
    resolveWorkspaceRoot(withRegistry({ list: () => [{ sessionIds: ['other'], path: '/tmp/ws' }] }), exec),
    '',
  );
  assert.equal(resolveWorkspaceRoot(withRegistry({ list: () => 'nope' }), exec), '');
  assert.equal(resolveWorkspaceRoot(withRegistry({ list: () => { throw new Error('boom'); } }), exec), '');
  assert.equal(
    resolveWorkspaceRoot(withRegistry({ list: () => [{ get sessionIds() { throw new Error('x'); } }] }), exec),
    '',
  );
  assert.equal(resolveWorkspaceRoot(withRegistry({ list: () => [{ sessionIds: ['s1'], path: '/tmp/ws' }] }), {}), '');
});

test('resolveSaveTarget 的优先级', () => {
  const empty = { get: () => undefined };
  assert.equal(resolveSaveTarget({ saveDir: '' }, { saveDir: '' }, empty, {}), join(process.cwd(), 'weixin-articles'));
  assert.equal(resolveSaveTarget({ saveDir: '/tmp/cfg' }, { saveDir: '' }, empty, {}), '/tmp/cfg');
  assert.equal(resolveSaveTarget({ saveDir: '/tmp/cfg' }, { saveDir: '/tmp/call' }, empty, {}), '/tmp/call');
});

test('safeFileName 去掉非法字符并用哈希区分同名文章', () => {
  const first = safeFileName({
    title: 'A/B: C?',
    publishedAt: '2026-09-21T08:30:00.000Z',
    url: 'https://mp.weixin.qq.com/s/a',
  });
  const second = safeFileName({
    title: 'A/B: C?',
    publishedAt: '2026-09-21T08:30:00.000Z',
    url: 'https://mp.weixin.qq.com/s/b',
  });

  assert.match(first, /^2026-09-21-A B C-[0-9a-f]{8}\.md$/);
  assert.notEqual(first, second);
  assert.match(safeFileName({}), /^weixin-article-[0-9a-f]{8}\.md$/);
});