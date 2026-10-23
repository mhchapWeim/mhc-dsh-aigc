import { chromium } from '../deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const out = new URL('./model-layout/', import.meta.url);
await mkdir(out, { recursive: true });
const models = Array.from({ length: 11 }, (_, i) => ({ id: `model-${i}`, name: i === 0 ? 'DeepSeek-v4-flash' : i === 1 ? 'DeepSeek-v4-pro' : `Qwen3.8-flash-${i}`, providerKind: 'LiteLLM',
  modelIdentifier: i === 0 ? 'deepseek-v4-flash' : `model-${i}`, baseUrl: 'https://litellm.boschhuayu-steering.com/v1', endpointPath: '/chat/completions', multiplier: i === 0 ? '0.5×' : '',
  isEnabled: i !== 2, isDefault: i === 0, temperature: 0.3, imageInput: { state: i === 0 ? 'supported' : i === 1 ? 'unsupported' : 'unknown', reason: i === 0 ? '来自上游明确披露的图片理解能力。' : '上游尚未披露更多信息。' },
  liteLlmCapabilities: { mode: 'chat', supportedFeatures: ['supports_function_calling', 'supports_reasoning', 'supports_parallel_function_calling', 'supports_prompt_caching', 'supports_response_schema', 'supports_native_streaming', 'supports_assistant_prefill', 'supports_system_messages', 'supports_tool_choice'], contextWindow: 1000000, maxOutputTokens: 393216 } }));
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1560, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  let empty = false;
  let failed = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem('aigc_hub_access_token', 'local-layout-fixture'); localStorage.setItem('aigc_hub_user', JSON.stringify({ id: 'fixture', name: '布局验收', employeeNo: 'preview', roles: ['管理员'], permissions: ['admin.view', 'model.manage'] })); });
  await page.route('https://aigcplatform.boschhuayu-steering.com/**', async route => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ status: path === '/api/models' && failed ? 500 : 200, json: path === '/api/models' ? failed ? { message: '模拟接口失败' } : empty ? [] : models : path === '/api/auth/sso/config' ? { enabled: false } : { items: [], users: [], roles: [], departments: [] } });
  });
  await page.goto(process.env.PREVIEW_URL ?? 'http://127.0.0.1:3107/admin/models');
  await page.getByRole('button', { name: 'DeepSeek-v4-flash', exact: true }).waitFor();
  await page.getByRole('combobox', { name: '模型列表分页每页条数' }).selectOption('10');
  await page.screenshot({ path: new URL('desktop.png', out).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true, animations: 'disabled' });
  const metrics = await page.evaluate(() => ({ rows: [...document.querySelectorAll('.model-registry-table tbody tr')].map(row => row.getBoundingClientRect().height), pageOverflow: document.documentElement.scrollWidth > innerWidth, tags: document.querySelector('.model-capability-summary .model-capability-tags')?.children.length }));
  assert(metrics.rows.every(height => height <= 90), JSON.stringify(metrics));
  assert.equal(metrics.pageOverflow, false);
  assert.equal(metrics.tags, 3);
  await page.getByRole('button', { name: '查看DeepSeek-v4-flash全部能力' }).click();
  const drawer = page.getByRole('dialog', { name: '模型详情' });
  await drawer.waitFor();
  assert.equal(await drawer.getByText('1,000,000', { exact: true }).count(), 1);
  await drawer.getByText('高级协议能力 · 7 项').click();
  await page.screenshot({ path: new URL('drawer.png', out).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '更多操作DeepSeek-v4-flash' }).click();
  await page.getByRole('button', { name: '授权DeepSeek-v4-flash' }).waitFor({ state: 'visible' });
  await page.screenshot({ path: new URL('menu.png', out).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'DeepSeek-v4-flash', exact: true }).click();
  models[0].imageInput.reason = '长文本验证\n' + 'x'.repeat(32768);
  await page.reload();
  await page.getByRole('button', { name: 'DeepSeek-v4-flash', exact: true }).click();
  const responsive = [];
  for (const viewport of [{ width: 1280, height: 540 }, { width: 390, height: 720 }]) {
    await page.setViewportSize(viewport);
    const sizes = await page.evaluate(() => { const d = document.querySelector('.model-details-drawer').getBoundingClientRect(); const b = document.querySelector('.model-details-body'); const f = document.querySelector('.model-details-footer').getBoundingClientRect(); return { width: d.width, height: d.height, right: d.right, bottom: f.bottom, bodyScroll: b.scrollHeight > b.clientHeight, pageOverflow: document.documentElement.scrollWidth > innerWidth }; });
    console.log(JSON.stringify({ viewport, sizes }));
    assert(sizes.width <= viewport.width && sizes.bottom <= viewport.height + 1 && sizes.bodyScroll);
    await page.screenshot({ path: new URL(`drawer-${viewport.width}.png`, out).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true, animations: 'disabled' });
    responsive.push({ viewport, ...sizes });
  }
  await page.keyboard.press('Escape');
  await page.screenshot({ path: new URL('mobile.png', out).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1560, height: 900 });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.screenshot({ path: new URL('dark.png', out).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索模型', exact: true }).fill('DeepSeek');
  assert.equal(await page.locator('.model-registry-table tbody tr').count(), 2);
  assert.equal(await page.getByRole('button', { name: '第 1 页' }).getAttribute('aria-current'), 'page');
  await page.getByRole('searchbox', { name: '搜索模型', exact: true }).fill('no-match-fixture');
  await page.getByText('没有匹配的模型', { exact: true }).waitFor();
  empty = true;
  await page.reload();
  await page.getByText('尚未配置模型', { exact: true }).waitFor();
  failed = true;
  await page.reload();
  await page.getByRole('alert').filter({ hasText: '模型配置加载失败' }).waitFor();
  assert.equal(await page.locator('.model-registry-table tbody tr').count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(new URL('browser-verification.json', out), JSON.stringify({ mockApi: true, metrics, responsive, filteringAndPagination: 'passed', noMatches: 'passed', emptyState: 'passed', loadError: 'passed', errors }, null, 2));
  console.log(JSON.stringify({ metrics, responsive, errors }));
} finally { await browser.close(); }
