'use strict';
// 利用ガイド（版 livestock-order-api-0.2.3）。本文と図は、ログインの後に GAS から受け取る（公開の画面に本文を置かない）。
//   形（全システム共通の型）: 上に役割のタブ（畜産BY・店舗・倉庫）・全体の流れの図1枚・左に目次（本文と連動）・右に本文。
//   図は GAS が返す「箱と番号の丸」の構造のデータを、ここで DOM に描く。文字は全部 textContent（GAS の文字を HTML として入れない）。

const GUIDE_SESSION_KEY = 'livestock-order-session-v2';
const GUIDE_GAS_URL = String((window.APP_CONFIG && window.APP_CONFIG.gasUrl) || '');
const guide = { data: null, tab: '', pinned: '', spyTimer: 0 };

function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; }
const safeId = (v) => String(v || '').replace(/[^A-Za-z0-9_-]/g, '');
const scroller = () => document.querySelector('.guide-main');

// ------------------------------------------------------------ 図（全体の流れ・画面の略図）
function drawFlow(flow, role) {
  const box = document.getElementById('guide-flow'); box.replaceChildren();
  if (!flow || !Array.isArray(flow.steps)) { box.hidden = true; return; }
  box.append(el('h2', 'guide-flow-title', flow.title || '流れ'));
  const list = el('ol', 'guide-flow-list');
  flow.steps.forEach((step, i) => {
    const li = el('li', 'guide-flow-step' + (step.role === role ? ' is-you' : ''));
    if (step.role === role) li.append(el('span', 'guide-flow-you', 'あなた'));
    li.append(el('strong', '', step.who), el('span', 'guide-flow-what', step.what), el('small', '', 'いつ: ' + (step.when || '')), el('small', '', '画面: ' + (step.where || '')));
    list.append(li);
    if (i < flow.steps.length - 1) list.append(el('li', 'guide-flow-arrow', '→'));
  });
  box.append(list); box.hidden = false;
}

function drawSketch(sketch) {
  const fig = el('figure', 'sketch');
  fig.setAttribute('role', 'img');
  const marks = [];
  (sketch.rows || []).forEach((row) => {
    const r = el('div', 'sk-row' + (row.kind ? ' is-' + safeId(row.kind) : ''));
    (row.cells || []).forEach((cell) => {
      const c = el('div', 'sk-cell');
      ['grow', 'tall', 'plain', 'primary', 'check', 'note'].forEach((k) => { if (cell[k]) c.classList.add('is-' + k); });
      if (cell.text) c.append(el('span', 'sk-text', cell.text));
      if (cell.mark) { c.classList.add('is-marked'); c.append(el('span', 'sk-mark', cell.mark)); marks.push(cell.mark + '＝' + (cell.text || '')); }
      r.append(c);
    });
    fig.append(r);
  });
  fig.setAttribute('aria-label', (sketch.caption || '画面の略図') + (marks.length ? '。番号: ' + marks.join('、') : ''));
  fig.append(el('figcaption', '', sketch.caption || ''));
  return fig;
}

// ------------------------------------------------------------ タブ・目次・本文
function sectionNode(item) {
  const sec = el('section', 'guide-section-card'); sec.id = safeId(item.id);
  sec.append(el('h3', 'guide-h', item.title));
  const body = el('div', 'guide-body');
  if ((item.steps || []).length) { const ol = el('ol', 'guide-steps'); item.steps.forEach((s) => ol.append(el('li', '', s))); body.append(ol); }
  if ((item.sketches || []).length) { const pics = el('div', 'guide-sketches'); item.sketches.forEach((s) => pics.append(drawSketch(s))); body.append(pics); }
  if (item.success) { const ok = el('p', 'guide-success'); ok.append(el('b', '', 'うまくいった印'), el('span', '', item.success)); body.append(ok); }
  if ((item.tips || []).length) { const ul = el('ul', 'guide-tips'); item.tips.forEach((t) => ul.append(el('li', '', t))); body.append(ul); }
  sec.append(body);
  return sec;
}

function troubleNode(tab) {
  const sec = el('section', 'guide-section-card is-trouble'); sec.id = safeId(tab.id + '-trouble');
  sec.append(el('h3', 'guide-h', '困ったとき'));
  const dl = el('dl', 'guide-trouble');
  (tab.trouble || []).forEach((t) => { dl.append(el('dt', '', t.q), el('dd', '', t.a)); });
  sec.append(dl);
  return sec;
}

function drawTabs() {
  const bar = document.getElementById('guide-tabs'); bar.replaceChildren();
  guide.data.tabs.forEach((tab) => {
    const b = el('button', 'guide-tab'); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.tab = safeId(tab.id);
    b.setAttribute('aria-selected', String(tab.id === guide.tab));
    b.append(el('strong', '', tab.label), el('span', '', tab.title));
    if (tab.id === guide.data.role) b.append(el('small', 'guide-tab-you', 'あなた'));
    b.addEventListener('click', () => { openTab(tab.id); scroller().scrollTop = 0; history.replaceState(null, '', '#' + safeId(tab.id)); });
    bar.append(b);
  });
}

function openTab(id) {
  const tab = guide.data.tabs.find((t) => t.id === id) || guide.data.tabs[0];
  guide.tab = tab.id;
  drawTabs();
  const toc = document.getElementById('guide-toc'); toc.replaceChildren();
  const content = document.getElementById('guide-content'); content.replaceChildren();
  content.setAttribute('role', 'tabpanel'); content.setAttribute('aria-label', tab.label + '・' + tab.title);
  if (tab.lead) content.append(el('p', 'guide-lead', tab.lead));
  const items = (tab.sections || []).map((s) => ({ id: safeId(s.id), title: s.title })).concat((tab.trouble || []).length ? [{ id: safeId(tab.id + '-trouble'), title: '困ったとき' }] : []);
  (tab.sections || []).forEach((s) => content.append(sectionNode(s)));
  if ((tab.trouble || []).length) content.append(troubleNode(tab));
  toc.append(el('p', 'guide-toc-title', tab.label + 'の目次'));
  items.forEach((it) => {
    const a = el('a', 'guide-toc-link', it.title); a.href = '#' + it.id; a.dataset.target = it.id;
    a.addEventListener('click', (e) => { e.preventDefault(); jumpTo(it.id); history.replaceState(null, '', '#' + it.id); });
    toc.append(a);
  });
  spy();
}

// ------------------------------------------------------------ 目次と本文の連動（scroll-spy）・すっと動かして着地を光らせる
function jumpTo(id) {
  const target = document.getElementById(id); const box = scroller(); if (!target || !box) return;
  guide.pinned = id; markToc(id);
  const top = Math.max(0, box.scrollTop + (target.getBoundingClientRect().top - box.getBoundingClientRect().top) - 12);
  const land = () => { box.scrollTop = top; target.classList.add('is-landed'); window.setTimeout(() => target.classList.remove('is-landed'), 1400); };
  if (document.visibilityState === 'hidden' || typeof requestAnimationFrame !== 'function') { land(); return; }
  const from = box.scrollTop; const start = performance.now(); const dur = 260; let done = false;
  const step = (now) => { if (done) return; const t = Math.min(1, (now - start) / dur); box.scrollTop = from + (top - from) * (1 - Math.pow(1 - t, 3)); if (t < 1) requestAnimationFrame(step); else { done = true; land(); } };
  requestAnimationFrame(step);
  window.setTimeout(() => { if (!done) { done = true; land(); } }, dur + 90); // 動かない画面でも、必ず着地させる
}
function markToc(id) { document.querySelectorAll('.guide-toc-link').forEach((a) => { const on = a.dataset.target === id; a.classList.toggle('is-current', on); if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); }); }
function spy() {
  const box = scroller(); if (!box) return;
  if (guide.pinned) { markToc(guide.pinned); return; }
  const cards = [...document.querySelectorAll('#guide-content .guide-section-card')]; if (!cards.length) return;
  const top = box.getBoundingClientRect().top + 90;
  let current = cards[0].id;
  cards.forEach((c) => { if (c.getBoundingClientRect().top <= top) current = c.id; });
  if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) { const seen = cards.filter((c) => c.getBoundingClientRect().top < box.getBoundingClientRect().bottom); if (seen.length) current = seen[seen.length - 1].id; }
  markToc(current);
}

/** アドレスの # から開く（役割のタブ・節・画面の「?」の行き先） */
function openFromHash() {
  const id = safeId(decodeURIComponent(location.hash.slice(1)));
  if (!guide.data) return;
  const tabs = guide.data.tabs;
  if (!id) { openTab(guide.tab || guide.data.role); return; }
  if (tabs.some((t) => t.id === id)) { openTab(id); return; }
  let target = id;
  const alias = guide.data.aliases && guide.data.aliases[id];
  if (alias) target = safeId(alias[guide.data.role] || alias.store || '');
  const owner = tabs.find((t) => (t.sections || []).some((s) => s.id === target) || t.id + '-trouble' === target);
  if (!owner) { openTab(guide.tab || guide.data.role); return; }
  openTab(owner.id);
  window.setTimeout(() => jumpTo(target), 30);
}

// ------------------------------------------------------------ 古い形（GAS がまだ 0.2.2 のとき）も読めるようにする
function renderOld(sections) {
  const content = document.getElementById('guide-content'); content.replaceChildren();
  (sections || []).forEach((item) => {
    const sec = el('section', 'guide-section-card'); sec.id = safeId(item.id); sec.append(el('h3', 'guide-h', item.title));
    (item.paragraphs || []).forEach((p) => sec.append(el('p', '', p)));
    (item.bullets || []).forEach((b) => { const ul = el('ul', 'guide-tips'); b.forEach((t) => ul.append(el('li', '', t))); sec.append(ul); });
    (item.steps || []).forEach((st) => { const ol = el('ol', 'guide-steps'); st.forEach((t) => ol.append(el('li', '', t))); sec.append(ol); });
    content.append(sec);
  });
}

function renderGuide(data) {
  const status = document.getElementById('guide-status');
  document.getElementById('guide-root').hidden = false;
  if (!data || !Array.isArray(data.tabs)) { renderOld(data && data.sections); status.hidden = true; return; }
  guide.data = data; guide.tab = data.role;
  drawFlow(data.flow, data.role);
  status.hidden = true;
  openFromHash();
}

function readSessionToken() {
  try { const o = JSON.parse(localStorage.getItem(GUIDE_SESSION_KEY) || 'null'); return o && typeof o.t === 'string' && Date.now() < Number(o.e) ? o.t : ''; } catch { return ''; }
}

async function loadGuide() {
  const status = document.getElementById('guide-status');
  const session = readSessionToken();
  if (!session) return;
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(GUIDE_GAS_URL)) { status.textContent = '利用ガイドの接続の準備中です。'; return; }
  try {
    const response = await fetch(GUIDE_GAS_URL, {
      method: 'POST', mode: 'cors', redirect: 'follow', cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'getGuide', session: session, data: {} })
    });
    const result = await response.json();
    if (!response.ok || !result || result.ok !== true) throw new Error('guide unavailable');
    renderGuide(result.data || {});
  } catch {
    status.textContent = 'ガイドを読み込めませんでした。発注画面でログインし直してから、もう一度開いてください。';
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const box = scroller();
  if (box) {
    box.addEventListener('scroll', () => { window.cancelAnimationFrame(guide.spyTimer); guide.spyTimer = window.requestAnimationFrame(spy); }, { passive: true });
    ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach((ev) => box.addEventListener(ev, () => { guide.pinned = ''; }, { passive: true }));
  }
  loadGuide();
});
window.addEventListener('hashchange', openFromHash);
