'use strict';
// 利用ガイド（版 livestock-order-api-0.2.2）。本文はログインの後に GAS から受け取る（画面には本文を置かない）。

const GUIDE_SESSION_KEY = 'livestock-order-session-v2';
const GUIDE_GAS_URL = String((window.APP_CONFIG && window.APP_CONFIG.gasUrl) || '');

function openHashSection() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) return;
  const section = document.getElementById(id);
  const details = section && section.querySelector('details');
  if (details) { details.open = true; section.scrollIntoView({ block: 'start' }); }
}

function addText(parent, tag, value) {
  const node = document.createElement(tag);
  node.textContent = String(value || '');
  parent.append(node);
}

function renderGuide(sections) {
  const root = document.getElementById('guide-content');
  const status = document.getElementById('guide-status');
  root.replaceChildren();
  (sections || []).forEach((item) => {
    const section = document.createElement('section');
    section.id = String(item.id || '').replace(/[^A-Za-z0-9_-]/g, '');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = String(item.title || '');
    const body = document.createElement('div');
    body.className = 'guide-detail';
    (item.paragraphs || []).forEach((paragraph) => addText(body, 'p', paragraph));
    (item.steps || []).forEach((steps) => { const list = document.createElement('ol'); steps.forEach((step) => addText(list, 'li', step)); body.append(list); });
    (item.bullets || []).forEach((bullets) => { const list = document.createElement('ul'); bullets.forEach((bullet) => addText(list, 'li', bullet)); body.append(list); });
    details.append(summary, body);
    section.append(details);
    root.append(section);
  });
  status.hidden = true;
  openHashSection();
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
    renderGuide((result.data && result.data.sections) || []);
  } catch {
    status.textContent = 'ガイドを読み込めませんでした。発注画面でログインし直してから、もう一度開いてください。';
  }
}

window.addEventListener('DOMContentLoaded', loadGuide);
window.addEventListener('hashchange', openHashSection);
