/** 抓取层测试：重试策略、状态码、重定向与超时。 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchArticle } from '../lib/parser.js';
import { ARTICLE_URL, fixture, stubFetch } from './helpers.mjs';

const ARTICLE_HTML = fixture('article.html');

test('传输层失败后按 retries 重试并成功', async () => {
  let attempt = 0;
  const stub = stubFetch(() => {
    attempt += 1;
    if (attempt === 1) throw new Error('socket hang up');
    return ARTICLE_HTML;
  });
  try {
    const article = await fetchArticle(ARTICLE_URL, { retries: 2, retryDelayMs: 1 });
    assert.equal(article.title, '测试文章：解析器笔记');
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test('5xx/429 重试，找到尽头后抛错；404 不重试', async () => {
  const server = stubFetch(() => ({ html: 'boom', ok: false, status: 503, statusText: 'Service Unavailable' }));
  try {
    await assert.rejects(
      () => fetchArticle(ARTICLE_URL, { retries: 2, retryDelayMs: 1 }),
      (error) => error.code === 'http-error' && error.status === 503 && error.retryable === true,
    );
    assert.equal(server.calls.length, 3);
  } finally {
    server.restore();
  }

  const notFound = stubFetch(() => ({ html: 'nope', ok: false, status: 404, statusText: 'Not Found' }));
  try {
    await assert.rejects(
      () => fetchArticle(ARTICLE_URL, { retries: 2, retryDelayMs: 1 }),
      (error) => error.status === 404 && error.retryable === false,
    );
    assert.equal(notFound.calls.length, 1);
  } finally {
    notFound.restore();
  }
});

test('验证页、删除页与非正文页都不重试', async () => {
  const verify = stubFetch(() => fixture('verify.html'));
  try {
    await assert.rejects(
      () => fetchArticle(ARTICLE_URL, { retries: 3, retryDelayMs: 1 }),
      (error) => error.code === 'blocked' && error.retryable === false,
    );
    assert.equal(verify.calls.length, 1);
  } finally {
    verify.restore();
  }

  const removed = stubFetch(() => fixture('removed.html'));
  try {
    await assert.rejects(
      () => fetchArticle(ARTICLE_URL, { retries: 3, retryDelayMs: 1 }),
      (error) => error.code === 'removed',
    );
    assert.equal(removed.calls.length, 1);
  } finally {
    removed.restore();
  }

  const share = stubFetch(() => fixture('no-content.html'));
  try {
    await assert.rejects(
      () => fetchArticle(ARTICLE_URL, { retries: 3, retryDelayMs: 1 }),
      (error) => error.code === 'not-article',
    );
    assert.equal(share.calls.length, 1);
  } finally {
    share.restore();
  }

  const dead = stubFetch(() => '<html><body><div class="weui-msg">参数错误</div></body></html>');
  try {
    await assert.rejects(
      () => fetchArticle(ARTICLE_URL, { retries: 3, retryDelayMs: 1 }),
      (error) => error.code === 'invalid-link',
    );
    assert.equal(dead.calls.length, 1);
  } finally {
    dead.restore();
  }
});

test('被重定向到站外时给出明确错误', async () => {
  const stub = stubFetch(() => ({ html: ARTICLE_HTML, url: 'https://weixin110.qq.com/verify' }));
  try {
    await assert.rejects(
      () => fetchArticle(ARTICLE_URL, { retries: 0 }),
      (error) => error.code === 'redirected',
    );
  } finally {
    stub.restore();
  }
});

test('超时归因为超时而不是普通网络错误', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  try {
    await assert.rejects(
      () => fetchArticle(ARTICLE_URL, { timeoutMs: 10, retries: 0 }),
      (error) => error.code === 'timeout' && error.retryable === true,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('已取消的 signal 直接拒绝，不发起请求', async () => {
  const controller = new AbortController();
  controller.abort();
  const stub = stubFetch(() => ARTICLE_HTML);
  try {
    await assert.rejects(
      () => fetchArticle(ARTICLE_URL, { signal: controller.signal, retries: 0 }),
      (error) => error.code === 'aborted',
    );
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});