(() => {
  'use strict';
  // 畜産発注の画面（版 livestock-order-api-0.2.4）。業務データ・アカウント表・鍵は置かない。だれか・何ができるかは、毎回 GAS が決める。
  // 信頼境界: GAS から届く文字（商品名・店名など）は、人が打った文字。画面に出すときは textContent か esc() を通す。
  const APP_VERSION = 'livestock-order-api-0.2.4';
  const CONFIG = window.APP_CONFIG || {};
  const GAS_URL = String(CONFIG.gasUrl || '');
  const GAS_URL_OK = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(GAS_URL);
  const REDIRECT_URI = String(CONFIG.oauthRedirectUri || '');
  const SESSION_KEY = 'livestock-order-session-v2';
  const DRAFT_KEY = 'livestock-order-draft-v1';
  const SESSION_MSG = 'ログインの期限が切れました。もう一度ログインしてください。';
  const GIVEUP_MS = 30000; // 返事を待つのは 30 秒まで（それより長いと、固まったと思われる）
  const L = window.LivestockLogin;
  const SN = window.SearchNorm || null;
  const PS = window.ProductSheet || null; // 登録用紙を読む・確かめる部品（product-sheet.js）
  const OB = window.OrderBook || null;    // Excel を作る部品・確定と未確定の決まり（order-book.js）
  const state = { clientId: '', serverVersion: '', session: null, data: null, view: 'week', search: '', terms: null, matches: null, keys: new Map(), tokenClient: null, tokenJob: null, gisLoading: null, loggingIn: false, leaving: false, searchTimer: 0, pending: new Map(), capPending: new Map(), weekKey: '' };
  // pending: 保存していない入力（日付・商品・店 → 数）。週のタブを切り替えても消えないよう、画面でなくここに持つ。weekKey: 開いている週（週の最初の日）

  const $ = (selector) => document.querySelector(selector);
  const text = (node, value) => { if (node) node.textContent = value == null ? '' : String(value); };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const setStatus = (label, ready) => { text($('#status-label'), label); $('.live-dot')?.classList.toggle('is-ready', Boolean(ready)); };
  const appError = (message, code) => { const e = new Error(message); e.code = code || 'ERROR'; return e; };
  const store = (kind) => { try { return kind === 'local' ? window.localStorage : window.sessionStorage; } catch { return null; } };

  // ------------------------------------------------------------ 通信
  async function api(action, data = {}, authenticated = true) {
    if (!GAS_URL_OK) throw appError('GASの接続先が、まだ設定されていません。導入の担当へ連絡してください。', 'SETUP');
    const body = { action, data };
    if (data && data.requestId) body.requestId = data.requestId;
    if (authenticated) {
      if (!state.session || Date.now() > state.session.e) { clearSession(); throw appError(SESSION_MSG, 'SESSION'); }
      body.session = state.session.t;
    }
    const sent = body.session;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let gaveUp = false;
    const timer = controller ? window.setTimeout(() => { gaveUp = true; controller.abort(); }, GIVEUP_MS) : 0; // 30 秒で止める（いつまでも待たせない）
    const t0 = performance.now();
    let response;
    const noReply = () => appError(gaveUp ? '30 秒たっても返事がありません。通信を確かめて、もう一度お試しください（入れた数は消えません）。' : '通信できませんでした。電波の良い所で、もう一度お試しください。', 'NETWORK');
    try { response = await fetch(GAS_URL, { method: 'POST', mode: 'cors', redirect: 'follow', cache: 'no-store', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), signal: controller?.signal }); }
    catch { if (timer) window.clearTimeout(timer); perfNote('api:' + action, t0, 'error'); throw noReply(); }
    if (!response.ok) { if (timer) window.clearTimeout(timer); throw appError(`通信に失敗しました（${response.status}）。時間をおいて、もう一度お試しください。`, 'NETWORK'); }
    let result;
    try { result = await response.json(); } catch { throw gaveUp ? noReply() : appError('サーバーの返事を読めませんでした。少し待ってから、もう一度お試しください。', 'NETWORK'); }
    finally { if (timer) window.clearTimeout(timer); } // 返事を読み終えるまでが 30 秒
    perfNote('api:' + action, t0);
    if (result && result.version) noteServerVersion(result.version);
    if (!result || result.ok !== true) {
      const error = appError(result?.message || '処理を完了できませんでした。', result?.code || 'ERROR');
      if (error.code === 'SESSION' && authenticated && state.session && state.session.t === sent) clearSession();
      throw error;
    }
    return result.data;
  }

  function noteServerVersion(version) {
    state.serverVersion = String(version || '');
    const node = $('#app-version'); if (!node) return;
    const mismatch = state.serverVersion && state.serverVersion !== APP_VERSION;
    text(node, mismatch ? `画面 ${APP_VERSION} ／ GAS ${state.serverVersion}（版が食い違っています）` : `版 ${APP_VERSION}`);
    node.classList.toggle('is-mismatch', Boolean(mismatch));
  }

  // ------------------------------------------------------------ アプリの札（端末に7日）
  function readSession() {
    try { const o = JSON.parse(store('local')?.getItem(SESSION_KEY) || 'null'); if (!o || typeof o.t !== 'string' || !o.e || Date.now() > o.e - 60000) return null; return { t: o.t, e: Number(o.e) }; } catch { return null; }
  }
  function saveSession(value) { state.session = value; try { store('local')?.setItem(SESSION_KEY, JSON.stringify(value)); } catch {} }
  function clearSession() { state.session = null; try { store('local')?.removeItem(SESSION_KEY); } catch {} }

  // ------------------------------------------------------------ お知らせ
  function showNotice(message, kind = 'info', title, retry) {
    const box = $('#notice');
    box.querySelector('.notice-retry')?.remove();
    if (!message) { box.hidden = true; return; }
    box.hidden = false;
    box.className = `notice ${kind === 'error' ? 'notice-error' : 'notice-info'}`;
    text(box.querySelector('.notice-icon'), kind === 'error' ? '!' : 'i');
    const copy = box.querySelector('div'); copy.replaceChildren();
    const strong = document.createElement('strong'); strong.textContent = title || (kind === 'error' ? '確かめてください' : 'お知らせ');
    const p = document.createElement('p'); p.textContent = message; copy.append(strong, p);
    if (retry) { const b = makeButton('もう一度', () => { b.remove(); retry(); }, 'button button-secondary notice-retry'); box.append(b); }
  }
  function toast(message, error = false, retry) {
    const node = $('#toast'); text(node, message); node.classList.toggle('is-error', error); node.hidden = false;
    if (retry) { const b = makeButton('もう一度', () => { node.hidden = true; retry(); }, 'button button-secondary toast-retry'); node.append(b); }
    window.clearTimeout(toast.timer); toast.timer = window.setTimeout(() => { node.hidden = true; }, retry ? 12000 : 5200);
  }
  // ------------------------------------------------------------ 待ちの印（PO 2026-10-28「フリーズ誤認防止」）
  //   押した所のすぐそばに、動く印（スピナー）と文字。8 秒で「時間がかかっています」、30 秒で通信を止めて理由と「もう一度」（api の GIVEUP_MS）。
  //   画面ぜんたいの幕（#progress）は、開くとき・ログイン・月の切り替えのように画面ぜんたいが待つときだけ。待っている間は、そのボタンを押せない（薄く）
  const SLOW_MS = 8000;
  const SLOW_TEXT = '時間がかかっています（通信を確かめています）…';
  function spinner() { const s = document.createElement('span'); s.className = 'spinner'; s.setAttribute('aria-hidden', 'true'); return s; }
  /** ボタンを待ちの形にする（印＋文字・押せない）。返す値: 元に戻す関数（stage(文字) で段階の文字を替える） */
  function busyButton(button, label) {
    if (!button) { const noop = () => {}; noop.stage = () => {}; return noop; }
    const original = button.dataset.idleLabel || button.textContent; button.dataset.idleLabel = original;
    const show = (t) => { button.replaceChildren(spinner(), document.createTextNode(t)); };
    button.disabled = true; button.classList.add('is-busy'); button.setAttribute('aria-busy', 'true'); show(label);
    let slow = window.setTimeout(() => show(SLOW_TEXT), SLOW_MS);
    const done = () => { window.clearTimeout(slow); button.disabled = false; button.classList.remove('is-busy'); button.removeAttribute('aria-busy'); button.textContent = original; delete button.dataset.idleLabel; };
    done.stage = (t) => { show(t); window.clearTimeout(slow); slow = window.setTimeout(() => show(SLOW_TEXT), SLOW_MS); };
    return done;
  }
  let progressSlow = 0;
  function showProgress(message) {
    const node = $('#progress'); if (!node) return;
    text(node.querySelector('span'), message); node.hidden = false;
    window.clearTimeout(progressSlow); progressSlow = window.setTimeout(() => text(node.querySelector('span'), SLOW_TEXT), SLOW_MS);
  }
  function hideProgress() { window.clearTimeout(progressSlow); const node = $('#progress'); if (node) node.hidden = true; }
  /** 表を読む間の仮の行（形だけ）。空白のままにしない */
  function renderSkeleton(message) {
    const host = $('#order-content'); if (!host) return;
    host.innerHTML = `<div class="skeleton-card" aria-hidden="true">${'<div class="skeleton-row"><i></i><i></i><i></i><i></i></div>'.repeat(6)}</div>`;
    host.dataset.week = '';
    const p = document.createElement('p'); p.className = 'skeleton-note'; p.setAttribute('role', 'status'); p.append(spinner(), document.createTextNode(message || '読み込み中…')); host.prepend(p);
  }
  // 速さの記録（画面の中の時間）。中身（数・名前）は持たない。操作の名前とミリ秒だけ、新しい 60 件
  const perfLog = [];
  function perfNote(what, t0, note) { perfLog.push({ what, ms: Math.round(performance.now() - t0), note: note || '', at: Date.now() }); if (perfLog.length > 60) perfLog.shift(); }
  window.__livestockPerf = perfLog;

  // ------------------------------------------------------------ ログイン
  const LOGIN_HELP = {
    popup_failed_to_open: 'ログインの窓を開けませんでした。ブラウザのポップアップを許可してから、もう一度押してください。',
    popup_closed: 'ログインの窓が閉じられました。もう一度「Googleでログイン」を押してください。',
    slow: 'ログインの窓が出ないときは、もう一度押してください。',
    redirect_state: 'ログインを完了できませんでした（時間が経ちすぎたか、別の画面で戻りました）。もう一度「Googleでログイン」を押してください。',
    redirect_denied: 'ログインが取り消されました。もう一度「Googleでログイン」を押してください。',
    redirect_failed: 'ログインを完了できませんでした。もう一度「Googleでログイン」を押してください。',
    redirect_going: 'Googleのログイン画面へ移動しています…',
    redirect_slow: 'Googleのログイン画面へ移動できませんでした。通信や社内のネットワークを確かめて、もう一度押してください。',
    gis_missing: 'Googleのログインの部品を読み込めませんでした。通信を確かめて、画面を読み込み直してください。',
    unknown: 'ログインを続けられませんでした。もう一度押してください。'
  };
  function setLoginHelp(message) { text($('#login-help'), message); }
  function showLoginHelpKind(kind) { setLoginHelp(LOGIN_HELP[kind] || LOGIN_HELP.unknown); }
  function setLoginButton(enabled, label) { const b = $('#login-button'); b.disabled = !enabled; text(b, label); }
  function isStandalone() { try { return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches; } catch { return false; } }
  function entryUrl() { return location.origin + location.pathname.replace(/[^/]*$/, ''); }

  function renderInAppWarning() {
    const box = $('#inapp-warning'); if (!box || !L) return;
    const advice = L.inAppAdvice(L.detectBrowser(navigator.userAgent, isStandalone()));
    if (!advice) { box.hidden = true; return; }
    box.replaceChildren();
    const title = document.createElement('strong'); title.textContent = advice.title;
    const p = document.createElement('p'); p.textContent = advice.text;
    box.append(title, p);
    const url = entryUrl();
    const button = document.createElement('button'); button.type = 'button'; button.className = 'button button-primary';
    if (advice.action === 'line') { button.textContent = 'ブラウザで開く'; button.addEventListener('click', () => { location.href = url + '?openExternalBrowser=1'; }); }
    else if (advice.action === 'chrome') { button.textContent = 'Chrome で開く'; button.addEventListener('click', () => { location.href = L.chromeIntentUrl(url); }); }
    else { button.textContent = 'アドレスをコピー'; button.addEventListener('click', () => { try { navigator.clipboard.writeText(url).then(() => toast('コピーしました。Safari に貼り付けて開いてください。'), () => {}); } catch {} }); }
    box.append(button);
    const hint = document.createElement('p'); hint.textContent = `うまく開かないときは、下のアドレスを長押ししてコピーし、${advice.browser} に貼り付けてください。`;
    const code = document.createElement('code'); code.className = 'inapp-url'; code.textContent = url;
    box.append(hint, code); box.hidden = false;
  }

  function beginLogin() {
    if (state.loggingIn || !state.clientId || !L) return;
    const choice = L.chooseMode({ ua: navigator.userAgent, standalone: isStandalone(), redirectUri: REDIRECT_URI, origin: location.origin, hasUnsaved: pendingCount() > 0 });
    if (choice.mode === 'redirect') startRedirectLogin(); else startPopupLogin();
  }

  function startRedirectLogin() {
    saveDraft();
    let st;
    try { st = L.randomState(window.crypto); L.rememberState(store('local'), st, Date.now()); }
    catch { showLoginHelpKind('redirect_failed'); return; }
    state.leaving = true;
    setLoginButton(false, 'Googleへ移動しています…'); showLoginHelpKind('redirect_going');
    location.assign(L.buildRedirectUrl(state.clientId, REDIRECT_URI, st));
    window.setTimeout(() => { state.leaving = false; setLoginButton(true, 'Googleでログイン'); showLoginHelpKind('redirect_slow'); }, 15000);
  }

  /** Google のログインの部品（窓の方式だけで使う）。ふだんの道（同じタブで移って戻る）では読み込まない＝ほかの会社のスクリプトを動かさない */
  function loadGis() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (state.gisLoading) return state.gisLoading;
    state.gisLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = () => resolve(); s.onerror = () => { state.gisLoading = null; reject(new Error('gis')); };
      document.head.append(s);
    });
    return state.gisLoading;
  }
  /** 窓の方式になりそうなとき（アプリの中の画面・ホーム画面のアプリ・手元・PC で入力の途中）は、押す前に読んでおく（押してから読むと、窓が止められやすい） */
  function preloadGisIfPopup(hasUnsaved) {
    if (!L || !state.clientId) return;
    const choice = L.chooseMode({ ua: navigator.userAgent, standalone: isStandalone(), redirectUri: REDIRECT_URI, origin: location.origin, hasUnsaved: Boolean(hasUnsaved) });
    if (choice.mode === 'popup') loadGis().catch(() => {});
  }

  async function startPopupLogin() {
    if (!window.google?.accounts?.oauth2) {
      setLoginButton(false, 'ログインの窓を開いています…');
      try { await loadGis(); } catch { setLoginButton(true, 'Googleでログイン'); showLoginHelpKind('gis_missing'); return; }
    }
    if (!state.tokenClient) {
      state.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: state.clientId, scope: 'openid email profile', prompt: 'select_account',
        callback: (resp) => { if (state.tokenJob) state.tokenJob.onResponse(resp); },
        error_callback: (err) => { if (state.tokenJob) state.tokenJob.onError(err); }
      });
    }
    const slow = window.setTimeout(() => { setLoginButton(true, 'Googleでログイン'); showLoginHelpKind('slow'); }, 20000);
    state.tokenJob = {
      onResponse(resp) {
        window.clearTimeout(slow); state.tokenJob = null;
        if (resp && resp.access_token) finishLogin(resp.access_token);
        else { setLoginButton(true, 'Googleでログイン'); showLoginHelpKind(resp && resp.error === 'access_denied' ? 'redirect_denied' : 'unknown'); }
      },
      onError(err) {
        const type = (err && err.type) || 'unknown';
        setLoginButton(true, 'Googleでログイン');
        if (type === 'popup_closed') { showLoginHelpKind('popup_closed'); return; } // 後から返事が届く端末があるので、待ちは残す
        window.clearTimeout(slow); state.tokenJob = null; showLoginHelpKind(type === 'popup_failed_to_open' ? 'popup_failed_to_open' : 'unknown');
      }
    };
    setLoginButton(false, 'ログインの窓を開いています…'); setLoginHelp('');
    try { state.tokenClient.requestAccessToken(); } catch { window.clearTimeout(slow); state.tokenJob = null; setLoginButton(true, 'Googleでログイン'); showLoginHelpKind('unknown'); }
  }

  /** Google の札を GAS に確かめてもらい、アプリの札を受け取る（Google の札はここで捨てる・端末に残さない） */
  async function finishLogin(accessToken) {
    state.loggingIn = true;
    const keep = pendingChanges(); const draft = readDraft();
    showProgress('ログインして、注文を読み込んでいます…'); setLoginButton(false, '確かめています…');
    const t0 = performance.now();
    try {
      const month = (keep && keep.month) || (draft && draft.month) || '';
      const data = await api('startSession', { accessToken, withWorkspace: true, month }, false); // 札と、その後の読み込みを1回の通信で
      saveSession({ t: data.session, e: Number(data.expiresAt) || Date.now() + 7 * 86400000 });
      if (data.workspace) applyWorkspace(data.workspace, { reapply: keep, restoreDraft: true });
      else await refreshWorkspace(month || undefined, { reapply: keep, restoreDraft: true });
      perfNote('login', t0);
    } catch (error) {
      clearSession(); showLoginPanel(error.message, error.code === 'SESSION' ? 'info' : 'error');
    } finally {
      state.loggingIn = false; hideProgress(); setLoginButton(true, 'Googleでログイン');
    }
  }

  function showLoginPanel(message, kind = 'error') {
    const hasPending = pendingCount() > 0 && !$('#workspace').hidden;
    $('#login-panel').hidden = false;
    if (!hasPending) { $('#workspace').hidden = true; $('#period-control').hidden = true; $('#signout-button').hidden = true; text($('#account-label'), '未ログイン'); }
    setStatus('ログインしてください', false);
    if (message) showNotice(hasPending ? message + '　保存していない入力は、ログインし直すと戻ります。' : message, kind);
    preloadGisIfPopup(hasPending);
    $('#login-panel').scrollIntoView({ block: 'nearest' });
  }

  function signOut() {
    if (pendingCount() && !window.confirm('保存できていない欄（保存中・⚠）があります。ログアウトすると消えます。ログアウトしますか？')) return;
    if (state.session) api('endSession', { requestId: requestId() }).catch(() => {});
    clearSession(); state.data = null; clearPendingMarks(); stopRemainPolling(); remain.at = '';
    $('#workspace').hidden = true; $('#period-control').hidden = true; $('#signout-button').hidden = true; $('#login-panel').hidden = false;
    showNotice(''); text($('#account-label'), '未ログイン'); setStatus('ログアウトしました', false); setLoginHelp('会社のアカウント（本部・店舗）を選んでください。');
  }

  // ------------------------------------------------------------ 画面
  async function refreshWorkspace(month, opts = {}) {
    try {
      const payload = await api('getWorkspace', { month: month || $('#month-select').value || '' });
      applyWorkspace(payload, opts);
    } catch (error) {
      if (error.code === 'SESSION' || error.code === 'DENIED' || error.code === 'LOGIN') { showLoginPanel(error.message, error.code === 'SESSION' ? 'info' : 'error'); }
      else { setStatus('情報を取得できません', false); showNotice(error.message, 'error', '', () => { showProgress('読み込み中…'); refreshWorkspace(month, opts).catch(() => {}).finally(hideProgress); });
        if (state.data) renderWorkspace(); // 読めなかったときは、いま持っている月の表に戻す（仮の行のままにしない）
        else { const host = $('#order-content'); if (host) host.innerHTML = emptyState('注文を読み込めませんでした。', '上の「もう一度」を押してください。入れた数は、この端末に残っています。'); } }
      throw error;
    }
  }
  /** 受け取った中身（getWorkspace・ログインの返事）を画面にする */
  function applyWorkspace(payload, opts = {}) {
    {
      const t0 = performance.now();
      state.data = payload; buildSearchKeys(); // pending（保存できていない欄）は残す（自動保存の途中の読み直しで消さない）
      $('#login-panel').hidden = true; $('#workspace').hidden = false; $('#period-control').hidden = false; $('#signout-button').hidden = false;
      const who = payload.principal || {};
      text($('#account-label'), who.shortLabel || who.label || who.email || 'ログイン中'); $('#account-label').title = who.label || who.email || '';
      setStatus('接続中', true); showNotice('');
      if (!remain.at) remain.at = nowLabel(); startRemainPolling();
      renderWorkspace();
      if (opts.reapply && opts.reapply.month === payload.month?.month) { const n = applyChanges(opts.reapply.changes); if (n) toast(`保存できていなかった入力を ${n} 件戻しました。自動で保存します。`); }
      if (opts.restoreDraft) restoreDraft();
      perfNote('render:workspace', t0);
    }
  }

  function renderWorkspace() {
    const data = state.data; if (!data) return;
    const config = data.month || {};
    const select = $('#month-select'); select.replaceChildren();
    const months = Array.isArray(data.months) ? data.months.slice() : [];
    if (config.month && !months.some((m) => m.month === config.month)) months.push({ month: config.month, label: `${config.label || config.month}（未設定）` });
    months.sort((a, b) => String(a.month).localeCompare(String(b.month)));
    months.forEach((item) => { const opt = document.createElement('option'); opt.value = item.month; opt.textContent = item.label || item.month; opt.selected = item.month === config.month; select.append(opt); });
    $('#excel-button').hidden = !(data.principal?.role === 'BY' || data.principal?.role === 'WAREHOUSE'); // 押せる人は GAS も確かめる
    renderSummary(data, config);
    renderRoleNotice(data, config);
    renderLeadWarning(data);
    renderRoleActions(data, config);
    renderOrders();
  }

  /** 商品マスターの知らせ（BY だけ・2つに分ける）。押すと、その商品の編集へ（空の欄に印）
   *   締切が未設定＝店で注文できない（すぐ直す）。埋めていない項目（メーカー・規格・JAN・入数・原価・売価のどれか）＝注文はできる（あとで埋める） */
  function productGaps() {
    const list = masterProducts();
    return { noLead: list.filter((p) => OB && OB.leadDaysOf(p.leadDays) === null), unfilled: PS ? list.filter((p) => PS.missingFields(p).length) : [] };
  }
  function gapNotice(kind, products, title, note) {
    const box = document.createElement('div'); box.className = 'product-notice is-' + kind;
    const head = document.createElement('p'); head.className = 'product-notice-head';
    const strong = document.createElement('strong'); strong.textContent = `${title} ${products.length} 件`;
    const small = document.createElement('span'); small.textContent = note;
    head.append(strong, small);
    const chips = document.createElement('div'); chips.className = 'product-notice-list';
    products.slice(0, 12).forEach((p) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'lead-chip';
      b.textContent = p.name || '（名前なし）';
      if (kind === 'fill' && PS) { const m = document.createElement('small'); m.textContent = '空: ' + PS.missingLabel(PS.missingFields(p)); b.append(m); }
      b.addEventListener('click', () => openProductEditor(p)); chips.append(b);
    });
    if (products.length > 12) { const more = document.createElement('span'); more.className = 'product-notice-more'; more.textContent = `ほか ${products.length - 12} 件（「商品マスター」の印）`; chips.append(more); }
    box.append(head, chips);
    return box;
  }
  function renderLeadWarning(data) {
    const host = $('#lead-warning'); if (!host) return;
    const gaps = data.principal?.role === 'BY' ? productGaps() : { noLead: [], unfilled: [] };
    host.replaceChildren(); host.hidden = !gaps.noLead.length && !gaps.unfilled.length; if (host.hidden) return;
    if (gaps.noLead.length) host.append(gapNotice('lead', gaps.noLead, '締切が未設定の商品', '店で注文できません。押して、すぐ「締切（何日前）」を入れてください。'));
    if (gaps.unfilled.length) host.append(gapNotice('fill', gaps.unfilled, '埋めていない項目がある商品', '注文はできます。押して、あとで埋めてください。'));
  }

  /** 利用区分・店・締切・状態を、1行の細い帯にまとめる（PO 2026-10-28「4枚の札を1行に」。表が画面の上の方から始まるように） */
  function renderSummary(data, config) {
    const principal = data.principal || {};
    const host = $('#summary-strip'); host.replaceChildren();
    const part = (label, value, cls, title) => { const s = document.createElement('span'); s.className = 'summary-item ' + (cls || ''); if (label) { const l = document.createElement('small'); l.textContent = label; s.append(l); } const b = document.createElement('b'); b.textContent = value; s.append(b); if (title) s.title = title; host.append(s); return s; };
    part('', principal.roleLabel || principal.role || '', 'is-role');
    if (principal.role === 'STORE') part('', principal.shortLabel || principal.label || '', 'is-store', principal.label || '');
    const dl = part('締切', config.deadline ? (OB ? OB.shortDeadline(config) : config.deadlineLabel) : '未設定', 'is-deadline', config.deadlineLabel || '');
    const help = document.createElement('a'); help.className = 'help-icon'; help.href = 'guide.html#deadline'; help.title = '締切と確定の説明'; help.setAttribute('aria-label', '締切と確定の説明を開く'); help.textContent = '?'; dl.append(help);
    part('', config.statusLabel || '', config.confirmed ? 'is-closed' : (config.deadline ? 'is-open' : 'is-wait'));
    const at = part('残数', remain.at ? `${remain.at} 時点` : '—', 'is-remain'); at.id = 'remain-at';
    const btn = document.createElement('button'); btn.type = 'button'; btn.id = 'refresh-button'; btn.className = 'button button-secondary refresh-button';
    if (remain.refreshing) { btn.disabled = true; btn.classList.add('is-busy'); btn.append(spinner(), document.createTextNode('更新中…')); } else btn.textContent = '更新'; btn.title = '在庫量・残数と、注文の数を読み直します（保存中の欄は、終わってから）';
    btn.addEventListener('click', refreshAll); host.append(btn);
  }

  function renderRoleNotice(data, config) {
    const host = $('#role-notice'); const role = data.principal?.role;
    let message = '', kind = 'info';
    if (role === 'STORE') {
      if (!config.deadline) { message = 'この月の締切は、まだ決まっていません。畜産BYが締切を入れると、注文を入れられます。'; kind = 'wait'; }
      else if (config.confirmed) { message = '締切を過ぎました（確定）。直すときは、畜産BYへ頼んでください。'; kind = 'wait'; }
      else message = '週はタブで切り替えます。日の欄にケース数を入れると、自動で保存されます（右上に「✓ 自動保存」）。'; // 締切は上の帯に1回だけ出す
    } else if (role === 'WAREHOUSE') message = '注文の入っていない欄は灰色です。注文と在庫量は、確定の後も直せます（入れると自動で保存）。';
    else if (role === 'BY' && !config.configured) { message = 'この月は、まだ用意していません。下の「この月を用意する」で締切を入れると、店舗にも表示されます。'; kind = 'wait'; }
    host.hidden = !message; text(host, message); host.className = `role-notice ${kind === 'wait' ? 'is-wait' : ''}`;
  }

  function renderRoleActions(data, config) {
    const role = data.principal?.role;
    const host = $('#role-actions'); host.replaceChildren();
    if (role === 'BY') {
      host.append(makeButton('月度設定', () => openSettings(), 'button button-secondary'));
      host.append(makeButton('商品マスター', () => openProductManager(), 'button button-secondary'));
      host.append(makeButton('操作履歴', () => openAuditLog(), 'button button-secondary'));
    }
    if (role === 'BY' || role === 'WAREHOUSE' || (role === 'STORE' && config.deadline && !config.confirmed)) { const ind = document.createElement('span'); ind.id = 'save-indicator'; ind.setAttribute('role', 'status'); ind.setAttribute('aria-live', 'polite'); host.append(ind); } // 保存のボタンは作らない（自動保存）。倉庫は在庫量
    renderIndicator();
  }

  function renderOrders() {
    const t0 = performance.now();
    try { renderOrdersNow(); } finally { perfNote('render:orders', t0); }
  }
  function renderOrdersNow() {
    const data = state.data; if (!data) return;
    const config = data.month || {};
    const host = $('#order-content');
    const products = filteredProducts(data.products || []);
    if (state.view === 'month') { host.innerHTML = renderMonthSummary(data, products, config); scrollToOwnColumn(host); return; }
    const weeks = Array.isArray(data.weeks) ? data.weeks : [];
    if (data.principal?.role === 'BY' && (!config.configured || !(data.products || []).length)) { renderSetupCard(host, config); return; }
    if (!weeks.length || !(data.products || []).length) { host.innerHTML = emptyState('この月の注文書は、まだ用意されていません。', '畜産BYが月を用意して商品を入れると、週ごとの表が出ます。'); return; }
    if (!products.length) { host.innerHTML = emptyState('探した商品は見つかりませんでした。', 'ひらがな・カタカナ・ローマ字・JANの一部でも探せます。空白で区切ると、どの語も含む商品だけが出ます。'); return; }
    // 週はタブで切り替える（PO 2026-10-28）。店は横に7日・BY と倉庫は縦に日付（日ごとの帯）
    const idx = currentWeekIndex(weeks); const week = weeks[idx];
    const before = host.querySelector('.table-scroll'); const keep = before && host.dataset.week === weekKeyOf(week) ? { top: before.scrollTop, left: before.scrollLeft } : null;
    state.weekKey = weekKeyOf(week); host.dataset.week = state.weekKey;
    const isStore = data.principal?.role === 'STORE';
    host.innerHTML = weekTabsMarkup(weeks, idx) + (isStore ? renderStoreWeek(week, data, products, config) : renderWeek(week, data, products, config, { bands: true }));
    setTheadHeights(host); markWeekTabs();
    const box = host.querySelector('.table-scroll'); if (keep && box) { box.scrollTop = keep.top; box.scrollLeft = keep.left; } else if (isStore && box) scrollToFirstOpenDay(box);
  }
  /** 店の7日の表: 入れられる最初の日（今日が月の中なら今日）が、商品の列のすぐ右に見えるように、横の位置を合わせる（スマホで探さない） */
  function scrollToFirstOpenDay(box) {
    const heads = [...box.querySelectorAll('thead th.day-head')]; const target = heads.find((th) => th.classList.contains('is-today') && !th.classList.contains('is-outside')) || heads.find((th) => !th.classList.contains('is-outside')); if (!target) return;
    const sticky = box.querySelector('thead th.sd-product'); const left = target.offsetLeft - (sticky ? sticky.offsetWidth : 0) - 8;
    if (target.offsetLeft + target.offsetWidth > box.clientWidth && left > 0) box.scrollLeft = left;
  }

  // ------------------------------------------------------------ 週のタブ
  const p2 = (n) => String(n).padStart(2, '0');
  function todayKey() { if (OB) return OB.jstToday(); const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; } // 日本時間の今日
  const md = (date) => { const [, m, d] = String(date).split('-').map(Number); return `${m}/${d}`; };
  const WEEKDAY = '日月火水木金土';
  const weekdayOf = (date) => { const [y, m, d] = String(date).split('-').map(Number); return new Date(y, m - 1, d).getDay(); };
  const dayClass = (date) => { const w = weekdayOf(date); return w === 6 ? 'is-sat' : (w === 0 ? 'is-sun' : ''); };
  const weekKeyOf = (week) => String((week.rows && week.rows[0] && week.rows[0].date) || week.label || '');
  const weekDates = (week) => [...new Set((week.rows || []).map((r) => r.date))];
  /** 開く週: 選んだ週 → 今日を含む週 → 対象月の最初の週 */
  function currentWeekIndex(weeks) {
    let i = weeks.findIndex((w) => weekKeyOf(w) === state.weekKey); if (i >= 0) return i;
    const today = todayKey(); i = weeks.findIndex((w) => weekDates(w).includes(today)); if (i >= 0) return i;
    i = weeks.findIndex((w) => (w.rows || []).some((r) => r.inMonth !== false)); return i >= 0 ? i : 0;
  }
  function weekTabsMarkup(weeks, active) {
    const today = todayKey();
    return `<div class="week-tabs" role="tablist" aria-label="週を選ぶ">${weeks.map((w, i) => { const dates = weekDates(w); const key = weekKeyOf(w); return `<button type="button" role="tab" class="week-tab ${i === active ? 'is-active' : ''}" aria-selected="${i === active}" data-week="${esc(key)}"><b>${esc(w.label || '週')}</b><span>${esc(md(dates[0]))}〜${esc(md(dates[dates.length - 1]))}</span>${dates.includes(today) ? '<small class="tab-now">今週</small>' : ''}<i class="tab-pending" hidden></i></button>`; }).join('')}</div>`;
  }
  /** 保存していない入力がある週のタブに印（文字の印。色だけにしない） */
  function markWeekTabs() {
    document.querySelectorAll('.week-tab').forEach((tab) => {
      const week = (state.data?.weeks || []).find((w) => weekKeyOf(w) === tab.dataset.week); const mark = tab.querySelector('.tab-pending'); if (!week || !mark) return;
      const dates = new Set(weekDates(week)); const here = [...state.pending.values()].filter((c) => dates.has(c.date));
      const err = here.some((c) => c.status === 'error'); mark.textContent = err ? '⚠ 保存できない欄' : (here.length ? '保存中…' : ''); mark.hidden = !here.length;
      tab.classList.toggle('has-pending', here.length > 0); tab.classList.toggle('has-error', err);
    });
  }
  /** 日ごとの帯を、表の見出しのすぐ下に止める（見出しの高さを測って渡す・CSSOM なので CSP に当たらない） */
  function setTheadHeights(host) { host.querySelectorAll('table.order-table').forEach((t) => { const h = t.tHead ? t.tHead.getBoundingClientRect().height : 0; if (h) t.style.setProperty('--thead-h', Math.round(h) + 'px'); }); }

  /** 店の表（横に7日）: 行＝商品・列＝その週の7日・いちばん右に週の合計。自店の1列ぶんしか無いので、日を横に並べる */
  function renderStoreWeek(week, data, products, config) {
    const own = String(data.principal?.storeId || ''); const ownStore = (data.stores || []).find((s) => String(s.id) === own) || {};
    const today = todayKey(); const days = []; const seen = new Set();
    (week.rows || []).forEach((r) => { if (!seen.has(r.date)) { seen.add(r.date); days.push({ date: r.date, label: r.dateLabel, inMonth: r.inMonth !== false }); } });
    const byKey = new Map((week.rows || []).map((r) => [r.date + '|' + r.productId, r]));
    // 確定は 着く日×商品 で決まる（商品ごとの「何日前」）。日の見出しには、その日の全部の商品が同じときだけ「確定」か「〜M/D HH:MM」を出し、
    //   商品で違う日は「商品で違う」と出して、欄の中に印を出す（表の幅は広げない）
    const nowMs = Date.now();
    const dayInfo = new Map(days.map((d) => {
      if (!d.inMonth || !OB) return [d.date, { uniform: true, st: null }];
      const sts = products.map((p) => { const row = byKey.get(d.date + '|' + p.id); return row ? OB.rowStatus(row, config, p, nowMs) : null; }).filter(Boolean);
      const keyOf = (x) => (x.code === 'nolead' ? 'nolead' : x.locked ? 'locked' : x.code + '|' + x.until);
      return [d.date, { uniform: sts.length > 0 && sts.every((x) => keyOf(x) === keyOf(sts[0])), st: sts[0] || null }];
    }));
    const head = days.map((d) => {
      const info = dayInfo.get(d.date); const st = info.st;
      const mark = !d.inMonth ? '<span class="dh-out">月の外</span>' : !st ? '' : !info.uniform ? '<span class="row-status is-mixed" title="商品ごとに締切の日が違います。欄の印を見てください">商品で違う</span>'
        : st.code === 'nolead' ? `<span class="row-status is-nolead" title="${esc(st.label)}">未設定</span>` : st.locked ? `<span class="row-status is-${st.code}" title="${esc(st.label)}">確定</span>` : `<span class="row-status is-${st.code}" title="${esc(st.label)}">〜${esc(st.until)}</span>`;
      return `<th class="day-head ${dayClass(d.date)} ${d.date === today ? 'is-today' : ''} ${d.inMonth ? '' : 'is-outside'}"><span class="dh-date">${esc(md(d.date))}</span><span class="dh-wd">${WEEKDAY.charAt(weekdayOf(d.date))}</span>${d.date === today ? '<span class="dh-today">今日</span>' : ''}${mark}</th>`;
    }).join('');
    const body = products.map((p) => {
      let total = 0; let remaining = null;
      const cells = days.map((d) => {
        const row = byKey.get(d.date + '|' + p.id);
        const cls = `store-cell is-own day-cell ${dayClass(d.date)} ${d.date === today ? 'is-today' : ''}`;
        if (!row || !d.inMonth) return `<td class="${cls} is-outside"><span class="qty-view" aria-label="${esc(md(d.date))} 月の外">—</span></td>`;
        if (row.remaining != null) remaining = row.remaining;
        const pend = state.pending.get(pkey(row.date, String(row.productId), own)); const saved = row.quantities?.[own];
        const value = pend ? (pend.quantity == null ? '' : pend.quantity) : (saved == null || saved === '' ? '' : saved);
        total += Number(value) || 0;
        const st = OB ? OB.rowStatus(row, config, p, nowMs) : null; const mixed = !dayInfo.get(d.date).uniform;
        if (!cellEditable(row, own)) return `<td class="${cls} ${st && st.locked ? 'is-locked is-' + st.code : ''} ${value === '' ? 'is-empty' : 'has-qty'}" title="${esc(st ? st.label : '')}"><span class="qty-view" aria-label="${esc(md(d.date))} ${esc(p.name)} のケース数・${esc(st ? st.label : '')}">${value === '' ? '' : esc(value)}</span>${st && st.code === 'soldout' ? '<span class="sold-out">SOLD OUT</span>' : (st && st.code === 'nolead' ? '<span class="cell-lock is-nolead">未設定</span>' : (st && st.locked ? '<span class="cell-lock">確定</span>' : ''))}${editedMark(row, own)}</td>`;
        const k = pkey(row.date, String(row.productId), own);
        return `<td class="${cls} ${value === '' ? 'is-empty' : 'has-qty'} ${cellClass(k)}"><input aria-label="${esc(md(d.date))}（${WEEKDAY.charAt(weekdayOf(d.date))}） ${esc(p.name)} のケース数・${esc(st ? st.label : '')}" type="number" inputmode="numeric" min="0" step="1" value="${esc(value)}" data-order-input data-date="${esc(row.date)}" data-product="${esc(row.productId)}" data-store="${esc(own)}">${mixed && st && !st.locked ? `<span class="cell-until">〜${esc(st.until)}</span>` : ''}${editedMark(row, own)}${cellStateMarkup(k)}</td>`;
      }).join('');
      const noLead = OB && OB.leadDaysOf(p.leadDays) === null;
      return `<tr class="${noLead ? 'is-nolead-row' : ''}"><td class="col-product product-cell sd-product"><small class="sd-maker">${esc(p.manufacturer || '')}</small><strong>${esc(p.name || '')}</strong><small>${esc(p.specification || '')}　${esc(p.jan || '')}</small>${productDetailsMarkup(p)}${noLead ? '<small class="nolead-note">締切が未設定のため入れられません（畜産BYへ）</small>' : ''}${capHint(p.id, remaining)}</td>${cells}<td class="total-cell sd-total" data-week-total>${total || '—'}</td></tr>`;
    }).join('');
    const dates = days.map((d) => d.date);
    return `<section class="week-card store-week"><div class="week-heading"><h3>${esc(week.label || '週')}　${esc(md(dates[0]))}〜${esc(md(dates[dates.length - 1]))}</h3><span>自店: ${esc(ownStore.short || ownStore.name || '')}　<b class="unit-note">数はケース</b></span></div><div class="table-scroll"><table class="order-table store-week-table"><thead><tr><th class="col-product sd-product">商品・規格・JAN</th>${head}<th class="sd-total">週の合計</th></tr></thead><tbody>${body}</tbody></table></div>${legendLine()}</section>`;
  }
  /** 店の表: 打っている途中から、その行の週の合計を出し直す（保存の印は change で付ける） */
  function updateWeekTotal(input) {
    const tr = input.closest('tr'); const cell = tr && tr.querySelector('[data-week-total]'); if (!cell) return;
    const sum = [...tr.querySelectorAll('td.day-cell')].reduce((n, td) => { const i = td.querySelector('input'); const v = i ? Number(i.value) : Number(td.querySelector('.qty-view')?.textContent); return n + (Number.isFinite(v) ? v : 0); }, 0);
    cell.textContent = sum || '—';
  }

  /** 印刷は今までどおり、全部の週を縦に（日付×商品・横に店）。保存済みの数だけ（保存していない入力は入れない） */
  function fillPrintAll() {
    const host = $('#print-all'); if (!host) return;
    const data = state.data; host.replaceChildren(); document.body.classList.remove('print-all-weeks');
    if (!data || state.view === 'month') return;
    const products = filteredProducts(data.products || []);
    host.innerHTML = (data.weeks || []).map((w) => renderWeek(w, data, products, data.month || {}, { bands: true, readOnly: true })).join('');
    document.body.classList.add('print-all-weeks');
  }
  function clearPrintAll() { const host = $('#print-all'); if (host) host.replaceChildren(); document.body.classList.remove('print-all-weeks'); }

  /** 店の列の見出し: 短い店名（正式な名前はホバー）。数の単位（ケース）は表の上に1回だけ書く */
  function storeHeads(stores, ownId) {
    return stores.map((s) => { const own = String(s.id) === String(ownId); return `<th class="store-head ${own ? 'is-own' : ''}" title="${esc(s.name)}">${own ? '<span class="own-badge">自店</span>' : ''}${esc(s.short || s.name)}</th>`; }).join('');
  }
  /** 行の「確定・未確定」の小さな印（日付の下・表の幅を広げない）。決まりは order-book.js の rowStatus（印刷・Excel と同じ） */
  function statusMark(row, config, product) {
    if (!OB) return '';
    const st = OB.rowStatus(row, config, product); if (!st.code) return '';
    return `<span class="row-status is-${st.code}" title="${esc(st.label)}">${esc(st.mark)}</span>`;
  }
  /** その欄を BY・倉庫が直したときの小さな印（店の画面。店が自分の数と違うと迷わないように） */
  function editedMark(row, storeId) { const who = row && row.editedBy && row.editedBy[storeId]; return who ? `<span class="edited-by">${esc(who === '畜産BY' ? 'BY ' : who)}が直しました</span>` : ''; }
  /** 残数の印（1分ごとに読み直す・変わった商品は「更新」の文字を少しの間付ける） */
  function capHint(productId, remaining) {
    const changed = (remain.changed.get(String(productId)) || 0) > Date.now();
    return remaining == null ? '' : `<small class="cap-hint ${changed ? 'is-changed' : ''}" data-remain="${esc(productId)}">あと ${esc(remaining)} ケース注文できます${changed ? '<b class="remain-changed">更新</b>' : ''}</small>`;
  }
  function legendLine() { return OB ? `<p class="status-legend">${esc(OB.LEGEND)}</p>` : ''; }

  /**
   * BY・倉庫の表（と、全部の役割の印刷）: 縦に日付×商品・横に店。
   *   opts.bands: 日ごとに、表の幅いっぱいの日付の帯（土は青・日は赤の文字・今日の印）・日の間に太い線・日ごとに交互の薄い地。帯は縦に動かしても見出しの下に残る（日ごとの tbody の中で止まる）
   *   opts.readOnly: 入力の箱を出さない（印刷）。保存済みの数だけ
   */
  function renderWeek(week, data, products, config, opts = {}) {
    const stores = data.stores || []; const ownStoreId = data.principal?.storeId;
    const productIds = new Set(products.map((p) => String(p.id)));
    const byId = new Map((data.products || []).map((p) => [String(p.id), p]));
    const rows = (week.rows || []).filter((row) => productIds.has(String(row.productId)));
    const today = todayKey(); const ncols = stores.length + 4;
    const rowHtml = (row) => {
      const product = byId.get(String(row.productId)) || {};
      const soldOut = Boolean(row.soldOut);
      let total = 0;
      const cells = stores.map((st) => {
        const own = String(st.id) === String(ownStoreId);
        const pend = opts.readOnly ? null : state.pending.get(pkey(row.date, String(row.productId), String(st.id)));
        const saved = row.quantities?.[st.id];
        const value = pend ? (pend.quantity == null ? '' : pend.quantity) : (saved == null || saved === '' ? '' : saved);
        total += Number(value) || 0;
        const cls = `store-cell ${own ? 'is-own' : ''} ${value === '' ? 'is-empty' : 'has-qty'}`;
        // 書ける欄だけ入力の箱にする。見るだけの欄は数だけ（注文の無い欄は灰色）
        if (opts.readOnly || !cellEditable(row, st.id)) return `<td class="${cls}"><span class="qty-view" aria-label="${esc(st.name)}のケース数">${value === '' ? '' : esc(value)}</span></td>`;
        const k = pkey(row.date, String(row.productId), String(st.id));
        return `<td class="${cls} ${cellClass(k)}"><input aria-label="${esc(row.dateLabel)} ${esc(product.name)} ${esc(st.name)}のケース数" type="number" inputmode="numeric" min="0" step="1" value="${esc(value)}" data-order-input data-date="${esc(row.date)}" data-product="${esc(row.productId)}" data-store="${esc(st.id)}">${cellStateMarkup(k)}</td>`;
      }).join('');
      const rs = OB ? OB.rowStatus(row, config, product).code : '';
      return `<tr class="${soldOut ? 'soldout-row' : ''} ${row.inMonth === false ? 'outside-month-row' : ''} ${rs ? 'status-' + rs : ''}"><td class="col-date">${esc(row.dateLabel || row.date)}${soldOut ? '<br><span class="sold-out">SOLD OUT</span>' : ''}${statusMark(row, config, product)}</td><td class="col-maker">${esc(product.manufacturer || '')}</td><td class="col-product product-cell"><small class="maker-inline">${esc(product.manufacturer || '')}</small><strong>${esc(product.name || '')}</strong><small>${esc(product.specification || '')}　${esc(product.jan || '')}</small>${productDetailsMarkup(product)}${OB && OB.leadDaysOf(product.leadDays) === null ? '<small class="nolead-note">締切が未設定（店は入れられません）</small>' : ''}${!soldOut && row.inMonth !== false ? capHint(row.productId, row.remaining) : ''}</td>${cells}<td class="total-cell">${total || '—'}</td></tr>`;
    };
    let body;
    if (opts.bands) {
      const dates = [...new Set(rows.map((r) => r.date))];
      body = dates.map((date, i) => {
        const dayRows = rows.filter((r) => r.date === date); const outside = dayRows.some((r) => r.inMonth === false);
        const label = `${md(date)}（${WEEKDAY.charAt(weekdayOf(date))}）${date === today ? '　今日' : ''}${outside ? '　対象月の外' : ''}`;
        return `<tbody class="day-group ${i % 2 ? 'is-alt' : ''} ${outside ? 'is-outside' : ''}"><tr class="day-band"><th colspan="${ncols}" class="${dayClass(date)} ${date === today ? 'is-today' : ''}"><span class="day-band-label">${esc(label)}</span></th></tr>${dayRows.map(rowHtml).join('')}</tbody>`;
      }).join('');
    } else body = `<tbody>${rows.map(rowHtml).join('')}</tbody>`;
    if (!rows.length) body = `<tbody><tr><td colspan="${ncols}">該当する商品がありません。</td></tr></tbody>`;
    const columns = `<th class="col-date">日付</th><th class="col-maker">メーカー</th><th class="col-product">商品・規格・JAN</th>${storeHeads(stores, ownStoreId)}<th>合計</th>`;
    return `<section class="week-card"><div class="week-heading"><h3>${esc(week.label || '週')}</h3><span>${esc(week.startLabel || '')}${week.endLabel ? ` ～ ${esc(week.endLabel)}` : ''}　<b class="unit-note">数はケース</b></span></div><div class="table-scroll"><table class="order-table ${stores.length === 1 ? 'is-single' : ''} ${opts.bands ? 'has-day-bands' : ''}"><thead><tr>${columns}</tr></thead>${body}</table></div>${legendLine()}</section>`;
  }

  /** 月間合計。BY と倉庫は 在庫量（いつでも直せる・自動保存）・直した人と時刻・残数・不足。店は残数だけ（在庫量・ほかの店の内訳は出さない） */
  function renderMonthSummary(data, products, config) {
    const stores = data.stores || []; const totals = data.monthTotals || {}; const ownStoreId = data.principal?.storeId;
    if (!products.length) return emptyState('月間合計はありません。', '対象月と商品が決まると、商品・店舗ごとの合計が出ます。');
    const role = data.principal?.role; const canEdit = role === 'BY' || role === 'WAREHOUSE'; const info = data.capsInfo || {};
    const restOf = (pid) => { for (const w of data.weeks || []) for (const r of w.rows || []) if (String(r.productId) === String(pid) && r.inMonth !== false && r.remaining != null) return r.remaining; return null; };
    const rows = products.map((p) => {
      const total = stores.reduce((sum, s) => sum + (Number(totals[p.id]?.[s.id]) || 0), 0);
      let tail;
      if (canEdit) {
        const cap = data.caps?.[p.id]; const pend = state.capPending.get(String(p.id));
        const value = pend ? (pend.quantity == null ? '' : pend.quantity) : (cap == null ? '' : cap);
        const by = info[p.id] && info[p.id].who ? `${info[p.id].who} ${info[p.id].at}` : '';
        const shortage = cap != null && total > Number(cap) ? total - Number(cap) : 0;
        tail = `<td class="cap-cell ${capCellClass(String(p.id))}"><input class="cap-input" data-cap-input data-product="${esc(p.id)}" type="number" inputmode="numeric" min="0" step="1" placeholder="制限なし" value="${esc(value)}" aria-label="${esc(p.name)}の在庫量"><small class="cap-who">${esc(by)}</small>${capStateMarkup(String(p.id))}</td><td>${cap == null ? '—' : esc(Math.max(0, Number(cap) - total))}</td><td class="${shortage ? 'cap-short' : ''}">${shortage ? `不足 ${esc(shortage)} ケース` : '—'}</td>`;
      } else {
        const r = restOf(p.id); tail = `<td>${r == null ? '—' : (r <= 0 ? '0（SOLD OUT）' : esc(r))}</td>`;
      }
      return `<tr><td class="col-maker">${esc(p.manufacturer || '')}</td><td class="col-product product-cell"><small class="maker-inline">${esc(p.manufacturer || '')}</small><strong>${esc(p.name)}</strong><small>${esc(p.specification || '')}　${esc(p.jan || '')}</small>${productDetailsMarkup(p)}</td>${stores.map((s) => { const v = Number(totals[p.id]?.[s.id]) || 0; return `<td class="total-cell store-cell ${String(s.id) === String(ownStoreId) ? 'is-own' : ''} ${v ? '' : 'is-empty'}">${v || '—'}</td>`; }).join('')}<td class="total-cell">${total || '—'}</td>${tail}</tr>`;
    }).join('');
    const heads = `<th class="col-maker">メーカー</th><th class="col-product">商品・規格・JAN</th>${storeHeads(stores, ownStoreId)}<th>月計</th>${canEdit ? '<th>在庫量</th><th>残数</th><th>不足</th>' : '<th>残数</th>'}`;
    return `<section class="week-card"><div class="week-heading"><h3>${esc(config.label || '月間合計')}</h3><span>${canEdit ? '在庫量は、入れると自動で保存されます（BY と倉庫がいつでも直せる・空欄は制限なし）' : '商品ごとの月の合計と残数'}　<b class="unit-note">数はケース</b></span></div><div class="table-scroll"><table class="order-table month-table ${stores.length === 1 ? 'is-single' : ''}"><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  /** 店の画面は、横に長い表でも「自店」の列が最初から見えるように、横の位置を合わせる */
  function scrollToOwnColumn(host) {
    if (state.data?.principal?.role !== 'STORE') return;
    host.querySelectorAll('.table-scroll').forEach((box) => {
      const own = box.querySelector('th.is-own'); if (!own) return;
      const sticky = [...box.querySelectorAll('thead th.col-date, thead th.col-maker, thead th.col-product')].filter((th) => getComputedStyle(th).position === 'sticky' && getComputedStyle(th).display !== 'none').reduce((w, th) => w + th.offsetWidth, 0);
      const target = own.offsetLeft - sticky - 12;
      if (target > 0 && own.offsetLeft + own.offsetWidth > box.clientWidth) box.scrollLeft = target;
    });
  }

  function productDetailsMarkup(product) {
    const has = (v) => v !== '' && v != null;
    const margin = Number(product.marginRate);
    const marginLabel = Number.isFinite(margin) ? `${Math.round((Math.abs(margin) <= 1 ? margin * 100 : margin) * 10) / 10}%` : '';
    const details = [
      ['入数', has(product.packSize) ? `${product.packSize}個／ケース` : ''],
      ['原価', has(product.costNet) ? `${product.costNet}円（本体）` : ''],
      ['原価税込', has(product.costGross) ? `${product.costGross}円` : ''],
      ['売価', has(product.priceNet) ? `${product.priceNet}円（本体）` : ''],
      ['売価税込', has(product.priceGross) ? `${product.priceGross}円` : ''],
      ['値入率', has(product.marginRate) ? marginLabel : ''],
      ['締切:', OB && OB.leadDaysOf(product.leadDays) !== null ? `${OB.leadDaysOf(product.leadDays)}日前 12:00` : '未設定']
    ].filter((entry) => entry[1]);
    if (!details.length) return '';
    return `<details class="product-details"><summary>商品情報</summary><span>${details.map(([label, value]) => `${esc(label)} ${esc(value)}`).join('　')}</span></details>`;
  }

  /** BY: 用意していない月を選んだとき「この月を用意する」・商品の無い月「前の月の商品をこの月にも入れる」（押す所を表の場所に出す） */
  function renderSetupCard(host, config) {
    host.innerHTML = '';
    const card = document.createElement('div'); card.className = 'setup-card';
    const title = document.createElement('strong'); const p = document.createElement('p'); const actions = document.createElement('div'); actions.className = 'setup-actions';
    if (!config.configured) {
      title.textContent = `${config.label || config.month}は、まだ用意していません`;
      p.textContent = '「この月を用意する」を押して締切を入れると、店舗の「対象月」にもこの月が出ます。そのあと、この月の商品を入れます。';
      actions.append(makeButton('この月を用意する', () => openSettings(config.month), 'button button-primary setup-prepare'));
    } else {
      title.textContent = `${config.label || config.month}の商品は、まだありません`;
      p.textContent = '前の月と同じ商品を入れるときは「前の月の商品をこの月にも入れる」を押します（在庫量は写りません）。選んで入れるときは「商品マスター」で「この月に追加」を押します。';
      const copy = makeButton('前の月の商品をこの月にも入れる', () => copyPreviousMonth(copy), 'button button-primary setup-copy');
      actions.append(copy, makeButton('商品マスター', () => openProductManager(), 'button button-secondary'));
    }
    card.append(title, p, actions); host.append(card);
  }
  function emptyState(title, description) { return `<div class="empty-state"><div><strong>${esc(title)}</strong><p>${esc(description)}</p></div></div>`; }
  function makeButton(label, handler, classes) { const button = document.createElement('button'); button.type = 'button'; button.className = classes; button.textContent = label; button.addEventListener('click', handler); return button; }
  function requestId() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`; }

  // ------------------------------------------------------------ 入力と自動保存（PO 2026-10-28「シジスルのように定期的に自動保存」・全 GAS アプリの標準＝原則5）
  //   保存のボタンは作らない。手が止まって 0.7 秒・欄を離れたらすぐ、saveOrderBatch で送る（その間に入れた分は1回にまとめる）。
  //   送るのは1つずつ（保存の列）。送る中身（日付×商品×店）は、入れたときに決める（送っている間に週を切り替えても、正しい欄に書く）。
  //   断られた欄は ⚠ と理由を出し、入れた数は消さない（直せば自動でもう一度送る）。通信の失敗は、入力を続けるか5秒後に、もう一度送る。
  //   打っている間は表を作り直さない（欄の印だけを、その欄で直す）。
  //   state.pending: 保存できていない欄 key → { date, productId, storeId, quantity, status: 'dirty'|'saving'|'error', reason, network, invalid, rid }
  const SAVE_DELAY_MS = 700;
  const RETRY_MS = 5000;
  const pkey = (date, productId, storeId) => [date, productId, storeId].join('\u001f');
  const auto = { timer: 0, retry: 0, soft: 0, queue: Promise.resolve(), inflight: 0, lastSavedAt: null, savedMarks: new Map(), capSaved: new Map() };
  function pendingCount() { return state.pending.size + state.capPending.size; } // 保存できていない欄（注文と在庫量）
  function pendingChanges() {
    if (!state.pending.size || !state.data) return null;
    return { month: state.data.month?.month, changes: [...state.pending.values()].map((c) => ({ date: c.date, productId: c.productId, storeId: c.storeId, quantity: c.quantity })) };
  }
  function productOf(id) { return (state.data?.products || []).find((p) => String(p.id) === String(id)) || null; }
  function findRow(date, productId) {
    for (const w of state.data?.weeks || []) for (const r of w.rows || []) if (r.date === String(date) && String(r.productId) === String(productId)) return r;
    return null;
  }
  /** その欄に書けるか（画面の表と同じ決まり。書けるかの最後の判断は GAS） */
  function cellEditable(row, storeId) {
    const data = state.data; if (!data || !row || row.inMonth === false) return false;
    const config = data.month || {}; const role = data.principal?.role;
    if (role === 'BY' || role === 'WAREHOUSE') return (data.stores || []).some((st) => String(st.id) === String(storeId)); // BY と倉庫は、確定の後も直せる（PO 2026-10-28）
    if (role === 'STORE') { if (String(storeId) !== String(data.principal.storeId) || !config.deadline) return false; const st = OB ? OB.rowStatus(row, config, productOf(row.productId)) : null; return st ? !st.locked : (!config.confirmed && !row.soldOut); }
    return false;
  }
  /** 保存できていない入力を戻す（ログインし直した後・下書き）。書けない欄は戻さない。戻したら自動で送る */
  function applyChanges(changes) {
    let n = 0;
    (changes || []).forEach((c) => {
      const row = findRow(c.date, c.productId); if (!cellEditable(row, c.storeId)) return;
      state.pending.set(pkey(String(c.date), String(c.productId), String(c.storeId)), { date: String(c.date), productId: String(c.productId), storeId: String(c.storeId), quantity: c.quantity == null ? null : Number(c.quantity), status: 'dirty' }); n++;
    });
    if (n) { renderOrders(); scheduleFlush(SAVE_DELAY_MS); }
    renderIndicator(); return n;
  }
  function clearPendingMarks() { window.clearTimeout(auto.timer); window.clearTimeout(auto.retry); state.pending.clear(); state.capPending.clear(); auto.savedMarks.clear(); auto.capSaved.clear(); renderIndicator(); }
  function saveDraft() { const draft = pendingChanges(); if (!draft) return; try { store('session')?.setItem(DRAFT_KEY, JSON.stringify(Object.assign(draft, { at: Date.now() }))); } catch {} }
  function readDraft() { try { const d = JSON.parse(store('session')?.getItem(DRAFT_KEY) || 'null'); return d && Date.now() - d.at < 30 * 60000 ? d : null; } catch { return null; } }
  function restoreDraft() {
    const d = readDraft(); try { store('session')?.removeItem(DRAFT_KEY); } catch {}
    if (!d || !state.data || d.month !== state.data.month?.month) return;
    const n = applyChanges(d.changes); if (n) toast(`保存できていなかった入力を ${n} 件戻しました。自動で保存します。`);
  }

  // ---- 欄ごとの印（保存中／✓／⚠ と理由）。表は作り直さず、その欄だけを直す
  function cellClass(key) {
    const c = state.pending.get(key);
    if (c) return c.status === 'error' ? 'is-error' : 'is-saving';
    return auto.savedMarks.has(key) ? 'is-saved' : '';
  }
  function cellStateMarkup(key) {
    const c = state.pending.get(key);
    if (c && c.status === 'error') return `<span class="cell-state">⚠</span><span class="cell-reason">${esc(c.reason || '保存できませんでした')}</span>`;
    if (c) return '<span class="cell-state">保存中</span>';
    return auto.savedMarks.has(key) ? '<span class="cell-state">✓</span>' : '';
  }
  function markCell(key) {
    const [date, productId, storeId] = key.split('\u001f');
    const input = document.querySelector(`[data-order-input][data-date="${CSS.escape(date)}"][data-product="${CSS.escape(productId)}"][data-store="${CSS.escape(storeId)}"]`);
    if (!input) return; // ほかの週の欄（タブを開いたときに印を付けて描く）
    const td = input.closest('td'); const c = state.pending.get(key);
    td.classList.remove('is-saving', 'is-saved', 'is-error'); const cls = cellClass(key); if (cls) td.classList.add(cls);
    td.querySelectorAll('.cell-state,.cell-reason').forEach((n) => n.remove());
    td.insertAdjacentHTML('beforeend', cellStateMarkup(key));
    input.setAttribute('aria-invalid', String(Boolean(c && c.status === 'error'))); input.title = c && c.status === 'error' ? (c.reason || '') : '';
  }
  function flashSaved(key) {
    window.clearTimeout(auto.savedMarks.get(key));
    auto.savedMarks.set(key, window.setTimeout(() => { auto.savedMarks.delete(key); markCell(key); }, 4000));
    markCell(key);
  }

  // ---- 保存の印（画面の右上）: 保存中… → ✓ 自動保存 HH:MM → ⚠ 失敗
  function renderIndicator() {
    markWeekTabs();
    const node = $('#save-indicator'); if (!node) return;
    const all = [...state.pending.values(), ...state.capPending.values()]; const errors = all.filter((c) => c.status === 'error'); const busy = all.length - errors.length + auto.inflight;
    let cls = 'is-idle', msg = '入れると自動で保存されます';
    if (errors.length) { cls = 'is-error'; msg = errors.some((c) => c.network) ? '⚠ 保存に失敗（入力を続けると、自動でもう一度保存します）' : `⚠ 保存できない欄が ${errors.length} か所（理由は欄の下）`; }
    else if (busy) { cls = 'is-saving'; msg = '保存中…'; }
    else if (auto.lastSavedAt) { cls = 'is-saved'; msg = `✓ 自動保存 ${p2(auto.lastSavedAt.getHours())}:${p2(auto.lastSavedAt.getMinutes())}`; }
    node.className = 'save-indicator ' + cls; node.textContent = msg;
  }

  // ---- 打つ・離れる
  function onOrderType(event) {
    const input = event.currentTarget; const { date, product, store: storeId } = input.dataset; const key = pkey(date, product, storeId);
    const value = input.value === '' ? null : Number(input.value);
    updateWeekTotal(input);
    if (state.data?.principal?.role === 'STORE') { const row0 = findRow(date, product); const st0 = OB && row0 ? OB.rowStatus(row0, state.data.month || {}, productOf(product)) : null; if (st0 && st0.code === 'soldout') { state.pending.set(key, { date, productId: product, storeId, quantity: value, status: 'error', reason: 'SOLD OUT になりました（在庫がありません）', invalid: true }); markCell(key); renderIndicator(); return; } } // 開いている間に SOLD OUT になった欄
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 99999)) { // 送らない・数は消さない
      state.pending.set(key, { date, productId: product, storeId, quantity: value, status: 'error', reason: '0以上の整数で入れてください', invalid: true });
      markCell(key); renderIndicator(); return;
    }
    const row = findRow(date, product); const saved = Number(row?.quantities?.[storeId]) || null;
    const was = state.pending.get(key);
    if ((value || null) === saved && !(was && was.status === 'saving')) { state.pending.delete(key); markCell(key); renderIndicator(); scheduleFlush(SAVE_DELAY_MS); return; } // 保存してある数に戻した
    state.pending.set(key, { date, productId: product, storeId, quantity: value, status: 'dirty' });
    markCell(key); renderIndicator();
    scheduleFlush(SAVE_DELAY_MS);
  }
  function scheduleFlush(ms) { window.clearTimeout(auto.timer); auto.timer = window.setTimeout(flushNow, ms); }

  /** いま保存できていない欄を、1回にまとめて保存の列へ（通信で失敗した欄も一緒に）。中身はここで決める */
  function flushNow() {
    if (remain.redraw && !typing()) { remain.redraw = false; window.setTimeout(() => { if (!typing()) renderOrders(); else remain.redraw = true; }, 0); }
    window.clearTimeout(auto.timer); auto.timer = 0; window.clearTimeout(auto.retry); auto.retry = 0;
    const month = state.data?.month?.month; if (!month) return;
    flushCaps(month);
    const batch = [...state.pending.entries()].filter(([, c]) => c.status === 'dirty' || (c.status === 'error' && c.network));
    if (!batch.length) { renderIndicator(); return; }
    // 通信で失敗した1回ぶんを、そのまま送り直すときは、同じ操作番号（GAS は2回目を前の結果で返す＝二重にならない）
    const rids = new Set(batch.map(([, c]) => c.rid || '')); const reuse = rids.size === 1 && [...rids][0] && batch.every(([, c]) => c.status === 'error' && c.network && c.batchSize === batch.length);
    const rid = reuse ? [...rids][0] : requestId();
    const changes = batch.map(([key, c]) => { Object.assign(c, { status: 'saving', network: false, reason: '', rid, batchSize: batch.length }); markCell(key); return { key, date: c.date, productId: c.productId, storeId: c.storeId, quantity: c.quantity }; });
    enqueue({ month, changes, requestId: rid });
  }
  function enqueue(job) {
    auto.inflight++; renderIndicator();
    auto.queue = auto.queue.then(() => sendJob(job)).catch(() => {}).then(() => { auto.inflight--; renderIndicator(); if (!auto.inflight) scheduleSoftRefresh(); });
    return auto.queue;
  }
  /** 断られた理由を、その欄で分かる言葉に */
  function reasonOf(error) {
    const m = String(error && error.message || '');
    if (/締切後|締切を過ぎ|確定/.test(m)) return '締切を過ぎたので直せません（直すときは畜産BYへ）';
    if (/締切がまだ/.test(m)) return '締切がまだ決まっていないので、入れられません';
    const cap = /あと注文できる数は (\d+) ケース/.exec(m); if (cap) return `在庫を超えます。残りは ${cap[1]} ケースです`;
    if (/日付・商品・店舗/.test(m)) return 'この欄には入れられません（画面を読み込み直してください）';
    if (/0以上の整数/.test(m)) return '0以上の整数で入れてください';
    return m || '保存できませんでした';
  }
  async function sendJob(job) {
    const settle = (c, fn) => { const now = state.pending.get(c.key); if (now && now.status === 'saving' && now.rid === job.requestId && now.quantity === c.quantity) fn(now); };
    try {
      await api('saveOrderBatch', { month: job.month, changes: job.changes.map((c) => ({ date: c.date, productId: c.productId, storeId: c.storeId, quantity: c.quantity })), requestId: job.requestId });
      auto.lastSavedAt = new Date();
      job.changes.forEach((c) => {
        const row = findRow(c.date, c.productId); // 画面の手元の値も、保存した数にする（あとの比べ・週の合計のため）
        if (row) { row.quantities = row.quantities || {}; if (c.quantity) row.quantities[c.storeId] = c.quantity; else delete row.quantities[c.storeId]; }
        settle(c, () => { state.pending.delete(c.key); flashSaved(c.key); });
      });
    } catch (error) {
      if (error.code === 'SESSION') { job.changes.forEach((c) => settle(c, (now) => { now.status = 'dirty'; })); saveDraft(); showLoginPanel(error.message, 'info'); return; }
      if (error.code === 'NETWORK' || error.code === 'BUSY') {
        job.changes.forEach((c) => settle(c, (now) => { Object.assign(now, { status: 'error', network: true, reason: '通信できませんでした（入力を続けると、自動でもう一度送ります）' }); markCell(c.key); }));
        window.clearTimeout(auto.retry); auto.retry = window.setTimeout(flushNow, RETRY_MS); return;
      }
      // 断られた（締切・在庫量・欄の誤り）。2つ以上なら1つずつ送り直して、どの欄かを分ける（ほかの欄は保存される）
      if (job.changes.length > 1) {
        for (const c of job.changes) {
          const now = state.pending.get(c.key); if (!now || now.status !== 'saving' || now.rid !== job.requestId) continue;
          const rid = requestId(); now.rid = rid; now.batchSize = 1;
          await sendJob({ month: job.month, changes: [c], requestId: rid });
        }
        return;
      }
      job.changes.forEach((c) => settle(c, (now) => { Object.assign(now, { status: 'error', network: false, reason: reasonOf(error) }); markCell(c.key); }));
    }
  }
  /** 保存の列が空いて、だれも打っていないときだけ、画面の数（残数・SOLD OUT・合計）を読み直す（打っている途中に表を作り直さない） */
  function scheduleSoftRefresh() { window.clearTimeout(auto.soft); auto.soft = window.setTimeout(() => { if (!auto.inflight) pollRemaining(); }, 800); } // 自分の保存の後は、残数を読み直す

  // ------------------------------------------------------------ 残数を新しくする（PO 2026-10-28「店舗側もリアルに見れる」）
  //   開いている間（ページが見えているときだけ）1分ごと・画面に戻ってきたとき・自分の保存の後に、軽い問い合わせ getRemaining で読む。
  //   打っている欄は作り直さない（原則5）: 打っていないときだけ表を描き直す（打っている間は、離れた後に）
  //   「更新」のボタン: 保存中の欄は終わってから、注文の数まで全部を読み直す（getWorkspace）。週のタブ・縦横の位置・探す欄の文字・⚠ の欄は残す
  const REMAIN_MS = Number(window.__REMAIN_MS) || 60000; // 試験の見本の画面だけ短くする
  const remain = { timer: 0, busy: false, refreshing: false, at: '', last: 0, changed: new Map(), redraw: false };
  const typing = () => Boolean(document.activeElement?.matches?.('[data-order-input],[data-cap-input]'));
  function startRemainPolling() { if (!remain.timer) remain.timer = window.setInterval(() => { if (document.visibilityState === 'visible') pollRemaining(); }, REMAIN_MS); }
  function stopRemainPolling() { window.clearInterval(remain.timer); remain.timer = 0; }
  function nowLabel() { return OB ? OB.jstLabel(Date.now()).split(' ')[1] : new Date().toTimeString().slice(0, 5); }
  function setRemainAt(label) { remain.at = label; const node = $('#remain-at b'); if (node) node.textContent = `${label} 時点`; }
  async function pollRemaining() {
    if (remain.busy || remain.refreshing || !state.session || !state.data?.month?.month || document.visibilityState !== 'visible') return;
    remain.busy = true; remain.last = Date.now(); $('#remain-at')?.classList.add('is-loading'); const t0 = performance.now();
    try { applyRemaining(await api('getRemaining', { month: state.data.month.month })); perfNote('remaining', t0); }
    catch (error) { if (error.code === 'SESSION') { stopRemainPolling(); showLoginPanel(error.message, 'info'); } } // ほかの失敗は、次の回に読む
    finally { remain.busy = false; $('#remain-at')?.classList.remove('is-loading'); }
  }
  function applyRemaining(r) {
    const data = state.data; if (!data || !r || r.month !== data.month?.month) return;
    let changed = false;
    Object.keys(r.products || {}).forEach((pid) => {
      const x = r.products[pid];
      (data.weeks || []).forEach((w) => (w.rows || []).forEach((row) => {
        if (String(row.productId) !== pid || row.inMonth === false) return;
        const so = Boolean(x.soldOutFrom && row.date >= x.soldOutFrom);
        if (row.remaining !== x.remaining || Boolean(row.soldOut) !== so) { if (row.remaining !== x.remaining) remain.changed.set(pid, Date.now() + 8000); row.remaining = x.remaining; row.soldOut = so; changed = true; }
      }));
      if (x.cap !== undefined) { data.caps = data.caps || {}; const before = data.caps[pid] == null ? null : Number(data.caps[pid]); if (before !== x.cap) { if (x.cap == null) delete data.caps[pid]; else data.caps[pid] = x.cap; changed = true; } }
    });
    if (r.capsInfo) { if (JSON.stringify(r.capsInfo) !== JSON.stringify(data.capsInfo || {})) changed = true; data.capsInfo = r.capsInfo; }
    setRemainAt(r.computedLabel ? r.computedLabel.split(' ')[1] : nowLabel());
    if (changed) { if (typing()) remain.redraw = true; else renderOrders(); } // 打っている間は作り直さない
  }
  /** 「更新」: 注文の数まで全部を読み直す。保存中の欄は終わってから。連打しても1回 */
  async function refreshAll() {
    if (remain.refreshing) return;
    remain.refreshing = true; const done = busyButton($('#refresh-button'), '更新中…'); const t0 = performance.now();
    try {
      await settleSaves(); // ⚠（保存できない欄）は、入れた数のまま残る
      await refreshWorkspace(state.data?.month?.month);
      setRemainAt(nowLabel()); perfNote('refresh', t0);
    } catch (error) { if (error.code !== 'SESSION') toast(error.message, true, refreshAll); }
    finally { remain.refreshing = false; done(); const b = $('#refresh-button'); if (b) { b.disabled = false; b.classList.remove('is-busy'); b.removeAttribute('aria-busy'); b.textContent = '更新'; delete b.dataset.idleLabel; } } // 読み直しで作り直したボタンも戻す
  }
  /** 保存の列が終わるのを待つ（Excel・印刷・月の切り替えの前）。返す値: 保存できていない欄の数 */
  async function settleSaves() {
    flushNow();
    const busy = () => [...state.pending.values(), ...state.capPending.values()].some((c) => c.status !== 'error');
    for (let i = 0; i < 20 && (auto.inflight || busy()); i++) { await auto.queue; if ([...state.pending.values(), ...state.capPending.values()].some((c) => c.status === 'dirty')) flushNow(); }
    return pendingCount();
  }

  // ---- 在庫量の自動保存（注文と同じ型＝原則5: 0.7秒・離れたらすぐ・保存の列で1つずつ・欄に 保存中／✓／⚠）
  //   後に直した方が残る（last-write-wins）。保存の後、だれも打っていないときに読み直す（相手の直しが見える）
  function capCellClass(pid) { const c = state.capPending.get(pid); if (c) return c.status === 'error' ? 'is-error' : 'is-saving'; return auto.capSaved.has(pid) ? 'is-saved' : ''; }
  function capStateMarkup(pid) {
    const c = state.capPending.get(pid);
    if (c && c.status === 'error') return `<span class="cell-state">⚠</span><span class="cell-reason">${esc(c.reason || '保存できませんでした')}</span>`;
    if (c) return '<span class="cell-state">保存中</span>';
    return auto.capSaved.has(pid) ? '<span class="cell-state">✓</span>' : '';
  }
  function markCapCell(pid) {
    const input = document.querySelector(`[data-cap-input][data-product="${CSS.escape(pid)}"]`); if (!input) return;
    const td = input.closest('td'); td.classList.remove('is-saving', 'is-saved', 'is-error'); const cls = capCellClass(pid); if (cls) td.classList.add(cls);
    td.querySelectorAll('.cell-state,.cell-reason').forEach((n) => n.remove()); td.insertAdjacentHTML('beforeend', capStateMarkup(pid));
  }
  function onCapType(event) {
    const input = event.currentTarget; const pid = String(input.dataset.product); const value = input.value === '' ? null : Number(input.value);
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 999999)) { state.capPending.set(pid, { productId: pid, quantity: value, status: 'error', reason: '0以上の整数で入れてください（空欄は制限なし）', invalid: true }); markCapCell(pid); renderIndicator(); return; }
    const saved = state.data?.caps?.[pid]; const was = state.capPending.get(pid);
    if ((value == null ? null : value) === (saved == null ? null : Number(saved)) && !(was && was.status === 'saving')) { state.capPending.delete(pid); markCapCell(pid); renderIndicator(); return; }
    state.capPending.set(pid, { productId: pid, quantity: value, status: 'dirty' }); markCapCell(pid); renderIndicator(); scheduleFlush(SAVE_DELAY_MS);
  }
  function flushCaps(month) {
    [...state.capPending.entries()].filter(([, c]) => c.status === 'dirty' || (c.status === 'error' && c.network)).forEach(([pid, c]) => {
      const rid = c.network && c.rid ? c.rid : requestId(); Object.assign(c, { status: 'saving', network: false, reason: '', rid }); markCapCell(pid);
      const job = { month, productId: pid, quantity: c.quantity, requestId: rid };
      auto.inflight++; renderIndicator();
      auto.queue = auto.queue.then(() => sendCapJob(job)).catch(() => {}).then(() => { auto.inflight--; renderIndicator(); if (!auto.inflight) scheduleSoftRefresh(); });
    });
  }
  async function sendCapJob(job) {
    const now = () => { const c = state.capPending.get(job.productId); return c && c.status === 'saving' && c.rid === job.requestId && c.quantity === job.quantity ? c : null; };
    try {
      await api('setProductCap', { month: job.month, productId: job.productId, cap: job.quantity, requestId: job.requestId });
      auto.lastSavedAt = new Date();
      if (state.data) { state.data.caps = state.data.caps || {}; if (job.quantity == null) delete state.data.caps[job.productId]; else state.data.caps[job.productId] = job.quantity; }
      if (now()) { state.capPending.delete(job.productId); window.clearTimeout(auto.capSaved.get(job.productId)); auto.capSaved.set(job.productId, window.setTimeout(() => { auto.capSaved.delete(job.productId); markCapCell(job.productId); }, 4000)); markCapCell(job.productId); }
    } catch (error) {
      const c = now(); if (!c) return;
      if (error.code === 'SESSION') { c.status = 'dirty'; showLoginPanel(error.message, 'info'); return; }
      if (error.code === 'NETWORK' || error.code === 'BUSY') { Object.assign(c, { status: 'error', network: true, reason: '通信できませんでした（入力を続けると、自動でもう一度送ります）' }); markCapCell(job.productId); window.clearTimeout(auto.retry); auto.retry = window.setTimeout(flushNow, RETRY_MS); return; }
      Object.assign(c, { status: 'error', network: false, reason: error.message || '保存できませんでした' }); markCapCell(job.productId);
    }
  }

  // ------------------------------------------------------------ 印刷の上の1行（印刷した日時・この時点の状態）
  function fillPrintHead() {
    const node = $('#print-head'); const data = state.data; if (!node || !data) return;
    const config = data.month || {}; const who = data.principal || {};
    node.textContent = `畜産 発注書　${config.label || ''}　印刷: ${OB ? OB.stamp(new Date()) : new Date().toLocaleString('ja-JP')}　${who.shortLabel || who.label || ''}（${who.roleLabel || ''}）　この時点の状態: ${OB ? OB.monthStatusText(config) : (config.statusLabel || '')}${pendingCount() ? '　（保存できていない欄は、印刷に入っていません）' : ''}`;
  }

  // ------------------------------------------------------------ Excel でダウンロード（倉庫と BY・押せる人は GAS も確かめる）
  //   中身は GAS が返す保存済みの値だけ。GAS が「だれが・いつ・どの月」を記録できたときだけ作る（記録に失敗したら作らない）。
  async function exportExcel() {
    if (await settleSaves()) { toast('保存できていない欄（⚠）があります。直して保存されてから、ダウンロードしてください。', true); return; }
    if (!OB) { toast('Excel を作る部品を読み込めませんでした。画面を読み込み直してください。', true); return; }
    const button = $('#excel-button'); if (button.disabled) return;
    const done = busyButton(button, '注文を集めています…'); const t0 = performance.now();
    try {
      const data = await api('exportOrders', { month: state.data?.month?.month || '', requestId: requestId() });
      done.stage('ファイルを作っています…'); await new Promise((r) => window.setTimeout(r, 30)); // 文字を先に出す
      const p = data.principal || {};
      const book = OB.build(data, { exportedAt: new Date(data.exportedAt), who: `${p.label || p.email || ''}（${p.roleLabel || p.role || ''}）` });
      const url = URL.createObjectURL(new Blob([book.bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a'); a.href = url; a.download = book.fileName; document.body.append(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast(`「${book.fileName}」をダウンロードしました（週ごと ${book.sheetNames.length - 1} 枚＋月間合計）。`); perfNote('excel', t0);
    } catch (error) {
      if (error.code === 'SESSION') showLoginPanel(error.message, 'info'); else toast(error.message, true, error.code === 'NETWORK' ? exportExcel : null);
    } finally { done(); }
  }

  // ------------------------------------------------------------ BY の画面
  function openSettings(forMonth) {
    const c = forMonth && forMonth !== state.data?.month?.month ? { month: forMonth } : (state.data?.month || {});
    const localDeadline = c.deadline ? new Date(new Date(c.deadline).getTime() - new Date(c.deadline).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
    showModal('月度設定', `<label>対象月<input name="month" type="month" value="${esc(c.month || '')}" required></label><label>受注締切の日時<input name="deadline" type="datetime-local" value="${esc(localDeadline)}"></label><p class="form-note">締切を後ろへ延ばすと、確定が外れて店舗がまた入れられます。空にすると「締切未設定」になり、店舗は入れられません。在庫量は「月間合計」で、BY と倉庫がいつでも直せます。</p>`, async (form) => {
      const month = form.elements.month.value; if (!month) throw new Error('対象月を入れてください。');
      const deadline = form.elements.deadline.value ? new Date(form.elements.deadline.value).toISOString() : '';
      const res = await api('saveMonthConfig', { month, deadline, requestId: requestId() });
      await refreshWorkspace(month); toast(res?.message || '月度設定を保存しました。');
    });
  }

  /** 「前の月の商品をこの月にも入れる」（BY・1回押すだけ）。すでに入っている商品はそのまま・在庫量は写さない（GAS が決める） */
  async function copyPreviousMonth(button) {
    const month = state.data?.month?.month; if (!month || (button && button.disabled)) return false;
    const done = busyButton(button, '入れています…');
    try { const res = await api('copyMonthProducts', { month, requestId: requestId() }); await refreshWorkspace(month); toast(res?.message || '入れました。'); return true; }
    catch (error) { done(); if (error.code === 'SESSION') showLoginPanel(error.message, 'info'); else toast(error.message, true); return false; }
  }

  function openProductManager() {
    const root = $('#modal-root');
    sheetFiles = []; // 登録用紙の積み上げは、商品マスターを開き直すたびに空にする
    root.innerHTML = `<div class="modal-backdrop"><section class="modal-card product-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-heading"><h2 id="modal-title">商品マスター・${esc(state.data?.month?.label || '対象月')}の商品</h2><button type="button" class="modal-close" aria-label="閉じる">×</button></div><div class="product-manager"><div class="product-manager-actions"><input class="product-manager-search" type="search" placeholder="商品名・読み・メーカー・JAN（ひらがな・ローマ字でも）" aria-label="商品マスターを探す"><button type="button" class="button button-primary product-add">商品を追加</button><button type="button" class="button button-secondary product-copy-month">前の月の商品をこの月にも入れる</button></div><div class="product-sheet-actions"><span>まとめて登録するとき <a class="help-icon" href="guide.html#upload" title="登録用紙の使い方" aria-label="登録用紙の使い方を開く">?</a></span><a class="button button-secondary product-template-link" href="product-template.xlsx?v=${APP_VERSION}" download="商品マスターの登録用紙.xlsx">登録用紙をダウンロード</a><button type="button" class="button button-secondary product-upload">登録用紙をアップロード</button><input class="product-upload-input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple hidden></div><div class="product-manager-list"></div></div></section></div>`;
    const close = () => root.replaceChildren();
    root.querySelector('.modal-close').addEventListener('click', close);
    root.querySelector('.modal-backdrop').addEventListener('click', (e) => { if (e.target.classList.contains('modal-backdrop')) close(); });
    bindSheetUpload(root);
    const search = root.querySelector('.product-manager-search'); const list = root.querySelector('.product-manager-list');
    const all = masterProducts();
    const gaps = productGaps();
    if (gaps.noLead.length) { const note = document.createElement('p'); note.className = 'lead-missing'; note.textContent = `締切が未設定の商品 ${gaps.noLead.length} 件（店で注文できません）。「締切が未設定」の印の商品を押して、「締切（何日前）」を入れてください。`; root.querySelector('.product-manager').insertBefore(note, list); }
    if (gaps.unfilled.length) { const note = document.createElement('p'); note.className = 'fill-missing'; note.textContent = `埋めていない項目がある商品 ${gaps.unfilled.length} 件（注文はできます）。「空:」の印の商品を押して、あとで埋めてください。`; root.querySelector('.product-manager').insertBefore(note, list); }
    const keys = new Map(all.map((p) => [String(p.id), productKey(p)]));
    const draw = () => {
      const terms = search.value.trim() ? makeTerms(search.value) : null;
      const products = all.filter((p) => !terms || hitKey(keys.get(String(p.id)), terms));
      const included = new Set((state.data?.monthProductIds || []).map(String));
      list.replaceChildren();
      products.slice(0, 150).forEach((product) => {
        const row = document.createElement('div'); row.className = 'product-manager-row';
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'product-manager-item';
        const name = document.createElement('strong'); name.textContent = product.name || '';
        const meta = document.createElement('small'); meta.textContent = [product.manufacturer, product.specification, product.jan].filter(Boolean).join('　');
        edit.append(name, meta);
        if (OB && OB.leadDaysOf(product.leadDays) === null) { const mark = document.createElement('span'); mark.className = 'nolead-mark'; mark.textContent = '締切が未設定'; edit.append(mark); }
        const gap = PS ? PS.missingFields(product) : [];
        if (gap.length) { const mark = document.createElement('span'); mark.className = 'fill-mark'; mark.textContent = '空: ' + PS.missingLabel(gap); edit.append(mark); }
        edit.addEventListener('click', () => openProductEditor(product));
        const isIn = included.has(String(product.id));
        const toggle = makeButton(isIn ? 'この月から外す' : 'この月に追加', async () => {
          if (toggle.disabled) return; const done = busyButton(toggle, isIn ? '外しています…' : '入れています…');
          try { const res = await api('setMonthProduct', { month: state.data.month?.month, productId: product.id, included: !isIn, requestId: requestId() }); await refreshWorkspace(state.data.month?.month); openProductManager(); toast(res?.message || '直しました。'); }
          catch (error) { done(); toast(error.message, true); }
        }, `button ${isIn ? 'button-secondary' : 'button-primary'} product-month-toggle`);
        row.append(edit, toggle); list.append(row);
      });
      if (!products.length) { const empty = document.createElement('p'); empty.className = all.length ? 'guide-footnote' : 'product-manager-empty'; empty.textContent = PS ? PS.managerEmptyText(all.length, Boolean(terms)) : (all.length ? '当たる商品はありません。' : 'まだ商品がありません。'); list.append(empty); }
    };
    root.querySelector('.product-add').addEventListener('click', () => openProductEditor());
    root.querySelector('.product-copy-month')?.addEventListener('click', async (event) => { if (await copyPreviousMonth(event.currentTarget)) openProductManager(); });
    let timer = 0; search.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(draw, 150); }); draw();
  }

  // ------------------------------------------------------------ 登録用紙（まとめて登録・BY だけ）
  //   画面は、読んで確かめの表を出すだけ。登録してよいか・どの商品を直すか・番号は、GAS が同じ決まりで決め直す。
  let sheetFiles = []; // 積み上げた用紙 [{ name, size, items, fileErrors }]。同じ名前の用紙は、新しく選んだ方に入れ替える
  const SHEET_STATUS = { new: '新規', update: '更新', same: '変わらない', error: 'エラー' };
  function masterProducts() { return state.data?.productMaster || state.data?.products || []; }

  function bindSheetUpload(root) {
    const input = root.querySelector('.product-upload-input'); const button = root.querySelector('.product-upload');
    if (!input || !button) return;
    button.addEventListener('click', () => input.click());
    input.addEventListener('change', () => { const files = Array.from(input.files || []); input.value = ''; if (files.length) addSheetFiles(files); });
  }

  async function addSheetFiles(files) {
    if (!PS) { toast('登録用紙を読む部品を読み込めませんでした。画面を読み込み直してください。', true); return; }
    const notes = [];
    showProgress('登録用紙を読んでいます…');
    try {
      for (const file of files) {
        const entry = { name: file.name, size: file.size, items: [], fileErrors: [] };
        if (!/\.xlsx$/i.test(file.name)) entry.fileErrors.push('「' + file.name + '」は .xlsx の用紙ではありません。ダウンロードした登録用紙（.xlsx）を選んでください。');
        else {
          try {
            const parsed = PS.parseSheet(await PS.readXlsx(await file.arrayBuffer()));
            entry.items = parsed.items; entry.fileErrors = parsed.fileErrors;
            if (!parsed.items.length && !parsed.fileErrors.length) entry.fileErrors.push('「入力」のシートに、商品の行がありません（見出しの下の2行目から書きます）。');
          } catch (error) { entry.fileErrors.push(error.userMessage || '用紙を読めませんでした。ダウンロードした登録用紙に書いて、もう一度選んでください。'); }
        }
        const at = sheetFiles.findIndex((f) => f.name === file.name);
        if (at >= 0) { sheetFiles[at] = entry; notes.push('「' + file.name + '」は、新しく選んだ方に入れ替えました。'); } else sheetFiles.push(entry);
      }
    } finally { hideProgress(); }
    renderSheetView(notes);
  }

  function sheetValue(key, value) {
    if (key === 'aliases') return Array.isArray(value) && value.length ? value.join('、') : '（空）';
    if (value === '' || value == null) return '（空）';
    if (key === 'marginRate') { const n = Number(value); return `${value}（${Math.round((Math.abs(n) <= 1 ? n * 100 : n) * 10) / 10}%）`; }
    if (typeof value === 'number' && key !== 'jan') return value.toLocaleString('ja-JP', { maximumFractionDigits: 4 });
    return String(value);
  }

  function sheetLineRow(line) {
    const it = line.record || line.item || {};
    const meta = [it.manufacturer, it.specification, it.jan ? `JAN ${it.jan}` : ''].filter(Boolean).join('　');
    let detail = '—';
    if (line.status === 'error') detail = `<ul class="sheet-reasons">${line.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
    else if (line.status === 'update') detail = `<ul class="sheet-changes">${line.changes.map((ch) => `<li><b>${esc(ch.label)}</b> ${esc(sheetValue(ch.key, ch.before))} → <strong>${esc(sheetValue(ch.key, ch.after))}</strong>${ch.computed ? '<small>（計算）</small>' : ''}</li>`).join('')}</ul>`;
    else if (line.status === 'new') {
      const parts = ['packSize', 'costNet', 'costGross', 'priceNet', 'priceGross', 'marginRate', 'aliases', 'leadDays'].filter((k) => (k === 'aliases' ? (it.aliases || []).length : it[k] !== '' && it[k] != null))
        .map((k) => `<li><b>${esc(PS.LABEL[k])}</b> ${esc(sheetValue(k, it[k]))}${line.computed.includes(k) ? '<small>（計算）</small>' : ''}</li>`);
      detail = parts.length ? `<ul class="sheet-changes">${parts.join('')}</ul>` : '商品名だけ';
    }
    const gap = line.missing && line.missing.length ? `<p class="sheet-missing">空の項目あり（${esc(PS.missingLabel(line.missing))}）。登録はできます。あとで埋めてください</p>` : '';
    return `<tr class="sheet-line is-${line.status}${gap ? ' has-missing' : ''}"><td class="sheet-at">${esc(line.at)}</td><td><span class="sheet-badge is-${line.status}">${SHEET_STATUS[line.status]}</span></td><td class="sheet-product"><strong>${esc(it.name || '（商品名なし）')}</strong>${meta ? `<small>${esc(meta)}</small>` : ''}</td><td class="sheet-detail">${detail}${gap}</td></tr>`;
  }

  function renderSheetView(notes = []) {
    const root = $('#modal-root');
    const result = PS.plan(sheetFiles, masterProducts());
    const c = result.counts; const month = state.data?.month?.month || ''; const monthLabel = state.data?.month?.label || month;
    let rid = requestId(); // この表の操作番号。何回押しても、登録は1回（表を作り直したら、新しい番号）
    const order = { error: 0, new: 1, update: 2 };
    const main = result.lines.filter((l) => l.status !== 'same').sort((a, b) => order[a.status] - order[b.status]);
    const same = result.lines.filter((l) => l.status === 'same');
    const head = '<thead><tr><th>行</th><th>状態</th><th>商品</th><th>変わる所・理由</th></tr></thead>';
    const blocked = result.fileErrors.length || c.error;
    const message = blocked ? 'エラーがあるので、登録できません。用紙を直して「もう一度アップロード」してください（同じ名前の用紙は、新しい方に入れ替わります）。'
      : (!result.canSave ? '変わる行がありません（どの行も、商品マスターと同じです）。' : '内容を確かめて「登録する」を押してください。すでにある商品の行で空の欄は、いまの値のままです。' + (result.incomplete ? `空の項目がある行が ${result.incomplete} 行あります（黄色の注意）。登録はできます。あとで埋めてください。` : ''));
    const files = sheetFiles.map((f, i) => `<li><span><strong>${esc(f.name)}</strong><small>${f.items.length} 行</small></span><button type="button" class="button button-quiet sheet-file-remove" data-file-index="${i}">外す</button></li>`).join('');
    root.innerHTML = `<div class="modal-backdrop"><section class="modal-card upload-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-heading"><h2 id="modal-title">登録用紙の確かめ</h2><button type="button" class="modal-close" aria-label="閉じる">×</button></div><div class="sheet-view">
      <div class="sheet-files"><ul>${files}</ul><button type="button" class="button button-secondary product-upload">もう一度アップロード</button><input class="product-upload-input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple hidden></div>
      ${notes.map((n) => `<p class="form-note">${esc(n)}</p>`).join('')}
      ${result.fileErrors.length ? `<div class="sheet-file-errors" role="alert"><strong>用紙を確かめてください</strong><ul>${result.fileErrors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
      <div class="sheet-counts">${['new', 'update', 'same', 'error'].map((k) => `<div class="sheet-count is-${k}"><span>${SHEET_STATUS[k]}</span><b>${c[k]}</b></div>`).join('')}</div>
      <p class="sheet-message ${blocked ? 'is-error' : ''}">${esc(message)}</p>
      ${main.length ? `<div class="sheet-table-wrap"><table class="sheet-table">${head}<tbody>${main.map(sheetLineRow).join('')}</tbody></table></div>` : ''}
      ${same.length ? `<details class="sheet-same"><summary>変わらない ${same.length} 行を見る</summary><div class="sheet-table-wrap"><table class="sheet-table">${head}<tbody>${same.map(sheetLineRow).join('')}</tbody></table></div></details>` : ''}
      ${c.new && month && !blocked ? `<label class="check-line sheet-add-month"><input type="checkbox" checked> 新しい商品 ${c.new} 件を、${esc(monthLabel)}の注文書にも入れる</label>` : ''}
      <div class="sheet-actions"><button type="button" class="button button-secondary sheet-back">商品マスターへ戻る</button><button type="button" class="button button-primary sheet-save" ${result.canSave ? '' : 'disabled'}>登録する（新規 ${c.new}・更新 ${c.update}）</button></div>
    </div></section></div>`;
    root.querySelector('.modal-close').addEventListener('click', () => { sheetFiles = []; root.replaceChildren(); });
    root.querySelector('.modal-backdrop').addEventListener('click', (e) => { if (e.target.classList.contains('modal-backdrop')) { sheetFiles = []; root.replaceChildren(); } });
    root.querySelector('.sheet-back').addEventListener('click', () => openProductManager());
    root.querySelectorAll('.sheet-file-remove').forEach((b) => b.addEventListener('click', () => { sheetFiles.splice(Number(b.dataset.fileIndex), 1); if (sheetFiles.length) renderSheetView(); else openProductManager(); }));
    bindSheetUpload(root);
    const addBox = root.querySelector('.sheet-add-month input');
    addBox?.addEventListener('change', () => { rid = requestId(); });
    const save = root.querySelector('.sheet-save'); const label = save.textContent;
    save.addEventListener('click', async () => {
      if (!result.canSave || save.disabled) return;
      const body = { month, addToMonth: Boolean(addBox && addBox.checked), rows: PS.payload(result), requestId: rid };
      if (JSON.stringify(body).length > 190000) { toast('用紙が大きすぎて、1回で送れません。行を2つの用紙に分けて、1つずつ登録してください。', true); return; }
      save.disabled = true; save.textContent = '登録しています…';
      try {
        const res = await api('saveProductsBatch', body);
        sheetFiles = [];
        await refreshWorkspace(month || undefined);
        openProductManager();
        toast(res?.message || '登録しました。');
      } catch (error) {
        if (error.code === 'SESSION') { sheetFiles = []; root.replaceChildren(); showLoginPanel(error.message, 'info'); return; }
        toast(error.message, true); save.disabled = false; save.textContent = label; // 押し直しても、同じ操作番号なので登録は1回
      }
    });
  }

  async function openAuditLog() {
    const root = $('#modal-root');
    root.innerHTML = '<div class="modal-backdrop"><section class="modal-card audit-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-heading"><h2 id="modal-title">操作履歴</h2><button type="button" class="modal-close" aria-label="閉じる">×</button></div><div class="audit-list" aria-live="polite"><p class="guide-footnote loading-line"><span class="spinner" aria-hidden="true"></span>履歴を読み込んでいます…</p></div></section></div>';
    const close = () => root.replaceChildren();
    root.querySelector('.modal-close').addEventListener('click', close);
    root.querySelector('.modal-backdrop').addEventListener('click', (event) => { if (event.target.classList.contains('modal-backdrop')) close(); });
    try {
      const result = await api('getAuditLog', { limit: 30 });
      const list = root.querySelector('.audit-list'); if (!list) return;
      const entries = result.entries || [];
      const actionNames = { startSession: 'ログイン', getWorkspace: '発注一覧を表示', getGuide: '利用ガイドを表示', saveOrderBatch: '注文を保存（自動）', setProductCap: '在庫量を保存', saveProduct: '商品を保存', saveProductsBatch: '登録用紙で商品を登録', exportOrders: 'Excel でダウンロード', setMonthProduct: 'この月の商品を変更', copyMonthProducts: '前の月の商品を写す', saveMonthConfig: '月度設定を保存', confirmMonth: '締切後に確定', endSession: 'ログアウト', getAuditLog: '操作履歴を表示', unknown: '一覧に無い操作' };
      const roleNames = { BY: '畜産BY', STORE: '店舗', WAREHOUSE: '倉庫', SYSTEM: '自動処理' };
      list.innerHTML = entries.length ? entries.map((entry) => {
        const time = entry.at ? new Date(entry.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '';
        const denied = String(entry.result || '').indexOf('DENY') === 0;
        return `<article class="audit-item"><div class="audit-line"><strong>${esc(actionNames[entry.action] || entry.action || '操作')}</strong><time>${esc(time)}</time><span class="audit-result ${denied ? 'is-denied' : ''}">${esc(denied ? '断った' : (entry.result === 'ALLOW' ? '完了' : entry.result || '記録'))}</span></div><p>${esc(entry.email || '')}　·　${esc(roleNames[entry.role] || entry.role || '')}　·　${esc(entry.target || '—')}</p><details><summary>変更の前と後・結果</summary><div class="audit-diff"><div><b>変更前</b><code>${esc(entry.beforeJson || '記録なし')}</code></div><div><b>変更後・結果</b><code>${esc(entry.afterJson || '記録なし')}</code></div></div></details></article>`;
      }).join('') : '<p class="guide-footnote">操作履歴はまだありません。</p>';
    } catch (error) {
      const list = root.querySelector('.audit-list'); if (list) { list.replaceChildren(); const p = document.createElement('p'); p.className = 'guide-footnote'; p.textContent = error.message; list.append(p); }
    }
  }

  const EDITOR_KEYS = ['manufacturer', 'name', 'specification', 'jan', 'packSize', 'costNet', 'costGross', 'priceNet', 'priceGross', 'marginRate', 'leadDays'];
  function openProductEditor(existing = {}) {
    const aliases = Array.isArray(existing.aliases) ? existing.aliases.join('、') : '';
    const v = (x) => esc(x === undefined || x === null ? '' : x);
    const isNew = !existing.id;
    const must = '<span class="must-tag">※必須</span>';
    const note = (key) => `<small class="field-note" data-note-for="${key}" aria-live="polite"></small>`;
    const field = (label, key, attrs, tag = '') => `<label><span class="field-label">${label}${tag}</span><input name="${key}" ${attrs} value="${v(existing[key])}"></label>${note(key)}`;
    const fields = `<input name="productId" type="hidden" value="${v(existing.id)}">`
      + `<p class="form-note editor-rule">「※必須」の2つ（商品名・締切（何日前））は、空では保存できません。ほかの欄も書いてください（空でも保存はできます。黄色の印の欄は、あとで埋めてください）。</p>`
      + field('メーカー', 'manufacturer', 'maxlength="120"')
      + field('商品名', 'name', 'maxlength="120" autocomplete="off"', must)
      + (isNew ? '<div class="similar-products" aria-live="polite" hidden></div>' : '')
      + field('規格', 'specification', 'maxlength="120"')
      + field('JAN（数字だけ 8〜13けた）', 'jan', 'inputmode="numeric" maxlength="32" autocomplete="off"')
      + field('入数（1以上の整数）', 'packSize', 'type="number" min="1" step="1"')
      + `<label>検索用の読み・別名<input name="aliases" placeholder="例：ぶたばら、豚三枚肉" value="${esc(aliases)}"></label>`
      + `<div class="form-grid"><div>${field('原価（本体）', 'costNet', 'type="number" min="0" step="0.01"')}</div><div>${field('原価（税込・総額）', 'costGross', 'type="number" min="0" step="0.01"')}</div><div>${field('売価（本体）', 'priceNet', 'type="number" min="0" step="0.01"')}</div><div>${field('売価（税込・総額）', 'priceGross', 'type="number" min="0" step="0.01"')}</div><div>${field('値入率（0.29 か 29）', 'marginRate', 'type="number" min="0" step="any"')}</div></div>`
      + field('締切（何日前）', 'leadDays', 'type="number" min="0" max="30" step="1" inputmode="numeric" placeholder="例 2"', must)
      + `<p class="form-note">着く日の何日前の 12:00 で、店の注文を締め切るか（0〜30）。例 2 なら、11/1 着は 10/30 12:00 まで店が直せます。</p><p class="form-note calc-note">税込（総額）は、本体を入れると自動で入ります（本体×1.08 の端数切り捨て）。値入率も、空なら（売価−原価）÷売価 で入ります。手で直した数は、そのままです。</p>`;
    showModal(isNew ? '商品を追加' : '商品を直す', fields, async (form) => {
      const bad = checkEditor(form, true);
      if (bad) { bad.focus(); throw new Error('赤い字の欄を直してください（理由は欄の下）。'); }
      const product = Object.fromEntries(EDITOR_KEYS.map((key) => [key, form.elements[key].value]));
      if (form.elements.productId.value) product.productId = form.elements.productId.value;
      product.aliases = form.elements.aliases.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
      const res = await api('saveProduct', { product, month: state.data.month?.month, requestId: requestId() }); await refreshWorkspace(state.data.month?.month); toast(res?.message || '商品を保存しました。');
    });
    const form = $('#modal-root form');
    form.noValidate = true; // 理由は欄の下に出す（ブラウザの吹き出しに任せない）
    bindAutoCalc(form);
    bindEditorNotes(form, !isNew);
    if (isNew) bindSimilar(form);
  }

  /** 欄の下の理由。赤＝直さないと保存できない（商品名・締切が空・形が違う）。黄色＝空です（あとで埋めてください・保存はできる）。決まりは ProductSheet.fieldProblem（GAS と同じ） */
  function editorNote(form, key, show) {
    const el = form.elements[key]; const box = form.querySelector(`[data-note-for="${key}"]`); if (!el || !box || !PS) return '';
    const value = el.value;
    const problem = el.validity && el.validity.badInput ? `${PS.LABEL[key]}は数で入れてください。` : PS.fieldProblem(key, value);
    const empty = !problem && PS.FILL_LATER.includes(key) && String(value).trim() === '';
    const visibleProblem = problem && (show || String(value).trim() !== '');
    box.textContent = visibleProblem ? problem : (empty && show ? '空です（あとで埋めてください）' : '');
    box.className = 'field-note' + (visibleProblem ? ' is-error' : (empty && show ? ' is-missing' : ''));
    el.classList.toggle('is-error', Boolean(visibleProblem)); el.classList.toggle('is-missing', Boolean(!visibleProblem && empty && show));
    el.setAttribute('aria-invalid', visibleProblem ? 'true' : 'false');
    return problem;
  }
  /** 全部の欄を確かめる（show＝空の欄にも印）。直す欄があれば、最初の欄を返す */
  function checkEditor(form, show) {
    let first = null;
    EDITOR_KEYS.forEach((key) => { if (editorNote(form, key, show) && !first) first = form.elements[key]; });
    return first;
  }
  function bindEditorNotes(form, showNow) {
    if (!form || !PS) return;
    const touched = new Set();
    EDITOR_KEYS.forEach((key) => {
      const el = form.elements[key]; if (!el) return;
      el.addEventListener('input', () => editorNote(form, key, showNow || touched.has(key)));
      el.addEventListener('blur', () => { touched.add(key); editorNote(form, key, true); });
    });
    if (showNow) checkEditor(form, true); // いまの商品を開いたときは、空の欄に初めから印（BY の知らせから来たとき、どこを埋めるか分かる）
  }

  /** 税込（総額）・値入率を自動で入れる。開いたときに空か計算どおりの欄は「自動」＝本体を変えると追随する。手で直した欄は上書きしない（GAS も同じ計算をし直す） */
  function bindAutoCalc(form) {
    if (!PS || !form) return;
    const el = (n) => form.elements[n];
    const num = (n) => (el(n).value === '' ? '' : Number(el(n).value));
    const pairs = [['costNet', 'costGross'], ['priceNet', 'priceGross']];
    const auto = {};
    pairs.forEach(([net, gross]) => { auto[gross] = el(gross).value === '' || Number(el(gross).value) === PS.grossOf(num(net)); });
    auto.marginRate = el('marginRate').value === '' || Number(el('marginRate').value) === PS.marginOf(num('costNet'), num('priceNet'));
    const mark = () => ['costGross', 'priceGross', 'marginRate'].forEach((n) => el(n).classList.toggle('is-auto', Boolean(auto[n]) && el(n).value !== ''));
    const recalc = () => {
      pairs.forEach(([net, gross]) => { if (auto[gross]) { const g = PS.grossOf(num(net)); el(gross).value = g === '' ? '' : String(g); } });
      if (auto.marginRate) { const m = PS.marginOf(num('costNet'), num('priceNet')); el('marginRate').value = m === '' ? '' : String(m); }
      mark();
    };
    ['costNet', 'priceNet'].forEach((n) => el(n).addEventListener('input', recalc));
    ['costGross', 'priceGross', 'marginRate'].forEach((n) => el(n).addEventListener('input', () => { auto[n] = el(n).value === ''; mark(); }));
    mark();
  }

  /** 「商品を追加」で商品名・JAN を打つと、マスターにある似た商品（上から5件）を出す。押すと、その商品を直す画面へ（同じ商品を2つ作らない） */
  function bindSimilar(form) {
    const box = form && form.querySelector('.similar-products'); const master = masterProducts();
    if (!box || !PS || !master.length) return;
    const keys = new Map();
    const keyOf = (p) => { const id = String(p.id); if (!keys.has(id)) keys.set(id, productKey(p)); return keys.get(id); };
    let timer = 0;
    const draw = () => {
      const hits = PS.similar(form.elements.name.value, form.elements.jan.value, master, SN, keyOf);
      box.replaceChildren();
      if (!hits.length) { box.hidden = true; return; }
      const head = document.createElement('p'); head.className = 'similar-head'; head.textContent = '商品マスターに似た商品があります。同じ商品なら、押して、その商品を直してください。';
      box.append(head);
      hits.forEach(({ product, why }) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'similar-item';
        const s = document.createElement('strong'); s.textContent = product.name || '';
        const m = document.createElement('small'); m.textContent = [why === 'jan' ? 'JANが同じ' : (why === 'same' ? '商品名が同じ' : ''), product.manufacturer, product.specification, product.jan].filter(Boolean).join('　');
        b.append(s, m); b.addEventListener('click', () => openProductEditor(product)); box.append(b);
      });
      box.hidden = false;
    };
    const later = () => { window.clearTimeout(timer); timer = window.setTimeout(draw, 150); };
    form.elements.name.addEventListener('input', later); form.elements.jan.addEventListener('input', later);
  }

  function showModal(title, fields, onSave) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop"><section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-heading"><h2 id="modal-title">${esc(title)}</h2><button type="button" class="modal-close" aria-label="閉じる">×</button></div><form class="modal-form">${fields}<div class="modal-actions"><button type="button" class="button button-secondary modal-cancel">キャンセル</button><button type="submit" class="button button-primary">保存</button></div></form></section></div>`;
    const close = () => root.replaceChildren();
    root.querySelector('.modal-close').addEventListener('click', close); root.querySelector('.modal-cancel').addEventListener('click', close);
    root.querySelector('.modal-backdrop').addEventListener('click', (e) => { if (e.target.classList.contains('modal-backdrop')) close(); });
    root.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type="submit"]'); if (button.disabled) return;
      const done = busyButton(button, '保存中…');
      try { await onSave(form); close(); } catch (error) { done(); toast(error.message, true); }
    });
  }

  // ------------------------------------------------------------ 探す（共通の部品 SearchNorm。書き方のゆれを吸収する）
  function productKey(p) { const t = [p.name, p.manufacturer, p.specification, p.jan, ...(Array.isArray(p.aliases) ? p.aliases : [])].filter(Boolean).join(' '); return SN ? SN.key(t) : simpleFold(t); }
  function makeTerms(q) { return SN ? SN.terms(q) : simpleFold(q).split(/\s+/).filter(Boolean); }
  function hitKey(key, terms) { if (!key) return false; return SN ? SN.hit(key, terms) : terms.every((t) => key.includes(t)); }
  function simpleFold(v) { return String(v || '').normalize('NFKC').toLowerCase().replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)); }
  function buildSearchKeys() { state.keys = new Map((state.data?.products || []).map((p) => [String(p.id), productKey(p)])); if (state.search) runSearch(false); }
  function runSearch(render = true) {
    state.terms = state.search ? makeTerms(state.search) : null;
    state.matches = state.terms ? new Set((state.data?.products || []).filter((p) => hitKey(state.keys.get(String(p.id)), state.terms)).map((p) => String(p.id))) : null;
    if (render) { renderOrders(); renderSearchSuggestions(); }
  }
  function filteredProducts(products) { return state.matches ? products.filter((p) => state.matches.has(String(p.id))) : products; }

  function renderSearchSuggestions() {
    const host = $('#search-suggestions'); const input = $('#product-search'); host.replaceChildren();
    if (!state.search || !state.data || !state.matches || !state.matches.size) { host.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }
    const matches = (state.data.products || []).filter((p) => state.matches.has(String(p.id))).slice(0, 8);
    matches.forEach((product) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'suggestion-item';
      const title = document.createElement('strong'); title.textContent = product.name || '';
      const sub = document.createElement('small'); sub.textContent = [product.manufacturer, product.specification, product.jan].filter(Boolean).join('　');
      button.append(title, sub);
      button.addEventListener('click', () => { input.value = product.name || ''; state.search = input.value; state.matches = new Set([String(product.id)]); renderOrders(); host.hidden = true; input.setAttribute('aria-expanded', 'false'); });
      host.append(button);
    });
    host.hidden = matches.length === 0; input.setAttribute('aria-expanded', String(matches.length > 0));
  }

  // ------------------------------------------------------------ はじめ
  $('#login-button').addEventListener('click', beginLogin);
  $('#signout-button').addEventListener('click', signOut);
  $('#month-select').addEventListener('change', async () => {
    const next = $('#month-select').value;
    if ((await settleSaves()) && !window.confirm('保存できていない欄（⚠）があります。月を切り替えると消えます。切り替えますか？')) { $('#month-select').value = state.data?.month?.month || ''; return; }
    clearPendingMarks(); state.weekKey = '';
    const t0 = performance.now(); const label = $('#month-select').selectedOptions[0]?.textContent || '';
    showProgress(`${label}を読み込んでいます…`); renderSkeleton(`${label}を読み込んでいます…`);
    refreshWorkspace(next).then(() => perfNote('month', t0)).catch(() => {}).finally(hideProgress);
  });
  // 表の入力と週のタブ（表の入れ物で受ける。表を描き直しても付け直さない）
  (() => {
    const host = $('#order-content'); if (!host) return;
    const isInput = (t) => t && t.matches && t.matches('[data-order-input],[data-cap-input]');
    // 受けるのは「捕まえる段」（true）: 泡立たない合図（blur など）も、ここで受けられる
    host.addEventListener('input', (e) => { const t = e.target; if (!isInput(t)) return; if (t.matches('[data-order-input]')) onOrderType({ currentTarget: t }); else onCapType({ currentTarget: t }); }, true);
    host.addEventListener('change', (e) => { if (isInput(e.target)) flushNow(); }, true);
    host.addEventListener('blur', (e) => { if (isInput(e.target)) flushNow(); }, true);
    host.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('.week-tab'); if (b && host.contains(b)) switchWeek(b); });
  })();
  /** 週のタブ: 押したタブをすぐ選んだ形にして（印つき）、次の描画で表を描く（押した反応を先に返す） */
  function switchWeek(b) {
    if (b.classList.contains('is-active')) return;
    const t0 = performance.now(); const key = b.dataset.week; state.weekKey = key;
    document.querySelectorAll('#order-content .week-tab').forEach((x) => { const on = x === b; x.classList.toggle('is-active', on); x.setAttribute('aria-selected', String(on)); });
    b.classList.add('is-loading');
    let ran = false;
    const go = () => { if (ran) return; ran = true; renderOrders(); perfNote('week', t0); const again = document.querySelector(`.week-tab[data-week="${CSS.escape(key)}"]`); if (again) again.focus(); };
    window.requestAnimationFrame(() => window.setTimeout(go, 0)); window.setTimeout(go, 60); // 見えていない画面では描画の合図が来ないので、時間でも描く
  }
  $('#print-button').addEventListener('click', async () => { if (await settleSaves()) { toast('保存できていない欄（⚠）があります。直して保存されてから、印刷してください。', true); return; } window.print(); });
  $('#excel-button').addEventListener('click', () => exportExcel());
  window.addEventListener('beforeprint', () => { fillPrintHead(); fillPrintAll(); }); // 画面は1週ずつ（タブ）・印刷は全部の週
  window.addEventListener('afterprint', clearPrintAll);
  $('#product-search').addEventListener('input', (event) => {
    state.search = event.target.value.trim(); window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(() => runSearch(true), 150);
  });
  document.addEventListener('click', (event) => { if (!event.target.closest('.search-area')) { $('#search-suggestions').hidden = true; $('#product-search').setAttribute('aria-expanded', 'false'); } });
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    state.view = button.dataset.view;
    document.querySelectorAll('[data-view]').forEach((b) => { b.classList.toggle('is-active', b === button); b.setAttribute('aria-selected', String(b === button)); });
    if (state.data) renderOrders();
  }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - remain.last > 5000) pollRemaining(); }); // 画面に戻ってきたとき
  window.addEventListener('focus', () => { if (Date.now() - remain.last > 5000) pollRemaining(); });
  window.addEventListener('beforeunload', (event) => { if (!state.leaving && (pendingCount() || auto.inflight)) { flushNow(); event.preventDefault(); event.returnValue = ''; } }); // 送っている途中・失敗が残っているときは、閉じる前に止める

  async function start() {
    noteServerVersion('');
    try { window.sessionStorage.removeItem('livestock-order-session-v1'); } catch {}
    const redirect = L ? L.consumeRedirect(window.__oauthRedirectHash, store('local') || { getItem: () => null, setItem() {}, removeItem() {} }, Date.now()) : null;
    window.__oauthRedirectHash = null;
    renderInAppWarning();
    if (!GAS_URL_OK) { setStatus('接続先の設定待ち', false); setLoginButton(false, 'ログインの準備中'); setLoginHelp('GASの導入の設定が終わると、ログインできます。'); return; }
    setStatus('接続を確かめています', false);
    const t0 = performance.now();
    let opening = null;
    if (!(redirect && redirect.accessToken)) {
      state.session = readSession();
      if (state.session) { // 前回のログインの札がある: 注文の読み込みを先に出す（bootstrap の返事を待たない）
        $('#login-panel').hidden = true; $('#workspace').hidden = false; text($('#account-label'), 'ログイン中…');
        showProgress('前回のログインで開いています…'); renderSkeleton('注文を読み込んでいます…');
        opening = refreshWorkspace().then(() => perfNote('open', t0)).catch(() => { /* 画面に出してある */ }).finally(hideProgress);
      }
    }
    try { const cfg = await api('bootstrap', {}, false); state.clientId = cfg.clientId || ''; }
    catch (error) { if (opening) { await opening; return; } setStatus('接続できません', false); setLoginHelp(error.message); showNotice(error.message, 'error', '', () => location.reload()); return; }
    if (!state.clientId) { setStatus('接続できません', false); setLoginHelp('ログインの設定が終わっていません（E-SETUP）。導入の担当へ連絡してください。'); return; }
    setLoginButton(true, 'Googleでログイン'); if (!state.data) setStatus('ログインできます', true); setLoginHelp('会社のアカウント（本部・店舗）を選んでください。');
    preloadGisIfPopup(false);
    if (redirect && redirect.accessToken) { await finishLogin(redirect.accessToken); return; }
    if (redirect && redirect.error) showLoginHelpKind(redirect.error);
    if (opening) await opening;
  }
  start().catch(() => {});
})();
