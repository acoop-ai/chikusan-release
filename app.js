(() => {
  'use strict';
  // 畜産発注の画面（版 livestock-order-api-0.2.1）。業務データ・アカウント表・鍵は置かない。だれか・何ができるかは、毎回 GAS が決める。
  // 信頼境界: GAS から届く文字（商品名・店名など）は、人が打った文字。画面に出すときは textContent か esc() を通す。
  const APP_VERSION = 'livestock-order-api-0.2.1';
  const CONFIG = window.APP_CONFIG || {};
  const GAS_URL = String(CONFIG.gasUrl || '');
  const GAS_URL_OK = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(GAS_URL);
  const REDIRECT_URI = String(CONFIG.oauthRedirectUri || '');
  const SESSION_KEY = 'livestock-order-session-v2';
  const DRAFT_KEY = 'livestock-order-draft-v1';
  const SESSION_MSG = 'ログインの期限が切れました。もう一度ログインしてください。';
  const L = window.LivestockLogin;
  const SN = window.SearchNorm || null;
  const state = { clientId: '', serverVersion: '', session: null, data: null, view: 'week', search: '', terms: null, matches: null, keys: new Map(), tokenClient: null, tokenJob: null, gisLoading: null, loggingIn: false, leaving: false, searchTimer: 0 };

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
    const timer = controller ? window.setTimeout(() => controller.abort(), 60000) : 0;
    let response;
    try { response = await fetch(GAS_URL, { method: 'POST', mode: 'cors', redirect: 'follow', cache: 'no-store', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), signal: controller?.signal }); }
    catch { throw appError('通信できませんでした。電波の良い所で、もう一度お試しください。', 'NETWORK'); }
    finally { if (timer) window.clearTimeout(timer); }
    if (!response.ok) throw appError(`通信に失敗しました（${response.status}）。時間をおいて、もう一度お試しください。`, 'NETWORK');
    let result;
    try { result = await response.json(); } catch { throw appError('サーバーの返事を読めませんでした。少し待ってから、もう一度お試しください。', 'NETWORK'); }
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
  function showNotice(message, kind = 'info', title) {
    const box = $('#notice');
    if (!message) { box.hidden = true; return; }
    box.hidden = false;
    box.className = `notice ${kind === 'error' ? 'notice-error' : 'notice-info'}`;
    text(box.querySelector('.notice-icon'), kind === 'error' ? '!' : 'i');
    const copy = box.querySelector('div'); copy.replaceChildren();
    const strong = document.createElement('strong'); strong.textContent = title || (kind === 'error' ? '確かめてください' : 'お知らせ');
    const p = document.createElement('p'); p.textContent = message; copy.append(strong, p);
  }
  function toast(message, error = false) {
    const node = $('#toast'); text(node, message); node.classList.toggle('is-error', error); node.hidden = false;
    window.clearTimeout(toast.timer); toast.timer = window.setTimeout(() => { node.hidden = true; }, 5200);
  }
  function showProgress(message) { const node = $('#progress'); if (!node) return; text(node.querySelector('span'), message); node.hidden = false; }
  function hideProgress() { const node = $('#progress'); if (node) node.hidden = true; }

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
    const choice = L.chooseMode({ ua: navigator.userAgent, standalone: isStandalone(), redirectUri: REDIRECT_URI, origin: location.origin, hasUnsaved: pendingInputs().length > 0 });
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
    showProgress('ログインしています…'); setLoginButton(false, '確かめています…');
    try {
      const data = await api('startSession', { accessToken }, false);
      saveSession({ t: data.session, e: Number(data.expiresAt) || Date.now() + 7 * 86400000 });
      await refreshWorkspace((keep && keep.month) || (draft && draft.month) || undefined, { reapply: keep, restoreDraft: true });
    } catch (error) {
      clearSession(); showLoginPanel(error.message, error.code === 'SESSION' ? 'info' : 'error');
    } finally {
      state.loggingIn = false; hideProgress(); setLoginButton(true, 'Googleでログイン');
    }
  }

  function showLoginPanel(message, kind = 'error') {
    const hasPending = pendingInputs().length > 0 && !$('#workspace').hidden;
    $('#login-panel').hidden = false;
    if (!hasPending) { $('#workspace').hidden = true; $('#period-control').hidden = true; $('#signout-button').hidden = true; text($('#account-label'), '未ログイン'); }
    setStatus('ログインしてください', false);
    if (message) showNotice(hasPending ? message + '　保存していない入力は、ログインし直すと戻ります。' : message, kind);
    preloadGisIfPopup(hasPending);
    $('#login-panel').scrollIntoView({ block: 'nearest' });
  }

  function signOut() {
    if (pendingInputs().length && !window.confirm('保存していない入力があります。ログアウトすると消えます。ログアウトしますか？')) return;
    if (state.session) api('endSession', { requestId: requestId() }).catch(() => {});
    clearSession(); state.data = null; clearPendingMarks();
    $('#workspace').hidden = true; $('#period-control').hidden = true; $('#signout-button').hidden = true; $('#login-panel').hidden = false;
    showNotice(''); text($('#account-label'), '未ログイン'); setStatus('ログアウトしました', false); setLoginHelp('会社のアカウント（本部・店舗）を選んでください。');
  }

  // ------------------------------------------------------------ 画面
  async function refreshWorkspace(month, opts = {}) {
    try {
      const payload = await api('getWorkspace', { month: month || $('#month-select').value || '' });
      state.data = payload; buildSearchKeys();
      $('#login-panel').hidden = true; $('#workspace').hidden = false; $('#period-control').hidden = false; $('#signout-button').hidden = false;
      text($('#account-label'), payload.principal?.label || payload.principal?.email || 'ログイン中');
      setStatus('接続中', true); showNotice('');
      renderWorkspace();
      if (opts.reapply && opts.reapply.month === payload.month?.month) { const n = applyChanges(opts.reapply.changes); if (n) toast(`保存していない入力を ${n} 件戻しました。「注文を保存」を押してください。`); }
      if (opts.restoreDraft) restoreDraft();
    } catch (error) {
      if (error.code === 'SESSION' || error.code === 'DENIED' || error.code === 'LOGIN') { showLoginPanel(error.message, error.code === 'SESSION' ? 'info' : 'error'); }
      else { setStatus('情報を取得できません', false); showNotice(error.message, 'error'); }
      throw error;
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
    $('#deadline-note').hidden = false;
    text($('#deadline-sidebar'), config.deadline ? `締切：${config.deadlineLabel || config.deadline}（${config.statusLabel || ''}）` : '締切はまだ決まっていません。決まると、店舗が注文を入れられます。');
    renderSummary(data, config);
    renderRoleNotice(data, config);
    renderRoleActions(data, config);
    renderWarehouseSetting(data, config);
    renderOrders();
  }

  function renderSummary(data, config) {
    const principal = data.principal || {};
    const cards = [['利用区分', principal.roleLabel || principal.role || ''], ['受注締切', config.deadlineLabel || '未設定'], ['状態', config.statusLabel || '']];
    if (principal.role === 'STORE') cards.splice(1, 0, ['あなたの店', principal.label || '']);
    const host = $('#summary-strip'); host.replaceChildren();
    host.classList.toggle('has-four', cards.length === 4);
    cards.forEach(([label, value]) => { const card = document.createElement('div'); card.className = 'summary-card'; const s = document.createElement('span'); s.textContent = label; const b = document.createElement('strong'); b.textContent = value; card.append(s, b); host.append(card); });
  }

  function renderRoleNotice(data, config) {
    const host = $('#role-notice'); const role = data.principal?.role;
    let message = '', kind = 'info';
    if (role === 'STORE') {
      if (!config.deadline) { message = 'この月の締切は、まだ決まっていません。畜産BYが締切を入れると、注文を入れられます。'; kind = 'wait'; }
      else if (config.confirmed) { message = '締切を過ぎました（確定）。直すときは、畜産BYへ頼んでください。'; kind = 'wait'; }
      else message = `緑の「自店」の列に、ケース数を入れて「注文を保存」を押してください。締切は ${config.deadlineLabel} です。`;
    } else if (role === 'WAREHOUSE') message = '注文の入っていない欄は灰色です。印刷は、右上の「印刷」から。';
    else if (role === 'BY' && !config.configured) { message = 'この月は、まだ月度設定がありません。「月度設定」で締切を入れると、店舗に表示されます。'; kind = 'wait'; }
    host.hidden = !message; text(host, message); host.className = `role-notice ${kind === 'wait' ? 'is-wait' : ''}`;
  }

  function renderRoleActions(data, config) {
    const role = data.principal?.role;
    const host = $('#role-actions'); host.replaceChildren();
    if (role === 'BY') {
      host.append(makeButton('月度設定', () => openSettings(), 'button button-secondary'));
      host.append(makeButton('商品マスター', () => openProductManager(), 'button button-secondary'));
      host.append(makeButton('操作履歴', () => openAuditLog(), 'button button-secondary'));
      host.append(makeButton('注文を保存', () => saveVisibleOrders(), 'button button-primary save-orders'));
    }
    if (role === 'STORE' && config.deadline && !config.confirmed) host.append(makeButton('注文を保存', () => saveVisibleOrders(), 'button button-primary save-orders'));
    updateSaveButton();
  }

  function renderWarehouseSetting(data, config) {
    const node = $('#warehouse-cap-control'); const role = data.principal?.role;
    node.hidden = !(role === 'BY' || role === 'WAREHOUSE') || !config.capEnabled;
    if (node.hidden) return;
    const enabled = Boolean(config.warehouseCanEditCaps);
    node.innerHTML = `<div><strong>倉庫の上限編集 <a class="help-icon" href="guide.html#cap" title="上限と倉庫の編集権限について" aria-label="上限設定の説明を開く">?</a></strong></div><div>${role === 'BY' ? `<label><input type="checkbox" id="warehouse-cap-toggle" ${enabled ? 'checked' : ''}> 倉庫に上限設定を許可</label><button id="save-cap-permission" class="button button-secondary" type="button">設定を保存</button>` : `<strong>${enabled ? '上限を直せます（月間合計の画面）' : '見るだけ'}</strong>`}</div>`;
    $('#save-cap-permission')?.addEventListener('click', async () => {
      const button = $('#save-cap-permission'); button.disabled = true;
      try { await api('setWarehouseCapsAllowed', { month: config.month, allowed: $('#warehouse-cap-toggle').checked, requestId: requestId() }); await refreshWorkspace(config.month); toast('倉庫の上限編集の設定を保存しました。'); }
      catch (e) { toast(e.message, true); } finally { button.disabled = false; }
    });
  }

  function renderOrders() {
    const data = state.data; if (!data) return;
    const config = data.month || {};
    const host = $('#order-content');
    const products = filteredProducts(data.products || []);
    if (state.view === 'month') { host.innerHTML = renderMonthSummary(data, products, config); bindCapInputs(host); scrollToOwnColumn(host); return; }
    const weeks = Array.isArray(data.weeks) ? data.weeks : [];
    if (!weeks.length || !(data.products || []).length) { host.innerHTML = emptyState('この月の注文書は、まだ用意されていません。', '畜産BYが「月度設定」と「商品マスター」で商品を入れると、週ごとの表が出ます。'); return; }
    if (!products.length) { host.innerHTML = emptyState('探した商品は見つかりませんでした。', 'ひらがな・カタカナ・ローマ字・JANの一部でも探せます。空白で区切ると、どの語も含む商品だけが出ます。'); return; }
    host.innerHTML = weeks.map((week) => renderWeek(week, data, products, config)).join('');
    host.querySelectorAll('[data-order-input]').forEach((input) => input.addEventListener('change', onOrderInput));
    scrollToOwnColumn(host);
  }

  function storeHeads(stores, ownId) {
    return stores.map((s) => { const own = String(s.id) === String(ownId); return `<th class="store-head ${own ? 'is-own' : ''}">${own ? '<span class="own-badge">自店</span>' : ''}${esc(s.name)}<small>ケース</small></th>`; }).join('');
  }

  function renderWeek(week, data, products, config) {
    const stores = data.stores || []; const role = data.principal?.role; const ownStoreId = data.principal?.storeId;
    const isBY = role === 'BY'; const isStore = role === 'STORE';
    const storeOpen = Boolean(config.deadline) && !config.confirmed;
    const productIds = new Set(products.map((p) => String(p.id)));
    const byId = new Map((data.products || []).map((p) => [String(p.id), p]));
    const rows = (week.rows || []).filter((row) => productIds.has(String(row.productId)));
    const body = rows.map((row) => {
      const product = byId.get(String(row.productId)) || {};
      const soldOut = Boolean(row.soldOut);
      const cells = stores.map((st) => {
        const qty = row.quantities?.[st.id]; const own = String(st.id) === String(ownStoreId);
        const editable = row.inMonth !== false && (isBY || (isStore && own && storeOpen && !soldOut));
        const value = qty == null || qty === '' ? '' : qty;
        const cls = `store-cell ${own ? 'is-own' : ''} ${value === '' ? 'is-empty' : 'has-qty'}`;
        // 書ける欄だけ入力の箱にする。見るだけの欄は数だけ（注文の無い欄は灰色）
        if (!editable) return `<td class="${cls}"><span class="qty-view" aria-label="${esc(st.name)}のケース数">${value === '' ? '' : esc(value)}</span></td>`;
        return `<td class="${cls}"><input aria-label="${esc(row.dateLabel)} ${esc(product.name)} ${esc(st.name)}のケース数" type="number" inputmode="numeric" min="0" step="1" value="${esc(value)}" data-order-input data-date="${esc(row.date)}" data-product="${esc(row.productId)}" data-store="${esc(st.id)}"></td>`;
      }).join('');
      const total = stores.reduce((sum, st) => sum + (Number(row.quantities?.[st.id]) || 0), 0);
      return `<tr class="${soldOut ? 'soldout-row' : ''} ${row.inMonth === false ? 'outside-month-row' : ''}"><td class="col-date">${esc(row.dateLabel || row.date)}${soldOut ? '<br><span class="sold-out">SOLD OUT</span>' : ''}</td><td class="col-maker">${esc(product.manufacturer || '')}</td><td class="col-product product-cell"><small class="maker-inline">${esc(product.manufacturer || '')}</small><strong>${esc(product.name || '')}</strong><small>${esc(product.specification || '')}　${esc(product.jan || '')}</small>${productDetailsMarkup(product)}${row.remaining != null && !soldOut && row.inMonth !== false ? `<small class="cap-hint">あと ${esc(row.remaining)} ケース注文できます</small>` : ''}</td>${cells}<td class="total-cell">${total || '—'}</td></tr>`;
    }).join('');
    const columns = `<th class="col-date">日付</th><th class="col-maker">メーカー</th><th class="col-product">商品・規格・JAN</th>${storeHeads(stores, ownStoreId)}<th>合計</th>`;
    return `<section class="week-card"><div class="week-heading"><h3>${esc(week.label || '週')}</h3><span>${esc(week.startLabel || '')}${week.endLabel ? ` ～ ${esc(week.endLabel)}` : ''}</span></div><div class="table-scroll"><table class="order-table"><thead><tr>${columns}</tr></thead><tbody>${body || `<tr><td colspan="${stores.length + 4}">該当する商品がありません。</td></tr>`}</tbody></table></div></section>`;
  }

  function renderMonthSummary(data, products, config) {
    const stores = data.stores || []; const totals = data.monthTotals || {}; const ownStoreId = data.principal?.storeId;
    if (!products.length) return emptyState('月間合計はありません。', '対象月と商品が決まると、商品・店舗ごとの合計が出ます。');
    const role = data.principal?.role;
    const canEditCaps = Boolean(config.capEnabled && (role === 'BY' || (role === 'WAREHOUSE' && config.warehouseCanEditCaps)));
    const rows = products.map((p) => {
      const total = stores.reduce((sum, s) => sum + (Number(totals[p.id]?.[s.id]) || 0), 0);
      const cap = data.caps?.[p.id]; const remaining = cap == null ? '' : Math.max(0, Number(cap) - total);
      const capCell = canEditCaps ? `<input class="cap-input" data-cap-input data-product="${esc(p.id)}" type="number" inputmode="numeric" min="0" step="1" value="${cap == null ? '' : esc(cap)}" aria-label="${esc(p.name)}の月間上限">` : (cap == null ? '—' : esc(cap));
      return `<tr><td class="col-maker">${esc(p.manufacturer || '')}</td><td class="col-product product-cell"><small class="maker-inline">${esc(p.manufacturer || '')}</small><strong>${esc(p.name)}</strong><small>${esc(p.specification || '')}　${esc(p.jan || '')}</small>${productDetailsMarkup(p)}</td>${stores.map((s) => { const v = Number(totals[p.id]?.[s.id]) || 0; return `<td class="total-cell store-cell ${String(s.id) === String(ownStoreId) ? 'is-own' : ''} ${v ? '' : 'is-empty'}">${v || '—'}</td>`; }).join('')}<td class="total-cell">${total || '—'}</td><td>${capCell}</td><td>${cap == null ? '—' : esc(remaining)}</td></tr>`;
    }).join('');
    const heads = `<th class="col-maker">メーカー</th><th class="col-product">商品・規格・JAN</th>${storeHeads(stores, ownStoreId)}<th>月計</th><th>上限</th><th>残数</th>`;
    return `<section class="week-card"><div class="week-heading"><h3>${esc(config.label || '月間合計')}</h3><span>${canEditCaps ? '上限の欄を変えると、すぐ保存されます' : '商品・店舗ごとの月の合計'}</span></div><div class="table-scroll"><table class="order-table month-table"><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
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
      ['値入率', has(product.marginRate) ? marginLabel : '']
    ].filter((entry) => entry[1]);
    if (!details.length) return '';
    return `<details class="product-details"><summary>商品情報</summary><span>${details.map(([label, value]) => `${esc(label)} ${esc(value)}`).join('　')}</span></details>`;
  }

  function emptyState(title, description) { return `<div class="empty-state"><div><strong>${esc(title)}</strong><p>${esc(description)}</p></div></div>`; }
  function makeButton(label, handler, classes) { const button = document.createElement('button'); button.type = 'button'; button.className = classes; button.textContent = label; button.addEventListener('click', handler); return button; }
  function requestId() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`; }

  // ------------------------------------------------------------ 入力と保存
  function pendingInputs() { return [...document.querySelectorAll('[data-order-input]:not(:disabled)')].filter((el) => el.dataset.pending !== undefined); }
  function pendingChanges() {
    const inputs = pendingInputs(); if (!inputs.length || !state.data) return null;
    return { month: state.data.month?.month, changes: inputs.map((el) => ({ date: el.dataset.date, productId: el.dataset.product, storeId: el.dataset.store, quantity: el.dataset.pending === '' ? null : Number(el.dataset.pending) })) };
  }
  function applyChanges(changes) {
    let n = 0;
    (changes || []).forEach((c) => {
      const sel = `[data-order-input][data-date="${CSS.escape(String(c.date))}"][data-product="${CSS.escape(String(c.productId))}"][data-store="${CSS.escape(String(c.storeId))}"]`;
      const input = document.querySelector(sel); if (!input || input.disabled) return;
      input.value = c.quantity == null ? '' : String(c.quantity); input.dataset.pending = c.quantity == null ? '' : String(c.quantity); input.classList.add('is-pending'); n++;
    });
    updateSaveButton(); return n;
  }
  function clearPendingMarks() { document.querySelectorAll('[data-order-input]').forEach((el) => { delete el.dataset.pending; el.classList.remove('is-pending'); }); updateSaveButton(); }
  function updateSaveButton() {
    const n = pendingInputs().length;
    document.querySelectorAll('.save-orders').forEach((b) => { if (!b.disabled || b.dataset.saving !== '1') b.textContent = n ? `注文を保存（${n}）` : '注文を保存'; b.classList.toggle('has-pending', n > 0); });
  }
  function saveDraft() { const draft = pendingChanges(); if (!draft) return; try { store('session')?.setItem(DRAFT_KEY, JSON.stringify(Object.assign(draft, { at: Date.now() }))); } catch {} }
  function readDraft() { try { const d = JSON.parse(store('session')?.getItem(DRAFT_KEY) || 'null'); return d && Date.now() - d.at < 30 * 60000 ? d : null; } catch { return null; } }
  function restoreDraft() {
    const d = readDraft(); try { store('session')?.removeItem(DRAFT_KEY); } catch {}
    if (!d || !state.data || d.month !== state.data.month?.month) return;
    const n = applyChanges(d.changes); if (n) toast(`保存していない入力を ${n} 件戻しました。「注文を保存」を押してください。`);
  }

  function onOrderInput(event) {
    const input = event.currentTarget; const value = input.value === '' ? null : Number(input.value);
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 99999)) { input.value = ''; toast('数量は0以上の整数で入れてください。', true); return; }
    input.dataset.pending = value === null ? '' : String(value); input.classList.add('is-pending'); updateSaveButton();
  }

  async function saveVisibleOrders() {
    const draft = pendingChanges();
    if (!draft) { toast('保存する変更はありません。'); return; }
    const buttons = [...document.querySelectorAll('.save-orders')];
    buttons.forEach((b) => { b.disabled = true; b.dataset.saving = '1'; b.textContent = '保存中…'; });
    try {
      const result = await api('saveOrderBatch', { month: draft.month, changes: draft.changes, requestId: requestId() });
      clearPendingMarks();
      await refreshWorkspace(draft.month);
      toast(result?.message || '注文を保存しました。');
    } catch (e) {
      if (e.code === 'SESSION') showLoginPanel(e.message, 'info'); else toast(e.message, true);
    } finally { buttons.forEach((b) => { b.disabled = false; delete b.dataset.saving; }); updateSaveButton(); }
  }

  function bindCapInputs(host) { host.querySelectorAll('[data-cap-input]').forEach((input) => input.addEventListener('change', onCapInput)); }
  async function onCapInput(event) {
    const input = event.currentTarget; const value = input.value === '' ? null : Number(input.value);
    if (value !== null && (!Number.isInteger(value) || value < 0)) { toast('上限は0以上の整数で入れてください。', true); return; }
    input.disabled = true;
    try { await api('setProductCap', { month: state.data.month?.month, productId: input.dataset.product, cap: value, requestId: requestId() }); await refreshWorkspace(state.data.month?.month); toast('上限を保存しました。'); }
    catch (e) { toast(e.message, true); input.disabled = false; }
  }

  // ------------------------------------------------------------ BY の画面
  function openSettings() {
    const c = state.data?.month || {};
    const localDeadline = c.deadline ? new Date(new Date(c.deadline).getTime() - new Date(c.deadline).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
    showModal('月度設定', `<label>対象月<input name="month" type="month" value="${esc(c.month || '')}" required></label><label>受注締切の日時<input name="deadline" type="datetime-local" value="${esc(localDeadline)}"></label><p class="form-note">締切を後ろへ延ばすと、確定が外れて店舗がまた入れられます。空にすると「締切未設定」になり、店舗は入れられません。</p><label class="check-line"><input name="capEnabled" type="checkbox" ${c.capEnabled ? 'checked' : ''}> 月間上限を有効にする</label><label class="check-line"><input name="warehouseCanEditCaps" type="checkbox" ${c.warehouseCanEditCaps ? 'checked' : ''}> 倉庫に上限設定を許可する</label>`, async (form) => {
      const month = form.elements.month.value; if (!month) throw new Error('対象月を入れてください。');
      const deadline = form.elements.deadline.value ? new Date(form.elements.deadline.value).toISOString() : '';
      await api('saveMonthConfig', { month, deadline, capEnabled: form.elements.capEnabled.checked, warehouseCanEditCaps: form.elements.warehouseCanEditCaps.checked, requestId: requestId() });
      await refreshWorkspace(month); toast('月度設定を保存しました。');
    });
  }

  function openProductManager() {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop"><section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-heading"><h2 id="modal-title">商品マスター・${esc(state.data?.month?.label || '対象月')}の商品</h2><button type="button" class="modal-close" aria-label="閉じる">×</button></div><div class="product-manager"><div class="product-manager-actions"><input class="product-manager-search" type="search" placeholder="商品名・読み・メーカー・JAN（ひらがな・ローマ字でも）" aria-label="商品マスターを探す"><button type="button" class="button button-primary product-add">商品を追加</button></div><div class="product-manager-list"></div></div></section></div>`;
    const close = () => root.replaceChildren();
    root.querySelector('.modal-close').addEventListener('click', close);
    root.querySelector('.modal-backdrop').addEventListener('click', (e) => { if (e.target.classList.contains('modal-backdrop')) close(); });
    const search = root.querySelector('.product-manager-search'); const list = root.querySelector('.product-manager-list');
    const all = state.data?.productMaster || state.data?.products || [];
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
        edit.append(name, meta); edit.addEventListener('click', () => openProductEditor(product));
        const isIn = included.has(String(product.id));
        const toggle = makeButton(isIn ? '今月から除外' : '今月に追加', async () => {
          toggle.disabled = true;
          try { await api('setMonthProduct', { month: state.data.month?.month, productId: product.id, included: !isIn, requestId: requestId() }); await refreshWorkspace(state.data.month?.month); openProductManager(); }
          catch (error) { toast(error.message, true); toggle.disabled = false; }
        }, `button ${isIn ? 'button-secondary' : 'button-primary'} product-month-toggle`);
        row.append(edit, toggle); list.append(row);
      });
      if (!products.length) { const empty = document.createElement('p'); empty.className = 'guide-footnote'; empty.textContent = '当たる商品はありません。'; list.append(empty); }
    };
    root.querySelector('.product-add').addEventListener('click', () => openProductEditor());
    let timer = 0; search.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(draw, 150); }); draw();
  }

  async function openAuditLog() {
    const root = $('#modal-root');
    root.innerHTML = '<div class="modal-backdrop"><section class="modal-card audit-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-heading"><h2 id="modal-title">操作履歴</h2><button type="button" class="modal-close" aria-label="閉じる">×</button></div><div class="audit-list" aria-live="polite"><p class="guide-footnote">履歴を読み込んでいます…</p></div></section></div>';
    const close = () => root.replaceChildren();
    root.querySelector('.modal-close').addEventListener('click', close);
    root.querySelector('.modal-backdrop').addEventListener('click', (event) => { if (event.target.classList.contains('modal-backdrop')) close(); });
    try {
      const result = await api('getAuditLog', { limit: 30 });
      const list = root.querySelector('.audit-list'); if (!list) return;
      const entries = result.entries || [];
      const actionNames = { startSession: 'ログイン', getWorkspace: '発注一覧を表示', getGuide: '利用ガイドを表示', saveOrderBatch: '注文を保存', setProductCap: '上限を変更', setWarehouseCapsAllowed: '倉庫の上限編集を設定', saveProduct: '商品を保存', setMonthProduct: '今月の商品を変更', saveMonthConfig: '月度設定を保存', confirmMonth: '締切後に確定', endSession: 'ログアウト', getAuditLog: '操作履歴を表示', unknown: '一覧に無い操作' };
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

  function openProductEditor(existing = {}) {
    const aliases = Array.isArray(existing.aliases) ? existing.aliases.join('、') : '';
    const v = (x) => esc(x === undefined || x === null ? '' : x);
    const fields = `<input name="productId" type="hidden" value="${v(existing.id)}"><label>メーカー<input name="manufacturer" maxlength="120" value="${v(existing.manufacturer)}"></label><label>商品名<input name="name" maxlength="120" required value="${v(existing.name)}"></label><label>規格<input name="specification" maxlength="120" value="${v(existing.specification)}"></label><label>JAN<input name="jan" inputmode="numeric" maxlength="32" value="${v(existing.jan)}"></label><label>入数<input name="packSize" type="number" min="0" step="1" value="${v(existing.packSize)}"></label><label>検索用の読み・別名<input name="aliases" placeholder="例：ぶたばら、豚三枚肉" value="${esc(aliases)}"></label><div class="form-grid"><label>原価（本体）<input name="costNet" type="number" min="0" step="0.01" value="${v(existing.costNet)}"></label><label>原価（税込）<input name="costGross" type="number" min="0" step="0.01" value="${v(existing.costGross)}"></label><label>売価（本体）<input name="priceNet" type="number" min="0" step="0.01" value="${v(existing.priceNet)}"></label><label>売価（税込）<input name="priceGross" type="number" min="0" step="0.01" value="${v(existing.priceGross)}"></label><label>値入率<input name="marginRate" type="number" min="0" step="0.01" value="${v(existing.marginRate)}"></label></div>`;
    showModal(existing.id ? '商品を直す' : '商品を追加', fields, async (form) => {
      const product = Object.fromEntries(['manufacturer', 'name', 'specification', 'jan', 'packSize', 'costNet', 'costGross', 'priceNet', 'priceGross', 'marginRate'].map((key) => [key, form.elements[key].value]));
      if (form.elements.productId.value) product.productId = form.elements.productId.value;
      product.aliases = form.elements.aliases.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
      await api('saveProduct', { product, month: state.data.month?.month, requestId: requestId() }); await refreshWorkspace(state.data.month?.month); toast('商品を保存しました。');
    });
  }

  function showModal(title, fields, onSave) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop"><section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-heading"><h2 id="modal-title">${esc(title)}</h2><button type="button" class="modal-close" aria-label="閉じる">×</button></div><form class="modal-form">${fields}<div class="modal-actions"><button type="button" class="button button-secondary modal-cancel">キャンセル</button><button type="submit" class="button button-primary">保存</button></div></form></section></div>`;
    const close = () => root.replaceChildren();
    root.querySelector('.modal-close').addEventListener('click', close); root.querySelector('.modal-cancel').addEventListener('click', close);
    root.querySelector('.modal-backdrop').addEventListener('click', (e) => { if (e.target.classList.contains('modal-backdrop')) close(); });
    root.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type="submit"]'); button.disabled = true; button.textContent = '保存中…';
      try { await onSave(form); close(); } catch (error) { toast(error.message, true); button.disabled = false; button.textContent = '保存'; }
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
  $('#month-select').addEventListener('change', () => {
    const next = $('#month-select').value;
    if (pendingInputs().length && !window.confirm('保存していない入力があります。月を切り替えると消えます。切り替えますか？')) { $('#month-select').value = state.data?.month?.month || ''; return; }
    clearPendingMarks(); refreshWorkspace(next).catch(() => {});
  });
  $('#print-button').addEventListener('click', () => window.print());
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
  window.addEventListener('beforeunload', (event) => { if (!state.leaving && pendingInputs().length) { event.preventDefault(); event.returnValue = ''; } });

  async function start() {
    noteServerVersion('');
    try { window.sessionStorage.removeItem('livestock-order-session-v1'); } catch {}
    const redirect = L ? L.consumeRedirect(window.__oauthRedirectHash, store('local') || { getItem: () => null, setItem() {}, removeItem() {} }, Date.now()) : null;
    window.__oauthRedirectHash = null;
    renderInAppWarning();
    if (!GAS_URL_OK) { setStatus('接続先の設定待ち', false); setLoginButton(false, 'ログインの準備中'); setLoginHelp('GASの導入の設定が終わると、ログインできます。'); return; }
    setStatus('接続を確かめています', false);
    try { const cfg = await api('bootstrap', {}, false); state.clientId = cfg.clientId || ''; }
    catch (error) { setStatus('接続できません', false); setLoginHelp(error.message); showNotice(error.message, 'error'); return; }
    if (!state.clientId) { setStatus('接続できません', false); setLoginHelp('ログインの設定が終わっていません（E-SETUP）。導入の担当へ連絡してください。'); return; }
    setLoginButton(true, 'Googleでログイン'); setStatus('ログインできます', true); setLoginHelp('会社のアカウント（本部・店舗）を選んでください。');
    preloadGisIfPopup(false);
    if (redirect && redirect.accessToken) { await finishLogin(redirect.accessToken); return; }
    if (redirect && redirect.error) showLoginHelpKind(redirect.error);
    state.session = readSession();
    if (state.session) {
      showProgress('前回のログインで開いています…');
      try { await refreshWorkspace(); } catch { /* 画面に出してある */ } finally { hideProgress(); }
    }
  }
  start().catch(() => {});
})();
