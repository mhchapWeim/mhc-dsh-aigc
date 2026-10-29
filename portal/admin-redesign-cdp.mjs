// Local-only CDP harness for admin visual verification. Not part of the app.
//
// Usage: node admin-redesign-cdp.mjs [--base=http://127.0.0.1:3002]
// Output: ../output/admin-redesign/*.png + verify-report.json (git-ignored).
//
// Notes:
// - The demo (no-backend) session lives in React state only, so each route is
//   reached by signing in with that route as returnTo (client-side redirect).
// - The Chrome profile is created under output/ (git-ignored) and removed on exit,
//   so the source tree stays clean.
// - Emulation.setDeviceMetricsOverride needs mobile:false here: mobile:true makes
//   Chrome fall back to a 720px layout viewport without an active touch emulation,
//   which previously caused a false "scrollWidth=720" overflow reading.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../output/admin-redesign');
const PROFILE = resolve(OUT, '.chrome-profile');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? 'http://127.0.0.1:3002';
const PORT = 9360;
const USER = { employeeNo: 'wh00028' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' });

let ws, chromeExit;
const cleanup = () => {
  try { ws?.close(); } catch { /* already closed */ }
  try { chrome.kill(); } catch { /* already exited */ }
  rmSync(PROFILE, { recursive: true, force: true });
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

try {
  let target;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* CDP not listening yet */ }
    await sleep(250);
  }
  if (!target) throw new Error('Chrome CDP did not start');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve2, reject2) => {
    const id = ++seq;
    pending.set(id, { resolve: resolve2, reject: reject2 });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description ?? String(r.exceptionDetails.text) };
    return r.result.value;
  };
  // mobile must stay false: true forces a 720px layout viewport in headless.
  const vp = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(resolve(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  };

  await send('Page.enable');
  await send('Runtime.enable');

  const loginFor = async (route) => {
    await vp(1440, 900);
    await send('Page.navigate', { url: `${BASE}/login/local?returnTo=${encodeURIComponent(route)}` });
    await sleep(3200);
    await ev(`document.querySelector('input[aria-label="企业工号"]')?.focus()`);
    await send('Input.insertText', { text: USER.employeeNo });
    await ev(`document.querySelector('input[aria-label="密码"]')?.focus()`);
    await send('Input.insertText', { text: 'demo' });
    await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '登录')?.click()`);
    await sleep(3500);
    return { path: await ev('location.pathname'), shell: await ev(`!!document.querySelector('.admin-app')`) };
  };

  // Horizontal overflow probe.
  // documentElement.scrollWidth is NOT a reliable judge here: in headless Chrome it
  // gets inflated by content inside overflow:auto wrappers (reported 720 regardless
  // of whether the viewport was 375 or 390). So we judge by what a user can actually
  // do and see: can the page scroll horizontally, and is anything painted past the
  // right edge? Wide tables inside .table-wrap are expected and scroll locally.
  const probe = async (width, height) => {
    await vp(width, height);
    await sleep(850);
    return ev(`(async () => {
      const vw = window.innerWidth;
      const se = document.scrollingElement;
      const startX = window.scrollX;
      window.scrollTo(9999, window.scrollY);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const scrolledX = window.scrollX;
      window.scrollTo(startX, window.scrollY);
      await new Promise(r => requestAnimationFrame(r));

      // Anything actually painted beyond the right edge?
      const y = Math.round(innerHeight / 2);
      const painted = [];
      for (let x = vw + 2; x < vw + 160; x += 20) {
        const el = document.elementFromPoint(x, y);
        if (el && el !== document.documentElement && el !== document.body) {
          painted.push({ x, tag: el.tagName.toLowerCase(), cls: (typeof el.className === 'string' ? el.className : '').slice(0, 40) });
        }
      }
      // Local scrollers are fine; report them for context only.
      const localScrollers = [];
      for (const el of document.querySelectorAll('body *')) {
        if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
          const ov = getComputedStyle(el).overflowX;
          if (ov === 'auto' || ov === 'scroll') localScrollers.push({ cls: (typeof el.className === 'string' ? el.className : '').slice(0, 45), sw: el.scrollWidth, cw: el.clientWidth });
        }
      }
      return { vw, scrollableX: scrolledX > startX + 1, scrolledTo: Math.round(scrolledX),
        scrollWidthQuirk: se.scrollWidth, paintedBeyondEdge: painted.length, paintedSample: painted.slice(0, 4),
        localScrollerCount: localScrollers.length, localScrollers: localScrollers.slice(0, 3) };
    })()`);
  };

  const widths = [[1440, 900, 'w1440'], [1024, 800, 'w1024'], [760, 800, 'w760'], [700, 800, 'w700'], [601, 820, 'w601'], [390, 780, 'w390']];
  const routes = ['/admin', '/admin/users', '/admin/roles', '/admin/plugins/status', '/admin/uploads', '/admin/models', '/admin/dsh-failures', '/admin/dsh-feedback'];
  const report = { base: BASE, ranAt: new Date().toISOString(), routes: {}, checks: {} };

  for (const route of routes) {
    const login = await loginFor(route);
    const h1 = await ev(`document.querySelector('.page-title h1')?.textContent ?? null`);
    const denied = await ev(`!!document.querySelector('.access-denied')`);
    report.routes[route] = { login, h1, denied, widths: {} };
    for (const [w, h, key] of widths) report.routes[route].widths[key] = await probe(w, h);
    const line = widths.map(([, , k]) => {
      const p = report.routes[route].widths[k];
      const bad = p.scrollableX || p.paintedBeyondEdge > 0;
      return `${k}:${bad ? 'OVERFLOW' : 'ok'}${p.localScrollerCount ? `(${p.localScrollerCount}local)` : ''}`;
    }).join(' ');
    console.log('ROUTE', route, '| at:', login.path, '| h1:', h1, '| denied:', denied, '|', line);
    for (const [, , k] of widths) {
      const p = report.routes[route].widths[k];
      if (p.paintedBeyondEdge > 0) console.log('   PAINTED-BEYOND@' + k, JSON.stringify(p.paintedSample));
      if (p.scrollableX) console.log('   SCROLLABLE-X@' + k, 'scrolledTo=' + p.scrolledTo, 'quirkScrollW=' + p.scrollWidthQuirk);
    }
  }

  // ---- deep-link login redirect check (roles) ----
  report.checks.rolesRedirect = await loginFor('/admin/roles');

  // ---- 390px user modal ----
  await loginFor('/admin/users');
  await vp(390, 780);
  await sleep(700);
  await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('新增用户'))?.click()`);
  await sleep(1300);
  report.checks.modal390 = await ev(`(() => {
    const m = document.querySelector('.modal'); if (!m) return { open: false };
    const body = m.querySelector('.user-edit-body'), closeBtn = m.querySelector('.modal-close-button'), actions = m.querySelector('.modal-actions');
    const ar = actions?.getBoundingClientRect(), cr = closeBtn?.getBoundingClientRect();
    const mcs = getComputedStyle(m), bcs = body ? getComputedStyle(body) : null;
    return { open: true, innerWidth, modalW: Math.round(m.getBoundingClientRect().width), overflow: mcs.overflow, maxH: mcs.maxHeight,
      bodyScrollH: body?.scrollHeight, bodyClientH: body?.clientHeight, bodyOverflowY: bcs?.overflowY,
      bodyScrollable: !!body && body.scrollHeight > body.clientHeight + 1,
      closeInViewport: !!cr && cr.top >= 0 && cr.bottom <= innerHeight,
      actionsInViewport: !!ar && ar.bottom <= innerHeight + 1 && ar.top >= 0,
      docScrollWidth: document.documentElement.scrollWidth };
  })()`);
  report.checks.modal390Scroll = await ev(`(() => {
    const body = document.querySelector('.modal .user-edit-body'); if (!body) return { ok: false };
    const before = body.scrollTop; body.scrollTop = 9999;
    return { ok: true, before, after: body.scrollTop, moved: body.scrollTop > before };
  })()`);
  await shot('users-modal-390');

  // ---- phone control font sizes ----
  report.checks.controlFont390 = await ev(`(() => [...document.querySelectorAll('.admin-app input, .admin-app select, .admin-app textarea')]
    .map(el => ({ tag: el.tagName.toLowerCase(), type: el.type || '', size: getComputedStyle(el).fontSize, aria: el.getAttribute('aria-label') || '' }))
    .filter(x => x.size !== '16px'))()`);
  await ev(`document.querySelector('.modal-close-button')?.click()`);
  await sleep(400);

  // ---- topbar vs hamburger across the intermediate breakpoint ----
  report.checks.topbar = [];
  for (const w of [760, 700, 680, 640, 601]) {
    await vp(w, 820);
    await sleep(750);
    const r = await ev(`(() => {
      const bar = document.querySelector('.admin-topbar'), burger = document.querySelector('.mobile-menu-button');
      if (!bar || !burger) return { w: innerWidth, missing: true };
      const g = burger.getBoundingClientRect(), crumb = bar.querySelector('div:first-child')?.getBoundingClientRect();
      return { w: innerWidth, padLeft: getComputedStyle(bar).paddingLeft,
        burgerRight: Math.round(g.right), crumbLeft: crumb ? Math.round(crumb.left) : null,
        overlapsCrumb: crumb ? (g.right > crumb.left && g.bottom > crumb.top && g.top < crumb.bottom) : null,
        docScrollWidth: document.documentElement.scrollWidth };
    })()`);
    report.checks.topbar.push(r);
  }
  console.log('TOPBAR', JSON.stringify(report.checks.topbar));

  // ---- collapsed flyout (hover tokens) ----
  await vp(1440, 900);
  await sleep(900);
  await ev(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '收起侧边栏')?.click()`);
  await sleep(900);
  await ev(`(() => { const b = document.querySelector('.admin-nav-toggle'); if (b) b.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); })()`);
  await sleep(800);
  report.checks.flyout = await ev(`(() => {
    const f = document.querySelector('.admin-nav-flyout'); if (!f) return { open: false };
    const n = f.querySelector('nav'), a = n?.querySelector('a');
    const ncs = n ? getComputedStyle(n) : null, r = n?.getBoundingClientRect();
    return { open: true, navBg: ncs?.backgroundColor, navColor: ncs?.color, navBorder: ncs?.borderColor,
      linkBg: a ? getComputedStyle(a).backgroundColor : null, linkColor: a ? getComputedStyle(a).color : null,
      left: r ? Math.round(r.left) : null, right: r ? Math.round(r.right) : null, vw: innerWidth };
  })()`);
  console.log('FLYOUT', JSON.stringify(report.checks.flyout));
  await shot('nav-flyout-collapsed');
  await ev(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '展开侧边栏')?.click()`);
  await sleep(700);

  // ---- theme token coverage ----
  await loginFor('/admin/users');
  await ev(`document.documentElement.setAttribute('data-theme','dark')`);
  await sleep(1000);
  report.checks.dark = await ev(`(() => {
    const app = document.querySelector('.admin-app'); if (!app) return { missing: true };
    const cs = getComputedStyle(app);
    const white = [];
    for (const el of app.querySelectorAll('*')) {
      if (getComputedStyle(el).backgroundColor !== 'rgb(255, 255, 255)') continue;
      // Only flag visible white surfaces, not transparent overlays on white pages.
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      white.push({ tag: el.tagName.toLowerCase(), cls: (typeof el.className === 'string' ? el.className : '').slice(0, 55) });
    }
    return { appBg: cs.backgroundColor, appColor: cs.color,
      tokens: { surface: cs.getPropertyValue('--surface').trim(), page: cs.getPropertyValue('--page').trim(), ink: cs.getPropertyValue('--ink').trim(), line: cs.getPropertyValue('--line').trim(), primary: cs.getPropertyValue('--blue-600').trim() },
      whiteSurfaceCount: white.length, whiteSurfaceSample: white.slice(0, 8) };
  })()`);
  console.log('DARK', JSON.stringify(report.checks.dark));
  await shot('users-dark-1440');

  // open a filter dropdown in dark mode to confirm the popup surface
  await ev(`document.querySelector('.toolbar-filters button, .modern-select__trigger')?.click()`);
  await sleep(700);
  report.checks.darkSelect = await ev(`(() => {
    const trig = document.querySelector('.admin-app .modern-select__trigger');
    const popup = document.querySelector('.admin-app .modern-select__popup');
    const opt = popup?.querySelector('button');
    return { triggerBg: trig ? getComputedStyle(trig).backgroundColor : null,
      triggerColor: trig ? getComputedStyle(trig).color : null,
      popupBg: popup ? getComputedStyle(popup).backgroundColor : null,
      optionBg: opt ? getComputedStyle(opt).backgroundColor : null,
      optionColor: opt ? getComputedStyle(opt).color : null };
  })()`);
  console.log('DARK_SELECT', JSON.stringify(report.checks.darkSelect));
  await shot('users-dark-select-1440');
  await ev(`document.documentElement.removeAttribute('data-theme')`);
  await sleep(800);

  await ev(`document.querySelector('.modern-select__trigger')?.click()`);
  await sleep(600);
  report.checks.lightSelect = await ev(`(() => {
    const trig = document.querySelector('.admin-app .modern-select__trigger');
    const popup = document.querySelector('.admin-app .modern-select__popup');
    const opt = popup?.querySelector('button');
    return { triggerBg: trig ? getComputedStyle(trig).backgroundColor : null, triggerColor: trig ? getComputedStyle(trig).color : null,
      popupBg: popup ? getComputedStyle(popup).backgroundColor : null,
      optionBg: opt ? getComputedStyle(opt).backgroundColor : null, optionColor: opt ? getComputedStyle(opt).color : null };
  })()`);
  console.log('LIGHT_SELECT', JSON.stringify(report.checks.lightSelect));

  // ---- desktop screenshots ----
  await ev(`document.body.click()`);
  await sleep(400);
  await shot('users-1440');
  for (const [route, name] of [['/admin', 'dashboard-1440'], ['/admin/plugins/status', 'plugins-status-1440'], ['/admin/uploads', 'uploads-1440'], ['/admin/models', 'models-1440'], ['/admin/roles', 'roles-1440'], ['/admin/dsh-failures', 'dsh-failures-1440']]) {
    await loginFor(route);
    await vp(1440, 900);
    await sleep(800);
    await shot(name);
  }

  writeFileSync(resolve(OUT, 'verify-report.json'), JSON.stringify(report, null, 2));
  console.log('WROTE', resolve(OUT, 'verify-report.json'));
} finally {
  cleanup();
}
