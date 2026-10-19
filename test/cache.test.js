/** 缓存行为测试：TTL、容量淘汰与关闭开关。 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture, register, stubFetch } from './helpers.mjs';

const ARTICLE_HTML = fixture('article.html');
const URL_A = 'https://mp.weixin.qq.com/s/ArticleA';
const URL_B = 'https://mp.weixin.qq.com/s/ArticleB';

test('TTL 到期后重新抓取', async () => {
  const harness = register({ config: { cacheTtlMs: 5 } });
  const tool = harness.tools[0];
  const stub = stubFetch(() => ARTICLE_HTML);
  try {
    const first = await tool.execute({ url: URL_A }, {});
    assert.equal(first.cacheHit, false);

    await new Promise((done) => { setTimeout(done, 25); });

    const second = await tool.execute({ url: URL_A }, {});
    assert.equal(second.cacheHit, false);
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test('超过容量上限时淘汰最旧条目', async () => {
  const harness = register({ config: { maxCacheEntries: 1 } });
  const tool = harness.tools[0];
  const stub = stubFetch(() => ARTICLE_HTML);
  try {
    await tool.execute({ url: URL_A }, {});
    await tool.execute({ url: URL_B }, {});
    const again = await tool.execute({ url: URL_A }, {});
    assert.equal(again.cacheHit, false);
    assert.equal(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

test('cacheTtlMs=0 关闭缓存', async () => {
  const harness = register({ config: { cacheTtlMs: 0 } });
  const tool = harness.tools[0];
  const stub = stubFetch(() => ARTICLE_HTML);
  try {
    const first = await tool.execute({ url: URL_A }, {});
    const second = await tool.execute({ url: URL_A }, {});
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, false);
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});