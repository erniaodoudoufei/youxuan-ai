// 注入到 claude.ai / chatgpt.com / gemini.google.com 的内容脚本：
//   yx-list-options  读取模式、模型菜单和思考强度选项
//   yx-ask           （可选）切换模式/模型/强度 → 填入问题 → 点发送 → 盯住回答，边生成边回传，结束后发 done
(() => {
  if (window.__yxLoaded) return;
  window.__yxLoaded = true;

  const siteKey = Object.keys(YX_SITES).find((k) => {
    const h = YX_SITES[k].host;
    return location.hostname === h || location.hostname.endsWith('.' + h);
  });
  const cfg = YX_SITES[siteKey];
  if (!cfg) return;

  const INPUT_TIMEOUT = 30_000;      // 等输入框出现
  const NO_REPLY_TIMEOUT = 90_000;   // 发送后迟迟没有回答也没有“停止”按钮
  const TOTAL_TIMEOUT = 15 * 60_000; // 推理模型可能很久
  const STABLE_MS = 2500;            // 文本多久不变视为结束
  const PROGRESS_EVERY = 700;
  const PATH_SEP = ' › ';            // 子菜单里的模型：“父项 › 子项”

  // 后台标签页的 setTimeout 会被限速到一分钟一次，计时交给扩展后台（见 background.js）
  const sleep = (ms) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'yx-sleep', ms }).then(resolve, () => setTimeout(resolve, ms));
    } catch {
      setTimeout(resolve, ms); // 扩展被重新加载后旧脚本失去连接
    }
  });
  const isVisible = (el) => !!el && el.getClientRects().length > 0;
  const isEnabled = (b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true';
  const norm = (s) => (s || '').replace(/\s+/g, '');
  const key = (s) => norm(s).toLowerCase();
  const sameLabel = (a, b) => !!a && !!b && (key(a) === key(b) || key(a).startsWith(key(b)) || key(b).startsWith(key(a)));

  const findVisible = (sels, ok = () => true, root = document) => {
    for (const s of sels || []) {
      for (const el of root.querySelectorAll(s)) if (isVisible(el) && ok(el)) return el;
    }
    return null;
  };
  const findAll = (sels, root = document) => {
    for (const s of sels || []) {
      const list = [...root.querySelectorAll(s)];
      if (list.length) return list;
    }
    return [];
  };
  const waitFor = async (fn, timeout, step = 300) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  };

  const report = (msg) => {
    chrome.runtime.sendMessage({ type: 'yx-status', site: siteKey, ...msg }).catch(() => {});
  };

  // ---------- 诊断信息：失败时附带，方便对照真实页面修选择器 ----------

  function diag(stage, extra = {}) {
    const count = (sels) => (sels || []).map((s) => `${s} → ${document.querySelectorAll(s).length}`);
    const ids = {};
    document.querySelectorAll('[data-testid],[data-test-id]').forEach((e) => {
      const k = e.getAttribute('data-testid') || e.getAttribute('data-test-id');
      ids[k] = (ids[k] || 0) + 1;
    });
    const buttons = [...document.querySelectorAll('button')].filter(isVisible).slice(-40).map((b) =>
      [b.getAttribute('aria-label'), b.getAttribute('data-testid') || b.getAttribute('data-test-id'),
        (b.innerText || '').trim().slice(0, 24)].filter(Boolean).join(' | ')).filter(Boolean);
    return {
      stage,
      url: location.href,
      time: new Date().toISOString(),
      input: count(cfg.input),
      sendButton: count(cfg.sendButton),
      stopButton: count(cfg.stopButton),
      streaming: count(cfg.streaming),
      message: count(cfg.message),
      content: count(cfg.content),
      modelTrigger: count(cfg.picker?.trigger),
      generating: isGenerating(),
      testids: Object.entries(ids).sort((a, b) => b[1] - a[1]).slice(0, 60).map(([k, n]) => `${k} ×${n}`),
      buttons,
      ...extra
    };
  }

  // ---------- 输入与发送 ----------

  const inputText = (el) => (el.tagName === 'TEXTAREA' ? el.value : el.innerText);

  // 返回是否填入成功
  async function fillInput(el, text) {
    el.focus();
    const probe = norm(text).slice(0, 30);
    const filled = () => norm(inputText(el)).includes(probe);
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return filled();
    }
    document.execCommand('selectAll');
    document.execCommand('delete');
    // 首选 insertText：编辑器（ProseMirror / Quill）会把它当成真实输入处理
    document.execCommand('insertText', false, text);
    await sleep(300);
    if (filled()) return true;

    // 退路 1：模拟粘贴
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(500);
    if (filled()) return true;

    // 退路 2：直接写入
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    await sleep(300);
    return filled();
  }

  const isGenerating = () =>
    !!findVisible(cfg.stopButton) ||
    (cfg.streaming || []).some((s) => document.querySelector(s));

  // 取一条回答的正文：只取最外层的 content 节点，避免嵌套重复；还没有正文时返回空
  function extract(msgEl) {
    let parts = findAll(cfg.content, msgEl);
    parts = parts.filter((p) => !parts.some((o) => o !== p && o.contains(p)));
    const html = parts.map((p) => {
      const clone = p.cloneNode(true);
      yxReplaceMath(clone);
      return yxSanitize(clone);
    }).join('<hr>');
    return { html, text: html ? yxToMarkdown(html) : '' };
  }

  async function send(input, beforeCount) {
    // 输入框被清空也算发送成功（前提是之前确实填进去了）
    const started = () =>
      isGenerating() ||
      findAll(cfg.message).length > beforeCount ||
      !norm(inputText(input));

    const btn = await waitFor(() => findVisible(cfg.sendButton, isEnabled), 8000);
    if (btn) btn.click();
    else pressKey(input, 'Enter');
    if (await waitFor(started, 6000)) return true;

    // 再试一次回车
    input.focus();
    pressKey(input, 'Enter');
    return !!(await waitFor(started, 6000));
  }

  function pressKey(el, k) {
    const codes = { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowRight: 39 };
    const opts = { key: k, code: k, keyCode: codes[k], which: codes[k], bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // ---------- 菜单基础 ----------

  // 很多菜单组件（如 Radix）监听 pointerdown 而不是 click，所以模拟完整的一次鼠标点击
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
    };
    const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...ptr, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...ptr, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
  }

  function hover(el) {
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + 5, clientY: r.top + r.height / 2 };
    const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerover', ptr));
    el.dispatchEvent(new PointerEvent('pointerenter', { ...ptr, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mouseover', base));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false }));
    el.dispatchEvent(new PointerEvent('pointermove', ptr));
    el.dispatchEvent(new MouseEvent('mousemove', base));
    el.focus?.();
    pressKey(el, 'ArrowRight');
  }

  // 后台标签页里关闭动画可能一直不结束，已关闭（data-closed / data-state=closed）的菜单要排除
  const isOpenMenu = (m) => isVisible(m) && !m.hasAttribute('data-closed') &&
    m.getAttribute('data-state') !== 'closed' && !/exit/.test(m.className);

  const openMenus = () => {
    const set = new Set();
    for (const s of cfg.picker.menu) document.querySelectorAll(s).forEach((m) => { if (isOpenMenu(m)) set.add(m); });
    // 去掉嵌套的（只要最内层真正装菜单项的那个）
    return [...set].filter((m) => ![...set].some((o) => o !== m && m.contains(o)));
  };

  const waitNewMenu = (before, timeout = 2500) =>
    waitFor(() => openMenus().find((m) => !before.includes(m)), timeout, 150);

  async function closeMenus() {
    for (let i = 0; i < 4 && openMenus().length; i++) {
      pressKey(document.activeElement || document.body, 'Escape');
      await sleep(300);
    }
  }

  // 打开模型菜单；有的组件 pointerdown 和 click 各切换一次，打不开就再补一次 click
  // 页面刚加载或刚切换模式时按钮可能还不响应，打不开就隔一会儿重新找按钮再试
  async function openPicker() {
    await closeMenus();
    for (let attempt = 0; attempt < 3; attempt++) {
      const trigger = await waitFor(() => findVisible(cfg.picker.trigger), 4000);
      if (!trigger) return null;
      const before = openMenus();
      realClick(trigger);
      let menu = await waitNewMenu(before, 2000);
      if (!menu) {
        trigger.click();
        menu = await waitNewMenu(before, 2000);
      }
      if (menu) {
        await sleep(300);
        return menu;
      }
      await closeMenus();
      await sleep(1000);
    }
    return null;
  }

  const isChecked = (el) => el.getAttribute('aria-checked') === 'true' || el.getAttribute('data-state') === 'checked' ||
    el.getAttribute('aria-selected') === 'true' || el.classList.contains('selected');

  function readItem(el) {
    const lines = (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    let label = el.querySelector('.label')?.textContent.trim() || '';
    let rest;
    if (label) {
      rest = lines.filter((l) => l !== label);
    } else if (lines[1] && /^\d+(\.\d+)*$/.test(lines[1])) {
      // Claude 把版本号单独放一行：“Opus / 5.5”
      label = `${lines[0]} ${lines[1]}`;
      rest = lines.slice(2);
    } else {
      label = lines[0] || '';
      rest = lines.slice(1);
    }
    return { el, label, desc: rest.join(' '), checked: isChecked(el) };
  }

  const menuItems = (menu, sels) =>
    findAll(sels, menu).filter(isVisible).map(readItem).filter((it) => it.label);

  // 悬停打开菜单里名字匹配 re 的子菜单
  async function openSubmenu(menu, re) {
    const parent = [...menu.querySelectorAll('[role="menuitem"][aria-haspopup]')]
      .find((e) => isVisible(e) && re.test(e.innerText || ''));
    if (!parent) return null;
    const before = openMenus();
    hover(parent);
    let sub = await waitNewMenu(before, 1500);
    if (!sub) {
      realClick(parent);
      sub = await waitNewMenu(before, 1500);
    }
    return sub ? { sub, parentLabel: readItem(parent).label } : null;
  }

  // ---------- 模式（ChatGPT 的 聊天 / 工作） ----------

  const modeButtons = () => {
    const g = cfg.modes && findVisible(cfg.modes.group);
    return g ? [...g.querySelectorAll('button')].filter(isVisible) : [];
  };
  const currentMode = () => (modeButtons().find((b) => b.getAttribute('aria-pressed') === 'true')?.innerText || '').trim();

  // 新打开的页面里，输入框出现时模式按钮往往还不响应点击（实测 ChatGPT 要再等几秒），
  // 所以点了没切过去就隔一会儿再点，最多试 6 次
  async function setMode(label) {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (sameLabel(currentMode(), label)) {
        if (attempt > 0) await sleep(1000); // 切换后输入框和模型按钮会重建
        return true;
      }
      const btn = modeButtons().find((b) => sameLabel(b.innerText, label));
      if (!btn) {
        await sleep(1000); // 按钮组可能还没渲染出来
        continue;
      }
      realClick(btn);
      await waitFor(() => sameLabel(currentMode(), label), 1500, 250);
    }
    return sameLabel(currentMode(), label);
  }

  // ---------- 模型 ----------

  async function revealModels(menu) {
    const reveal = cfg.picker.models.reveal && findVisible(cfg.picker.models.reveal, () => true, menu);
    if (reveal) {
      realClick(reveal);
      await sleep(600);
    }
    return openMenus().pop() || menu;
  }

  async function listModels() {
    const m = cfg.picker.models;
    let menu = await openPicker();
    if (!menu) return [];
    menu = await revealModels(menu);
    const models = menuItems(menu, m.item).map((it) => ({ label: it.label, desc: it.desc, checked: it.checked }));
    await closeMenus();

    if (m.more) {
      const again = await openPicker();
      const found = again && await openSubmenu(again, m.more);
      if (found) {
        for (const it of menuItems(found.sub, m.item)) {
          models.push({ label: `${found.parentLabel}${PATH_SEP}${it.label}`, desc: it.desc, checked: it.checked });
        }
      }
      await closeMenus();
    }
    return models;
  }

  async function selectModel(label) {
    const m = cfg.picker.models;
    const path = label.split(PATH_SEP);
    let menu = await openPicker();
    if (!menu) return false;
    let target;
    if (path.length > 1 && m.more) {
      const found = await openSubmenu(menu, m.more);
      target = found && menuItems(found.sub, m.item).find((it) => sameLabel(it.label, path[1]));
    } else {
      menu = await revealModels(menu);
      target = menuItems(menu, m.item).find((it) => sameLabel(it.label, path[0]));
    }
    if (!target) {
      await closeMenus();
      return false;
    }
    if (!target.checked) {
      realClick(target.el);
      await sleep(800);
    }
    await closeMenus();
    return true;
  }

  // ---------- 思考强度 ----------

  // ChatGPT 滑块的状态文字：“Medium，第 2 项，共 3 项。” / “Medium, item 2 of 3”
  function sliderState(menu) {
    const t = menu.querySelector(cfg.picker.effort.status)?.textContent.trim() || '';
    const cut = t.search(/[，,]/);
    if (cut < 0) return null;
    const nums = t.slice(cut).match(/\d+/g) || [];
    if (nums.length < 2) return null;
    return { label: t.slice(0, cut).trim(), idx: +nums[0], total: +nums[1] };
  }

  async function moveSlider(menu, handle, target) {
    handle.focus();
    for (let i = 0; i < 12; i++) {
      const s = sliderState(menu);
      if (!s) return false;
      if (s.idx === target) return true;
      pressKey(handle, s.idx < target ? 'ArrowRight' : 'ArrowLeft');
      await sleep(250);
    }
    return false;
  }

  // 返回 { type, options, current }；scan=false 时只读当前值（不拖动滑块）
  async function readEffort(scan) {
    const e = cfg.picker.effort;
    if (!e) return { type: null, options: [], current: '' };
    const menu = await openPicker();
    if (!menu) return { type: e.type, options: [], current: '' };
    let res = { type: e.type, options: [], current: '' };

    if (e.type === 'slider') {
      const handle = findVisible(e.item, () => true, menu);
      const s0 = handle && sliderState(menu);
      if (s0) {
        res.current = s0.label;
        if (scan) {
          // 拖到最左，逐档向右读出名字，再放回原位
          await moveSlider(menu, handle, 1);
          const labels = [];
          for (let i = 1; i <= s0.total; i++) {
            const s = sliderState(menu);
            if (s) labels[s.idx - 1] = s.label;
            if (i < s0.total) {
              pressKey(handle, 'ArrowRight');
              await sleep(250);
            }
          }
          await moveSlider(menu, handle, s0.idx);
          res.options = labels.filter(Boolean);
        }
      }
    } else if (e.type === 'submenu') {
      const found = await openSubmenu(menu, e.match);
      if (found) {
        const items = menuItems(found.sub, e.item);
        res = { type: e.type, name: found.parentLabel, options: items.map((it) => it.label), current: items.find((it) => it.checked)?.label || '' };
      }
    } else if (e.type === 'section') {
      const items = menuItems(menu, e.item);
      res = { type: e.type, options: items.map((it) => it.label), current: items.find((it) => it.checked)?.label || '' };
    }
    await closeMenus();
    return res;
  }

  async function selectEffort(value) {
    const e = cfg.picker.effort;
    if (!e) return false;
    const menu = await openPicker();
    if (!menu) return false;
    let ok = false;

    if (e.type === 'slider') {
      const handle = findVisible(e.item, () => true, menu);
      const s0 = handle && sliderState(menu);
      if (s0) {
        await moveSlider(menu, handle, 1);
        for (let i = 1; i <= s0.total; i++) {
          if (sameLabel(sliderState(menu)?.label, value)) { ok = true; break; }
          pressKey(handle, 'ArrowRight');
          await sleep(250);
        }
        if (!ok) await moveSlider(menu, handle, s0.idx); // 没找到就放回原位
      }
    } else {
      let items = [];
      if (e.type === 'submenu') {
        const found = await openSubmenu(menu, e.match);
        if (found) items = menuItems(found.sub, e.item);
      } else {
        items = menuItems(menu, e.item);
      }
      const target = items.find((it) => sameLabel(it.label, value));
      if (target) {
        if (!target.checked) realClick(target.el);
        await sleep(600);
        ok = true;
      }
    }
    await closeMenus();
    return ok;
  }

  // 读出当前状态，用于面板标题，如 “工作 · GPT-6.1 Sol · 极高”
  async function describeCurrent() {
    if (!cfg.picker) return '';
    let menu = await openPicker();
    let model = '';
    if (menu) {
      menu = await revealModels(menu);
      model = menuItems(menu, cfg.picker.models.item).find((it) => it.checked)?.label || '';
      await closeMenus();
    }
    const effort = (await readEffort(false)).current;
    return [cfg.modes ? currentMode() : '', model, effort].filter(Boolean).join(' · ');
  }

  // 读当前模式下的模型和强度
  async function readPicker() {
    const models = await listModels();
    const efforts = await readEffort(true);
    return { models, efforts, current: models.find((m) => m.checked)?.label || '' };
  }

  // ---------- 等待回答 ----------

  // 用 sleep 轮询（不用 setInterval / MutationObserver+setTimeout，它们在后台标签页里会被限速）
  async function watchAnswer(beforeCount, runId, slot) {
    const start = Date.now();
    let lastText = null;
    let lastHtml = '';
    let lastChange = Date.now();
    let lastSent = 0;
    let finished = false;

    const finish = (msg) => {
      if (finished) return;
      finished = true;
      report({ runId, slot, ...msg });
    };

    const check = () => {
      if (finished) return;
      const now = Date.now();
      const generating = isGenerating();
      const msgs = findAll(cfg.message);

      if (msgs.length <= beforeCount) {
        if (!generating && now - start > NO_REPLY_TIMEOUT) {
          finish({
            status: 'error',
            error: `没有检测到 ${cfg.name} 的回答（可能是页面结构变了，或需要手动处理页面上的提示）`,
            diag: diag('no-reply', { beforeCount })
          });
        }
        return;
      }

      const { html, text } = extract(msgs[msgs.length - 1]);
      if (text !== lastText) {
        lastText = text;
        lastHtml = html;
        lastChange = now;
      }
      if (now - lastSent > PROGRESS_EVERY) {
        lastSent = now;
        report({ runId, slot, status: 'generating', html: lastHtml, text: lastText });
      }

      const stableFor = now - lastChange;
      if (!generating && ((lastText && stableFor > STABLE_MS) || stableFor > 10_000)) {
        finish({ status: 'done', html: lastHtml, text: lastText });
      } else if (now - start > TOTAL_TIMEOUT) {
        finish({ status: 'error', error: '等待超时，下面是已生成的部分', html: lastHtml, text: lastText });
      }
    };

    while (!finished) {
      check();
      if (!finished) await sleep(500);
    }
  }

  // ---------- 按标题查找历史对话，取最后一轮问答 ----------

  // 优先完全同名，其次标题包含关键词；多个匹配取最近更新的
  function pickByTitle(items, title) {
    const q = key(title);
    const byTime = (a, b) => (b.time || 0) - (a.time || 0);
    const exact = items.filter((i) => key(i.title) === q).sort(byTime);
    if (exact.length) return { item: exact[0], matches: exact.length, matchType: 'exact' };
    const part = items.filter((i) => key(i.title).includes(q)).sort(byTime);
    if (part.length) return { item: part[0], matches: part.length, matchType: 'contains' };
    return null;
  }

  // ChatGPT 回答里的引用标记（私用区字符包着的 cite 等）去掉
  const stripMarks = (s) => (s || '').replace(/[^]*/g, '').trim();

  async function findChatGPT(title) {
    const session = await fetch('/api/auth/session').then((r) => r.json());
    if (!session?.accessToken) return { ok: false, error: 'ChatGPT 未登录' };
    const opts = { headers: { Authorization: 'Bearer ' + session.accessToken } };

    const items = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const page = await fetch(`/backend-api/conversations?offset=${offset}&limit=100&order=updated`, opts).then((r) => r.json());
      for (const c of page.items || []) {
        items.push({ title: c.title || '', id: c.id, time: Date.parse(c.update_time) || 0 });
      }
      if (!page.items?.length || offset + 100 >= (page.total || 0)) break;
    }
    const hit = pickByTitle(items, title);
    if (!hit) return { ok: false, error: `ChatGPT 里没有找到标题含「${title}」的对话（共查了 ${items.length} 个）` };

    const conv = await fetch(`/backend-api/conversation/${hit.item.id}`, opts).then((r) => r.json());
    // 从当前叶子节点往上走，得到当前分支的消息顺序
    const path = [];
    for (let n = conv.current_node; n && conv.mapping[n]; n = conv.mapping[n].parent) {
      if (conv.mapping[n].message) path.unshift(conv.mapping[n].message);
    }
    const visible = (m) => !m.metadata?.is_visually_hidden_from_conversation;
    const textOf = (m) => (m.content?.parts || []).filter((p) => typeof p === 'string').join('\n');
    const lastUser = path.map((m, i) => [m, i])
      .filter(([m]) => m.author?.role === 'user' && m.content?.content_type === 'text' && visible(m)).pop();
    if (!lastUser) return { ok: false, error: '这个 ChatGPT 对话里没有找到提问' };
    // 只要给用户看的最终回答，跳过思考、工具调用等中间步骤
    const replies = path.slice(lastUser[1] + 1).filter((m) => m.author?.role === 'assistant' &&
      m.content?.content_type === 'text' && m.recipient === 'all' && visible(m) && textOf(m).trim());
    const finals = replies.filter((m) => m.channel === 'final');
    const answer = stripMarks((finals.length ? finals : replies).map(textOf).join('\n\n'));
    return {
      ok: true, title: hit.item.title, url: `https://chatgpt.com/c/${hit.item.id}`,
      matches: hit.matches, matchType: hit.matchType, question: textOf(lastUser[0]).trim(), answer
    };
  }

  async function findClaude(title) {
    const orgs = await fetch('/api/organizations').then((r) => r.json());
    if (!Array.isArray(orgs)) return { ok: false, error: 'Claude 未登录' };
    const chatOrgs = orgs.filter((o) => (o.capabilities || []).includes('chat'));
    const items = [];
    for (const org of chatOrgs.length ? chatOrgs : orgs) {
      const list = await fetch(`/api/organizations/${org.uuid}/chat_conversations?limit=1000`).then((r) => r.json()).catch(() => []);
      for (const c of Array.isArray(list) ? list : []) {
        items.push({ title: c.name || '', id: c.uuid, org: org.uuid, time: Date.parse(c.updated_at) || 0 });
      }
    }
    const hit = pickByTitle(items, title);
    if (!hit) return { ok: false, error: `Claude 里没有找到标题含「${title}」的对话（共查了 ${items.length} 个）` };

    const conv = await fetch(`/api/organizations/${hit.item.org}/chat_conversations/${hit.item.id}?tree=True&rendering_mode=messages&render_all_tools=true`).then((r) => r.json());
    const byId = Object.fromEntries((conv.chat_messages || []).map((m) => [m.uuid, m]));
    const path = [];
    for (let m = byId[conv.current_leaf_message_uuid]; m; m = byId[m.parent_message_uuid]) path.unshift(m);
    // 只取文字部分，跳过思考、工具调用和图片
    const textOf = (m) => (m.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('\n\n').trim() || (m.text || '').trim();
    const qi = path.map((m) => m.sender).lastIndexOf('human');
    if (qi < 0) return { ok: false, error: '这个 Claude 对话里没有找到提问' };
    const answer = path.slice(qi + 1).filter((m) => m.sender === 'assistant').map(textOf).filter(Boolean).join('\n\n');
    return {
      ok: true, title: hit.item.title, url: `https://claude.ai/chat/${hit.item.id}`,
      matches: hit.matches, matchType: hit.matchType, question: textOf(path[qi]), answer
    };
  }

  // Gemini 没有方便的接口：在侧边栏里找标题（不够就往下滚加载更多），点开后从页面读
  async function findInSidebar(title) {
    const h = cfg.history;
    const readList = () => [...document.querySelectorAll(h.item)].map((el, i) => ({
      el,
      title: (el.querySelector(h.title)?.textContent || el.textContent || '').trim(),
      link: el.closest('a') || el.querySelector('a'),
      time: -i // 侧边栏本来就是最近的在上面
    }));

    if (!(await waitFor(() => document.querySelector(h.item), 8000))) {
      // 侧边栏收起时列表不渲染，试着展开
      const btn = findVisible(h.menuButton);
      if (btn) realClick(btn);
      if (!(await waitFor(() => document.querySelector(h.item), 6000))) {
        return { ok: false, error: '找不到 Gemini 侧边栏的对话列表', diag: diag('history-no-list') };
      }
    }
    let hit = pickByTitle(readList(), title);
    for (let i = 0; !hit && i < 25; i++) { // 每次约加载 20 个，最多翻到 500 个左右
      const before = readList().length;
      const scroller = document.querySelector(h.item)?.closest(h.scroller);
      if (!scroller) break;
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll'));
      if (!(await waitFor(() => readList().length > before, 3000))) break; // 没有更多了
      hit = pickByTitle(readList(), title);
    }
    if (!hit) return { ok: false, error: `Gemini 侧边栏里没有找到标题含「${title}」的对话（共查了 ${readList().length} 个）` };

    const link = hit.item.link;
    if (!link) return { ok: false, error: '找到了对话，但没有找到它的链接' };
    const target = new URL(link.href).pathname;
    if (location.pathname !== target) link.click(); // 站内跳转，内容脚本不会被重新加载
    if (!(await waitFor(() => location.pathname === target && document.querySelector('user-query') && document.querySelector(cfg.message[0]), 20000))) {
      return { ok: false, error: '打开 Gemini 对话超时', diag: diag('history-open') };
    }
    await sleep(1500); // 等内容渲染完整

    const lastQuery = [...document.querySelectorAll('user-query')].pop();
    let question = '';
    for (const sel of h.question) {
      const parts = [...lastQuery.parentElement.querySelectorAll(sel)].filter((e) => lastQuery.contains(e));
      if (parts.length) {
        question = parts.map((e) => e.innerText.trim()).join('\n');
        break;
      }
    }
    const msgs = findAll(cfg.message);
    const { html, text } = extract(msgs[msgs.length - 1]);
    return {
      ok: true, title: hit.item.title, url: location.href,
      matches: hit.matches, matchType: hit.matchType, question, answer: text, html
    };
  }

  async function findConversation(title) {
    if (!(await waitFor(() => document.readyState === 'complete', 15000))) {
      return { ok: false, error: '页面加载超时' };
    }
    const type = cfg.history?.type;
    if (type === 'chatgpt-api') return findChatGPT(title);
    if (type === 'claude-api') return findClaude(title);
    if (type === 'sidebar') return findInSidebar(title);
    return { ok: false, error: `${cfg.name} 暂不支持按标题查找` };
  }

  // ---------- 两个任务 ----------

  async function waitReady() {
    const input = await waitFor(() => findVisible(cfg.input), INPUT_TIMEOUT);
    if (input) await sleep(800); // 等页面脚本初始化完，过早操作可能被清掉
    return input;
  }

  async function listOptions() {
    if (!(await waitReady())) {
      return { ok: false, error: `找不到 ${cfg.name} 的输入框：可能未登录`, diag: diag('list-no-input') };
    }
    if (!cfg.picker) return { ok: true, models: [], efforts: { options: [] }, current: '', at: Date.now() };

    const result = { ok: true, at: Date.now() };
    const modeList = modeButtons().map((b) => b.innerText.trim()).filter(Boolean);
    if (modeList.length) {
      // 每种模式的模型和强度都不一样，逐个切过去读，最后切回原来的模式
      const orig = currentMode();
      result.modeList = modeList;
      result.currentMode = orig;
      result.modes = {};
      for (const m of modeList) {
        if (await setMode(m)) result.modes[m] = await readPicker();
      }
      if (orig) await setMode(orig);
      Object.assign(result, result.modes[orig] || {});
    } else {
      Object.assign(result, await readPicker());
    }
    result.models = result.models || [];
    if (!result.models.length) result.diag = diag('list-no-models');
    return result;
  }

  async function ask({ prompt, runId, slot, mode, model, effort }) {
    const input = await waitReady();
    if (!input) {
      report({ runId, slot, status: 'error', error: `找不到 ${cfg.name} 的输入框：可能未登录，或页面结构变了`, diag: diag('no-input') });
      return;
    }

    // 顺序很重要：模式决定可选模型，模型决定可选强度
    const warnings = [];
    if (mode && !(await setMode(mode))) warnings.push(`未能切换到「${mode}」模式`);
    if (model && !(await selectModel(model))) warnings.push(`未能切换到「${model}」`);
    if (effort && !(await selectEffort(effort))) warnings.push(`未能设置思考强度「${effort}」`);
    const modelUsed = await describeCurrent();

    // 切换模式/模型后输入框可能重建，重新获取
    const box = findVisible(cfg.input) || input;
    const beforeCount = findAll(cfg.message).length;
    if (!(await fillInput(box, prompt))) {
      report({ runId, slot, status: 'error', error: '没能把问题填进输入框', diag: diag('fill-failed') });
      return;
    }
    if (!(await send(box, beforeCount))) {
      report({ runId, slot, status: 'error', error: '问题已填入，但没能发送出去，请到原网页手动点发送', diag: diag('send-failed') });
      return;
    }
    report({ runId, slot, status: 'generating', html: '', text: '', modelUsed, warning: warnings.join('；') });
    await watchAnswer(beforeCount, runId, slot);
  }

  let busy = false;
  const exclusive = async (fn) => {
    busy = true;
    try { return await fn(); } finally { busy = false; }
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'yx-ask') {
      if (busy) return sendResponse({ ok: false, error: 'busy' });
      sendResponse({ ok: true, site: siteKey });
      exclusive(() => ask(msg)).catch((e) =>
        report({ runId: msg.runId, slot: msg.slot, status: 'error', error: '出错：' + (e?.message || e), diag: diag('exception') }));
      return;
    }
    if (msg?.type === 'yx-find-conversation') {
      if (busy) return sendResponse({ ok: false, error: 'busy' });
      exclusive(() => findConversation(msg.title))
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: '出错：' + (e?.message || e), diag: diag('exception') }));
      return true; // 异步回复
    }
    if (msg?.type === 'yx-list-options') {
      if (busy) return sendResponse({ ok: false, error: 'busy' });
      exclusive(listOptions)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: '出错：' + (e?.message || e), diag: diag('exception') }));
      return true; // 异步回复
    }
  });
})();
