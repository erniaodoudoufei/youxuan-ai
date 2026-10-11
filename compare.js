// 对比页：调度各站点标签页、接收回答、并排展示、发起裁判对比。

const SITE_KEYS = Object.keys(YX_SITES);
const DEFAULT_CHECKED = { claude: true, chatgpt: true, gemini: false };
const TAB_GROUP_TITLE = 'AI对比';

const $ = (id) => document.getElementById(id);
// 对比页切到后台时定时器也会被限速，计时交给扩展后台（见 background.js）
const sleep = (ms) => chrome.runtime.sendMessage({ type: 'yx-sleep', ms })
  .catch(() => new Promise((r) => setTimeout(r, ms)));

// 当前这一轮：runId 用来丢弃上一轮迟到的消息
let run = null;      // { runId, question, slots: { claude: {...}, ... } }
let judge = null;    // { runId, site, mapping: { A: 'claude', ... }, slot }
let tabMap = {};     // 槽位 → tabId（claude / chatgpt / gemini / judge），复用标签页
let groupId = null;
let modelOptions = {}; // 站点 → { models:[{label,desc}], efforts:{type,options,current}, current, at }
let modelChoices = {}; // 站点 → { model, effort }，空字符串表示“网站默认”

// ---------- 设置 ----------

async function loadSettings() {
  const stored = await chrome.storage.local.get(['checked', 'judgeSite', 'modelOptions', 'modelChoices', 'draft']);
  if (stored.draft && !$('question').value) {
    $('question').value = stored.draft;
    $('draftInfo').textContent = '已恢复上次的草稿';
  }
  const checked = stored.checked || DEFAULT_CHECKED;
  modelOptions = stored.modelOptions || {};
  modelChoices = stored.modelChoices || {};
  ({ tabMap = {}, groupId = null } = await chrome.storage.session.get(['tabMap', 'groupId']));

  const box = $('siteChecks');
  for (const key of SITE_KEYS) {
    const row = document.createElement('div');
    row.className = 'site-row';
    row.dataset.site = key;
    row.innerHTML = `
      <label><input type="checkbox" value="${key}"><span></span></label>
      <select class="mode" title="模式"></select>
      <select class="model" title="模型"></select>
      <select class="effort" title="思考强度"></select>`;
    row.querySelector('span').textContent = YX_SITES[key].name;
    const cb = row.querySelector('input');
    cb.checked = !!checked[key];
    row.classList.toggle('off', !cb.checked);
    cb.addEventListener('change', () => {
      row.classList.toggle('off', !cb.checked);
      saveChecked();
    });
    row.querySelector('.mode').addEventListener('change', () => {
      // 换模式后可选模型/强度都变了，先保存模式再重新填充
      saveChoices();
      fillModelSelects(key);
      saveChoices();
    });
    row.querySelector('.model').addEventListener('change', saveChoices);
    row.querySelector('.effort').addEventListener('change', saveChoices);
    box.append(row);
    fillModelSelects(key);

    for (const sel of [$('judgeSite'), $('titleJudgeSite')]) addOption(sel, key, YX_SITES[key].name);
  }
  // 两处裁判下拉框（底部 和 按标题对比）是同一个设置
  const judgeSelects = [$('judgeSite'), $('titleJudgeSite')];
  for (const sel of judgeSelects) {
    sel.value = stored.judgeSite || 'gemini';
    sel.addEventListener('change', () => {
      for (const other of judgeSelects) other.value = sel.value;
      chrome.storage.local.set({ judgeSite: sel.value });
    });
  }
  showRefreshInfo();
}

function selectedSites() {
  return [...document.querySelectorAll('#siteChecks input:checked')].map((cb) => cb.value);
}

function saveChecked() {
  const checked = {};
  document.querySelectorAll('#siteChecks input').forEach((cb) => { checked[cb.value] = cb.checked; });
  chrome.storage.local.set({ checked });
}

function saveChoices() {
  document.querySelectorAll('.site-row').forEach((row) => {
    modelChoices[row.dataset.site] = {
      mode: row.querySelector('.mode').value,
      model: row.querySelector('.model').value,
      effort: row.querySelector('.effort').value
    };
  });
  chrome.storage.local.set({ modelChoices });
}

const choiceFor = (site) => ({ mode: '', model: '', effort: '', ...modelChoices[site] });

// 有模式的网站（ChatGPT 聊天/工作）每种模式各有一套模型和强度
function optionsFor(site, mode) {
  const opts = modelOptions[site];
  if (!opts?.modes) return opts;
  return opts.modes[mode || opts.currentMode] || opts;
}

function addOption(sel, value, text, title) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  if (title) o.title = title;
  sel.append(o);
}

// 用缓存的选项填充某站点的两个下拉框；之前选过但现在不存在的选项也保留，方便看出来
function fillModelSelects(site) {
  const row = document.querySelector(`.site-row[data-site="${site}"]`);
  const all = modelOptions[site];
  const choice = choiceFor(site);

  const modeSel = row.querySelector('.mode');
  modeSel.innerHTML = '';
  modeSel.hidden = !YX_SITES[site].modes;
  if (!modeSel.hidden) {
    addOption(modeSel, '', all?.currentMode ? `模式：默认（${all.currentMode}）` : '模式：默认');
    for (const m of all?.modeList || []) addOption(modeSel, m, `模式：${m}`);
    if (choice.mode && ![...modeSel.options].some((o) => o.value === choice.mode)) {
      addOption(modeSel, choice.mode, choice.mode + '（未找到）');
    }
    modeSel.value = choice.mode;
  }

  // 切换模式后，原来选的模型/强度在新模式里没有的话就回到默认
  const opts = optionsFor(site, choice.mode);
  const has = (list, v) => !v || (list || []).some((x) => (x.label ?? x) === v);
  if (all && !has(opts?.models, choice.model)) choice.model = '';
  if (all && !has(opts?.efforts?.options, choice.effort)) choice.effort = '';

  const mSel = row.querySelector('.model');
  mSel.innerHTML = '';
  addOption(mSel, '', opts?.current ? `网站默认（${opts.current}）` : '网站默认模型');
  for (const m of opts?.models || []) addOption(mSel, m.label, m.label, m.desc);
  if (choice.model && ![...mSel.options].some((o) => o.value === choice.model)) {
    addOption(mSel, choice.model, choice.model + '（未找到）');
  }
  mSel.value = choice.model;

  const eSel = row.querySelector('.effort');
  const eff = opts?.efforts;
  eSel.innerHTML = '';
  if (!YX_SITES[site].picker?.effort) {
    eSel.hidden = true;
    return;
  }
  const effName = '强度';
  addOption(eSel, '', eff?.current ? `${effName}：默认（${eff.current}）` : `${effName}：默认`);
  for (const v of eff?.options || []) addOption(eSel, v, `${effName}：${v}`);
  eSel.title = YX_SITES[site].picker.effort.type === 'slider'
    ? '思考强度（这里列的是读取时所选模型的档位，换模型后档位可能不同）'
    : '思考强度';
  if (choice.effort && ![...eSel.options].some((o) => o.value === choice.effort)) {
    addOption(eSel, choice.effort, choice.effort + '（未找到）');
  }
  eSel.value = choice.effort;
}

function showRefreshInfo(extra = '') {
  const times = Object.values(modelOptions).map((o) => o.at).filter(Boolean);
  const when = times.length ? '上次读取：' + new Date(Math.min(...times)).toLocaleString() : '还没读取过模型列表';
  $('refreshInfo').textContent = extra || when;
}

// 打开各站点新对话，读取模型菜单和思考强度选项
async function refreshOptions() {
  const sites = SITE_KEYS;
  $('refreshBtn').disabled = true;
  $('askBtn').disabled = true;
  showRefreshInfo('正在读取各网站的模型列表…');
  const problems = [];
  await Promise.all(sites.map(async (site) => {
    try {
      const tabId = await openFreshTab(site, YX_SITES[site].newChatUrl);
      const resp = await sendToTab(tabId, { type: 'yx-list-options' });
      const { diag, ...options } = resp || {};
      if (resp?.ok && options.models.length) {
        modelOptions[site] = options;
      } else {
        problems.push(`${YX_SITES[site].name}：${resp?.error || '没读到模型菜单'}`);
        if (diag) console.warn('[优选AI] 读取模型失败', site, diag);
        if (resp?.ok) modelOptions[site] = options; // 模型没读到，但强度/当前模型可能有
      }
    } catch (e) {
      problems.push(`${YX_SITES[site].name}：${e?.message || e}`);
    }
    fillModelSelects(site);
  }));
  chrome.storage.local.set({ modelOptions });
  $('refreshBtn').disabled = false;
  $('askBtn').disabled = false;
  showRefreshInfo(problems.length ? '部分失败 — ' + problems.join('；') : '');
}

// ---------- 标签页 ----------

function waitTabComplete(tabId, timeout = 30_000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(onUpd);
      clearTimeout(t);
      resolve();
    };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

// 每个槽位复用同一个标签页：已存在就跳转到新对话，否则在后台新建
async function openFreshTab(slot, url) {
  const myTab = await chrome.tabs.getCurrent();
  let tab = null;
  if (tabMap[slot]) {
    try { tab = await chrome.tabs.get(tabMap[slot]); } catch { tab = null; }
  }
  if (tab) {
    const loaded = waitTabComplete(tab.id);
    await chrome.tabs.update(tab.id, { url });
    await loaded;
  } else {
    tab = await chrome.tabs.create({ url, active: false, windowId: myTab.windowId });
    const loaded = waitTabComplete(tab.id);
    const now = await chrome.tabs.get(tab.id);
    if (now.status !== 'complete') await loaded;
    tabMap[slot] = tab.id;
    chrome.storage.session.set({ tabMap });
  }
  await addToGroup(tab.id);
  return tab.id;
}

async function addToGroup(tabId) {
  try {
    let gid = groupId;
    if (gid != null) {
      try { await chrome.tabGroups.get(gid); } catch { gid = null; }
    }
    const tab = await chrome.tabs.get(tabId);
    if (gid != null && tab.groupId === gid) return;
    if (gid != null) {
      const g = await chrome.tabGroups.get(gid);
      if (g.windowId !== tab.windowId) gid = null;
    }
    gid = await chrome.tabs.group(gid != null ? { tabIds: tabId, groupId: gid } : { tabIds: tabId });
    await chrome.tabGroups.update(gid, { title: TAB_GROUP_TITLE, color: 'blue' });
    groupId = gid;
    chrome.storage.session.set({ groupId });
  } catch {
    // 分组失败不影响主流程
  }
}

// 页面加载完后内容脚本可能还没就绪，重试几次
async function sendToTab(tabId, msg) {
  for (let i = 0; i < 40; i++) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, msg);
      if (resp) return resp;
    } catch {
      // Receiving end does not exist：还没注入，稍后再试
    }
    await sleep(750);
  }
  return null;
}

async function dispatch(slot, siteKey, prompt, runId) {
  try {
    const tabId = await openFreshTab(slot, YX_SITES[siteKey].newChatUrl);
    const { mode, model, effort } = choiceFor(siteKey);
    const resp = await sendToTab(tabId, { type: 'yx-ask', prompt, runId, slot, mode, model, effort });
    if (!resp?.ok) {
      const error = resp?.error === 'busy'
        ? '该页面正忙（上一个任务还没结束），请稍后再试'
        : '无法连接到页面（可能需要登录或通过人机验证），请点“打开原网页”查看';
      onStatus({ runId, slot, status: 'error', error });
    }
  } catch (e) {
    onStatus({ runId, slot, status: 'error', error: '打开页面失败：' + (e?.message || e) });
  }
}

async function focusTab(slot) {
  const tabId = tabMap[slot];
  if (!tabId) return;
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    alert('这个标签页已经被关掉了');
  }
}

// ---------- 面板 ----------

const STATUS_TEXT = { sending: '发送中…', generating: '生成中…', done: '完成', error: '失败' };

function createPanel(slot, title) {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="panel-head">
      <span class="name"></span>
      <span class="model"></span>
      <span class="status sending">${STATUS_TEXT.sending}</span>
      <span class="spacer"></span>
      <button data-act="copy">复制</button>
      <button data-act="open">打开原网页</button>
    </div>
    <div class="panel-body"><p class="placeholder">正在打开 ${title}…</p></div>`;
  panel.querySelector('.name').textContent = title;
  panel.querySelector('[data-act="open"]').addEventListener('click', () => focusTab(slot));
  panel.querySelector('[data-act="copy"]').addEventListener('click', (e) => {
    const text = slotState(slot)?.text || '';
    navigator.clipboard.writeText(text).then(() => {
      e.target.textContent = '已复制';
      setTimeout(() => { e.target.textContent = '复制'; }, 1200);
    });
  });
  return panel;
}

function slotState(slot) {
  if (slot === 'judge') return judge;
  return run?.slots[slot];
}

// 再清洗一遍再放进页面（内容来自第三方网页）
function renderHtml(el, html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  el.innerHTML = yxSanitize(doc.body.firstChild);
}

function updatePanel(st) {
  const statusEl = st.panel.querySelector('.status');
  statusEl.className = 'status ' + st.status;
  statusEl.textContent = STATUS_TEXT[st.status] || st.status;
  const body = st.panel.querySelector('.panel-body');
  if (st.question !== undefined && (st.html || st.text)) {
    // 按标题找到的历史对话：先显示当时的提问，再显示回答
    body.innerHTML = '';
    const q = document.createElement('p');
    q.className = 'question-line';
    q.textContent = '问：' + (st.question || '（没读到提问）');
    const a = document.createElement('div');
    if (st.html) renderHtml(a, st.html);
    else {
      a.className = 'plain';
      a.textContent = st.text;
    }
    body.append(q, a);
  } else if (st.html) {
    renderHtml(body, st.html);
  } else if (st.status === 'generating') {
    body.innerHTML = '<p class="placeholder">已发送，等待回答…</p>';
  } else if (st.status === 'error') {
    body.innerHTML = '';
  }
  if (st.error) {
    const p = document.createElement('p');
    p.className = 'error-msg';
    p.textContent = st.error;
    body.prepend(p);
  }
  if (st.diag) body.append(diagBlock(st.diag));

  const modelEl = st.panel.querySelector('.panel-head .model');
  modelEl.textContent = st.modelUsed ? '· ' + st.modelUsed : '';
  modelEl.title = st.modelUsed || '';
  let warn = st.panel.querySelector('.warning');
  if (st.warning && !warn) {
    warn = document.createElement('div');
    warn.className = 'warning';
    st.panel.querySelector('.panel-head').after(warn);
  }
  if (warn) warn.textContent = st.warning ? `⚠ ${st.warning}，已使用网站当前模型` : '';
}

// 可折叠的诊断信息，网站改版导致失败时复制给开发者
function diagBlock(info) {
  const d = document.createElement('details');
  d.className = 'diag';
  const json = JSON.stringify(info, null, 2);
  d.innerHTML = '<summary>诊断信息</summary><pre></pre><button>复制诊断信息</button>';
  d.querySelector('pre').textContent = json;
  d.querySelector('button').addEventListener('click', (e) => {
    navigator.clipboard.writeText(json).then(() => { e.target.textContent = '已复制'; });
  });
  return d;
}

// ---------- 提问 ----------

async function ask() {
  const question = $('question').value.trim();
  const sites = selectedSites();
  if (!question) return $('question').focus();
  if (!sites.length) return alert('至少勾选一个 AI');

  const runId = 'r' + Date.now().toString(36);
  run = { runId, question, slots: {} };
  judge = null;
  $('answers').innerHTML = '';
  $('judgeOut').innerHTML = '';
  $('judgeBar').hidden = true;

  for (const key of sites) {
    const panel = createPanel(key, YX_SITES[key].name);
    $('answers').append(panel);
    run.slots[key] = { site: key, status: 'sending', html: '', text: '', panel };
  }

  $('askBtn').disabled = true;
  setTimeout(() => { $('askBtn').disabled = false; }, 1500);
  await Promise.all(sites.map((key) => dispatch(key, key, question, runId)));
}

// ---------- 裁判 ----------

function buildJudgePrompt(question, entries) {
  // 按标题对比时，各网站里的提问可能措辞不同：相同就只写一次，不同就跟在各自回答前面
  const norm = (s) => (s || '').replace(/\s+/g, '');
  const qs = entries.map(([, st]) => st.question ?? question);
  const sameQuestion = qs.every((q) => norm(q) === norm(qs[0]));
  const answers = entries.map(([letter, st], i) =>
    (sameQuestion ? '' : `【回答${letter} 对应的提问】\n${qs[i].trim()}\n\n`) + `【回答${letter}】\n${st.text.trim()}`).join('\n\n');
  const questionBlock = sameQuestion
    ? `【问题】\n${qs[0]}`
    : '（各回答对应的提问措辞略有不同，已分别列出，请按同一个问题来对比）';
  return `你是一名公正、严格的评审。下面是不同 AI 助手对同一个问题的回答，已匿名为「回答${entries.map(([l]) => l).join('/')}」。请对比它们并输出：
1. 一句话结论：哪个回答最好，为什么。
2. 核心差异：各回答在结论、立场、关键事实上有哪些不同。
3. 准确性：指出明显错误、可疑或过时的说法，以及重要遗漏。
4. 结构与可读性：组织是否清晰，是否啰嗦。
5. 各自的亮点：每个回答值得保留的内容。
6. 综合最佳回答的要点（简要列出）。
请用中文、Markdown 格式回答，不要猜测每个回答出自哪个 AI。

${questionBlock}

${answers}`;
}

// ---------- 按对话标题对比 ----------
// 不经过插件提问：到各网站里找同名的历史对话，取最后一轮问答，再交给裁判

async function compareByTitle() {
  const title = $('convTitle').value.trim();
  const sites = selectedSites();
  if (!title) return $('convTitle').focus();
  if (sites.length < 2) return alert('请在上面至少勾选两个网站');

  const runId = 't' + Date.now().toString(36);
  run = { runId, question: '', slots: {} };
  judge = null;
  $('answers').innerHTML = '';
  $('judgeOut').innerHTML = '';
  $('judgeBar').hidden = true;
  $('titleBtn').disabled = true;

  for (const site of sites) {
    const panel = createPanel(site, YX_SITES[site].name);
    panel.querySelector('.status').textContent = '查找中…';
    panel.querySelector('.panel-body').innerHTML = '';
    const p = document.createElement('p');
    p.className = 'placeholder';
    p.textContent = `正在 ${YX_SITES[site].name} 里查找「${title}」…`;
    panel.querySelector('.panel-body').append(p);
    $('answers').append(panel);
    run.slots[site] = { site, status: 'sending', html: '', text: '', panel };
  }

  await Promise.all(sites.map(async (site) => {
    const st = run.slots[site];
    try {
      const tabId = await openFreshTab(site, YX_SITES[site].newChatUrl);
      const resp = await sendToTab(tabId, { type: 'yx-find-conversation', title });
      if (run.runId !== runId) return; // 已经开始了新的一轮
      if (resp?.ok && (resp.answer || resp.html)) {
        Object.assign(st, {
          status: 'done',
          question: resp.question || '',
          text: resp.answer || '',
          html: resp.html || '',
          modelUsed: `《${resp.title}》` + (resp.matches > 1 ? `（匹配到 ${resp.matches} 个，用了最近的）` : '')
        });
        // 让“打开原网页”直接看到这个对话
        if (resp.url) chrome.tabs.update(tabId, { url: resp.url }).catch(() => {});
      } else {
        Object.assign(st, {
          status: 'error',
          error: resp?.ok ? '找到了对话，但最后一轮没有回答内容' : (resp?.error === 'busy' ? '该页面正忙，请稍后再试' : resp?.error || '无法连接到页面'),
          diag: resp?.diag || null
        });
      }
    } catch (e) {
      Object.assign(st, { status: 'error', error: '查找失败：' + (e?.message || e) });
    }
    updatePanel(st);
  }));

  $('titleBtn').disabled = false;
  if (run.runId !== runId) return;
  refreshJudgeBar();
  const found = Object.values(run.slots).filter((s) => s.text.trim());
  if (found.length >= 2) {
    $('judgeSite').value = $('titleJudgeSite').value;
    startJudge();
  }
}

async function startJudge() {
  if (!run) return;
  const done = Object.values(run.slots).filter((s) => s.text && s.text.trim());
  if (done.length < 2) return alert('至少需要两个已完成的回答才能对比');

  // 随机打乱再编号，避免顺序和身份暗示
  const shuffled = done.slice().sort(() => Math.random() - 0.5);
  const letters = 'ABCDEFG';
  const entries = shuffled.map((st, i) => [letters[i], st]);
  const mapping = Object.fromEntries(entries.map(([l, st]) => [l, st.site]));

  const site = $('judgeSite').value;
  const runId = 'j' + Date.now().toString(36);
  const panel = createPanel('judge', `对比结论（裁判：${YX_SITES[site].name}）`);
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.textContent = '对应关系：' + entries.map(([l, st]) => `回答${l} = ${YX_SITES[st.site].name}`).join('，');
  panel.querySelector('.panel-head').after(legend);
  $('judgeOut').innerHTML = '';
  $('judgeOut').append(panel);
  judge = { runId, site, mapping, status: 'sending', html: '', text: '', panel };

  $('judgeBtn').disabled = true;
  await dispatch('judge', site, buildJudgePrompt(run.question, entries), runId);
}

function refreshJudgeBar() {
  if (!run) return;
  const slots = Object.values(run.slots);
  const finished = slots.filter((s) => s.status === 'done' || s.status === 'error');
  const withText = slots.filter((s) => s.text && s.text.trim());
  $('judgeBar').hidden = withText.length < 2;
  const judging = judge && (judge.status === 'sending' || judge.status === 'generating');
  $('judgeBtn').disabled = finished.length < slots.length || judging;
}

// ---------- 接收内容脚本的消息 ----------

function onStatus(msg) {
  let st = null;
  if (judge && msg.runId === judge.runId && msg.slot === 'judge') st = judge;
  else if (run && msg.runId === run.runId) st = run.slots[msg.slot];
  if (!st) return;
  if (st.status === 'done' && msg.status !== 'done') return;

  st.status = msg.status;
  if (msg.html !== undefined && (msg.html || !st.html)) st.html = msg.html;
  if (msg.text !== undefined && (msg.text || !st.text)) st.text = msg.text;
  st.error = msg.error || '';
  st.diag = msg.diag || null;
  if (msg.modelUsed) st.modelUsed = msg.modelUsed;
  if (msg.warning !== undefined) st.warning = msg.warning;
  updatePanel(st);
  refreshJudgeBar();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'yx-status') onStatus(msg);
});

// ---------- 草稿 ----------
// 输入框内容随时存到 chrome.storage，不小心关掉页面或浏览器后重新打开会自动恢复

let draftTimer = null;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  const draft = $('question').value;
  chrome.storage.local.set({ draft });
  $('draftInfo').textContent = draft ? '草稿已自动保存' : '';
}
$('question').addEventListener('input', () => {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 400);
});
// 关页面前把还没来得及保存的内容立刻存掉
window.addEventListener('pagehide', () => { if (draftTimer) saveDraft(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && draftTimer) saveDraft(); });

// ---------- 启动 ----------

$('askBtn').addEventListener('click', ask);
$('judgeBtn').addEventListener('click', startJudge);
$('refreshBtn').addEventListener('click', refreshOptions);
$('titleBtn').addEventListener('click', compareByTitle);
$('convTitle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    compareByTitle();
  }
});
$('question').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    ask();
  }
});
loadSettings();
$('question').focus();
