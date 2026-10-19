/**
 * 测试夹具：假的 Cordis 上下文、fetch 桩与仓库自带样本页面。
 * 只依赖 Node 内置能力，不需要 DSH 运行时。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../index.js';

export const here = dirname(fileURLToPath(import.meta.url));

/** 一个格式合法（但不会真的被抓取）的文章链接。 */
export const ARTICLE_URL = 'https://mp.weixin.qq.com/s/AbCdEf123';

/** 读取 test/fixtures 下的样本页面。 */
export function fixture(name) {
  return readFileSync(join(here, 'fixtures', name), 'utf8');
}

/**
 * 构造最小可用的 Cordis 上下文替身。
 * `ctx.get` 的语义与 cordis 4 的软查询一致：拿不到就返回 undefined。
 */
export function createHarness(options = {}) {
  const tools = [];
  const sections = [];
  const warnings = [];
  const logger = { warn: (message) => warnings.push(String(message)) };
  const registry = options.registry;
  const ctx = {
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    logger,
    effect(callback) { callback(); },
    get(name) {
      if (name === 'systemPrompt') {
        return { section(section) { sections.push(section); return () => {}; } };
      }
      if (name === 'workspaceRegistry') return registry;
      if (name === 'logger') return logger;
      return undefined;
    },
  };
  return { ctx, tools, sections, warnings };
}

/** 应用插件并返回夹具（`options.config` 为插件配置，`options.registry` 为工作区注册表替身）。 */
export function register(options = {}) {
  const harness = createHarness({ registry: options.registry });
  apply(harness.ctx, options.config);
  return harness;
}

/**
 * 替换 globalThis.fetch。
 * handler 返回字符串（HTML）或 `{ html, ok, status, statusText, url }`。
 */
export function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const result = await handler(String(url), calls.length);
    const extra = typeof result === 'string' ? { html: result } : result;
    return {
      ok: extra.ok === undefined ? true : extra.ok,
      status: extra.status === undefined ? 200 : extra.status,
      statusText: extra.statusText === undefined ? 'OK' : extra.statusText,
      url: extra.url === undefined ? String(url) : extra.url,
      text: async () => extra.html,
    };
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}