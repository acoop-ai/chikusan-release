(() => {
  'use strict';

  // GASの実行URLを導入時に設定する。認証情報・業務データ・アカウント表は置かない。
  const GAS_URL = window.APP_CONFIG?.gasUrl || 'SET_GAS_EXEC_URL';
  const SESSION_KEY = 'livestock-order-session-v1';
  const state = { clientId: '', session: '', data: null, view: 'week', search: '', worker: null, saving: new Set() };
  const $ = (selector) => document.querySelector(selector);
  const text = (node, value) => { if (node) node.textContent = value == null ? '' : String(value); };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const setStatus = (label, ready) => { text($('#status-label'), label); $('.live-dot')?.classList.toggle('is-ready', Boolean(ready)); };

  async function api(action, data = {}, authenticated = true) {
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(GAS_URL)) throw new Error('GASの接続先が未設定です。導入担当へ連絡してください。');
    const body = { action, data };
    if (authenticated) body.session = state.session;
    const response = await fetch(GAS_URL, { method: 'POST', mode: 'cors', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), cache: 'no-store' });
    if (!response.ok) throw new Error(`通信に失敗しました（${response.status}）。時間をおいて再度お試しください。`);
    let result;
    try { result = await response.json(); } catch { throw new Error('サーバーの応答を読み取れませんでした。接続先とデプロイ状態を確認してください。'); }
    if (!result || result.ok !== true) throw new Error(result?.message || '処理を完了できませんでした。');
    return result.data;
  }

  function showNotice(message, kind = 'info') {
    const box = $('#notice');
    box.hidden = false;
    box.className = `notice ${kind === 'error' ? 'notice-error' : 'notice-info'}`;
    const icon = box.querySelector('.notice-icon'); if (icon) text(icon, kind === 'error' ? '!' : 'i');
    const copy = box.querySelector('div');
    if (copy) { copy.replaceChildren(); const title = document.createElement('strong'); title.textContent = kind === 'error' ? '確認が必要です' : 'お知らせ'; const p = document.createElement('p'); p.textContent = message; copy.append(title, p); }
  }

  function toast(message, error = false) {
    const node = $('#toast'); text(node, message); node.classList.toggle('is-error', error); node.hidden = false;
    window.clearTimeout(toast.timer); toast.timer = window.setTimeout(() => { node.hidden = true; }, 4200);
  }

  function sessionFromStorage() { try { return sessionStorage.getItem(SESSION_KEY) || ''; } catch { return ''; } }
  function saveSession(value) { state.session = value; try { if (value) sessionStorage.setItem(SESSION_KEY, value); else sessionStorage.removeItem(SESSION_KEY); } catch {} }

  async function prepareLogin() {
    if (GAS_URL === 'SET_GAS_EXEC_URL') {
      setStatus('接続先の設定待ち', false);
      text($('#login-button'), 'ログイン利用準備中');
      $('#login-button').disabled = true;
      text($('#login-help'), 'GASの導入設定が完了するとログインできます。');
      return;
    }
    try {
      const config = await api('bootstrap', {}, false);
      if (!config.clientId) throw new Error('Googleログイン設定が未登録です。');
      state.clientId = config.clientId;
      const waitForGIS = (tries = 30) => {
        if (window.google?.accounts?.id) {
          google.accounts.id.initialize({ client_id: state.clientId, callback: onGoogleCredential, auto_select: false, cancel_on_tap_outside: true });
          $('#login-button').disabled = false; text($('#login-button'), 'Googleアカウントでログイン');
          text($('#login-help'), '会社指定のアカウントを選択してください。'); setStatus('ログインできます', true);
          return;
        }
        if (tries > 0) window.setTimeout(() => waitForGIS(tries - 1), 250);
        else throw new Error('Googleログイン部品を読み込めませんでした。通信環境を確認してください。');
      };
      waitForGIS();
      state.session = sessionFromStorage();
      if (state.session) await refreshWorkspace();
    } catch (error) {
      setStatus('接続できません', false); text($('#login-help'), error.message); showNotice(error.message, 'error');
    }
  }

  function onGoogleCredential(response) {
    if (!response?.credential) { toast('Google認証の応答が確認できませんでした。', true); return; }
    setStatus('アカウントを確認しています', false);
    $('#login-button').disabled = true; text($('#login-button'), '確認中…');
    api('startSession', { idToken: response.credential }, false)
      .then((data) => { saveSession(data.session); return refreshWorkspace(); })
      .catch((error) => { saveSession(''); showNotice(error.message, 'error'); toast(error.message, true); })
      .finally(() => { $('#login-button').disabled = false; text($('#login-button'), 'Googleアカウントでログイン'); });
  }

  async function refreshWorkspace(month) {
    try {
      const payload = await api('getWorkspace', { month: month || $('#month-select').value || '' });
      state.data = payload;
      $('#login-panel').hidden = true; $('#workspace').hidden = false; $('#period-control').hidden = false; $('#signout-button').hidden = false;
      text($('#account-label'), payload.principal?.label || payload.principal?.email || '認証済み');
      setStatus('接続中', true); $('#notice').hidden = true;
      renderWorkspace();
    } catch (error) {
      if (/セッション|認証|権限|登録/.test(error.message)) { saveSession(''); $('#workspace').hidden = true; $('#login-panel').hidden = false; }
      setStatus('情報を取得できません', false); showNotice(error.message, 'error');
      throw error;
    }
  }

  function renderWorkspace() {
    const data = state.data; if (!data) return;
    const months = Array.isArray(data.months) ? data.months : [];
    const select = $('#month-select'); const selected = data.month?.month || data.selectedMonth || '';
    select.replaceChildren();
    months.forEach((item) => { const opt = document.createElement('option'); opt.value = item.month; opt.textContent = item.label || item.month; opt.selected = item.month === selected; select.append(opt); });
    const config = data.month || {};
    $('#deadline-note').hidden = false;
    text($('#deadline-sidebar'), config.deadline ? `締切：${config.deadlineLabel || config.deadline}` : '締切日時は未設定です。BYへ確認してください。');
    renderSummary(data, config);
    renderRoleActions(data, config);
    renderWarehouseSetting(data, config);
    renderOrders(data, config);
  }

  function renderSummary(data, config) {
    const principal = data.principal || {};
    const cards = [
      ['利用区分', principal.roleLabel || principal.role || '確認済み'],
      ['受注締切', config.deadlineLabel || (config.deadline ? config.deadline : '未設定')],
      ['状態', config.statusLabel || (config.confirmed ? '確定' : '受付中')]
    ];
    $('#summary-strip').innerHTML = cards.map(([label, value]) => `<div class="summary-card"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');
  }

  function renderRoleActions(data, config) {
    const role = data.principal?.role;
    const host = $('#role-actions'); host.replaceChildren();
    if (role === 'BY') {
      host.append(makeButton('月度設定', () => openSettings(), 'button button-secondary'));
      host.append(makeButton('商品マスター', () => openProductManager(), 'button button-secondary'));
      host.append(makeButton('注文を保存', () => saveVisibleOrders(), 'button button-secondary'));
      host.append(makeButton('操作履歴', () => openAuditLog(), 'button button-secondary'));
    }
    if (role === 'STORE' && !config.confirmed) host.append(makeButton('注文を保存', () => saveVisibleOrders(), 'button button-primary'));
  }

  function renderWarehouseSetting(data, config) {
    const node = $('#warehouse-cap-control'); const role = data.principal?.role;
    const canSee = role === 'BY' || role === 'WAREHOUSE';
    node.hidden = !canSee || !config.capEnabled;
    if (node.hidden) return;
    const enabled = Boolean(config.warehouseCanEditCaps);
    node.innerHTML = `<div><strong>倉庫の上限編集 <a class="help-icon" href="guide.html#cap" title="上限と倉庫の編集権限について" aria-label="上限設定の説明を開く">?</a></strong></div><div>${role === 'BY' ? `<label><input type="checkbox" id="warehouse-cap-toggle" ${enabled ? 'checked' : ''}> 倉庫に上限設定を許可</label><button id="save-cap-permission" class="button button-secondary" type="button">設定を保存</button>` : `<strong>${enabled ? '上限を編集できます' : '閲覧のみ'}</strong>`}</div>`;
    $('#save-cap-permission')?.addEventListener('click', async () => {
      const button = $('#save-cap-permission'); button.disabled = true;
      try { await api('setWarehouseCapsAllowed', { month: config.month, allowed: $('#warehouse-cap-toggle').checked, requestId: requestId() }); await refreshWorkspace(config.month); toast('倉庫の上限編集設定を保存しました。'); }
      catch (e) { toast(e.message, true); } finally { button.disabled = false; }
    });
  }

  function renderOrders(data, config) {
    const host = $('#order-content');
    const products = filteredProducts(data.products || [], state.search);
    if (state.view === 'month') { host.innerHTML = renderMonthSummary(data, products); return; }
    const weeks = Array.isArray(data.weeks) ? data.weeks : [];
    if (!weeks.length) { host.innerHTML = emptyState('対象月の注文書はまだ用意されていません。', '畜産BYが商品と対象月を設定すると、週ごとの一覧が表示されます。'); return; }
    host.innerHTML = weeks.map((week) => renderWeek(week, data, products, config)).join('');
    host.querySelectorAll('[data-order-input]').forEach((input) => input.addEventListener('change', onOrderInput));
    host.querySelectorAll('[data-cap-input]').forEach((input) => input.addEventListener('change', onCapInput));
  }

  function renderWeek(week, data, products, config) {
    const stores = data.stores || []; const role = data.principal?.role; const ownStoreId = data.principal?.storeId;
    const isBY = role === 'BY'; const isStore = role === 'STORE'; const isWarehouse = role === 'WAREHOUSE';
    const columns = `<th>日付</th><th>メーカー</th><th>商品・規格・JAN</th>${stores.map((s) => `<th>${esc(s.name)}<small>ケース</small></th>`).join('')}<th>合計</th>`;
    const rows = (week.rows || []).filter((row) => products.some((p) => p.id === row.productId));
    const body = rows.map((row) => {
      const product = (data.products || []).find((p) => p.id === row.productId) || {};
      const orderCells = stores.map((store) => {
        const key = `${row.date}|${row.productId}|${store.id}`; const qty = row.quantities?.[store.id]; const own = String(store.id) === String(ownStoreId);
        const editable = row.inMonth !== false && (isBY || (isStore && own && !config.confirmed && !row.soldOut));
        const warehouseCapInput = isWarehouse && config.capEnabled && config.warehouseCanEditCaps;
        const cellValue = qty == null || qty === '' ? '' : qty;
        if (warehouseCapInput && store.id === '__CAP__') return '';
        return `<td class="store-cell ${own ? 'is-own' : ''} ${cellValue === '' ? 'is-empty' : ''}"><input aria-label="${esc(store.name)}のケース数" type="number" min="0" step="1" value="${esc(cellValue)}" data-order-input data-key="${esc(key)}" data-date="${esc(row.date)}" data-product="${esc(row.productId)}" data-store="${esc(store.id)}" ${editable ? '' : 'disabled'}></td>`;
      }).join('');
      const total = stores.reduce((sum, store) => sum + (Number(row.quantities?.[store.id]) || 0), 0);
      const soldOut = Boolean(row.soldOut);
      return `<tr class="${soldOut ? 'soldout-row' : ''} ${row.inMonth === false ? 'outside-month-row' : ''}"><td>${esc(row.dateLabel || row.date)}${soldOut ? '<br><span class="sold-out">SOLD OUT</span>' : ''}</td><td>${esc(product.manufacturer || '')}</td><td class="product-cell"><strong>${esc(product.name || row.productName || '')}</strong><small>${esc(product.specification || '')}　${esc(product.jan || '')}</small>${productDetailsMarkup(product)}${row.remaining != null && !soldOut ? `<small class="cap-hint">あと ${esc(row.remaining)} ケース注文できます</small>` : ''}</td>${orderCells}<td class="total-cell">${total || '—'}</td></tr>`;
    }).join('');
    const first = week.startLabel || week.label || ''; const last = week.endLabel || '';
    return `<section class="week-card"><div class="week-heading"><h3>${esc(week.label || '週')}</h3><span>${esc(first)}${last ? ` ～ ${esc(last)}` : ''}</span></div><div class="table-scroll"><table class="order-table"><thead><tr>${columns}</tr></thead><tbody>${body || `<tr><td colspan="${stores.length + 4}">該当する商品がありません。</td></tr>`}</tbody></table></div></section>`;
  }

  function renderMonthSummary(data, products) {
    const stores = data.stores || []; const totals = data.monthTotals || {};
    if (!products.length) return emptyState('月間合計はありません。', '対象月と商品が設定されると、商品・店舗別の合計が表示されます。');
    const role = data.principal?.role; const config = data.month || {};
    const canEditCaps = Boolean(config.capEnabled && (role === 'BY' || (role === 'WAREHOUSE' && config.warehouseCanEditCaps)));
    const rows = products.map((p) => {
      const total = stores.reduce((sum, s) => sum + (Number(totals[p.id]?.[s.id]) || 0), 0);
      const cap = data.caps?.[p.id]; const remaining = cap == null ? '' : Math.max(0, Number(cap) - total);
      const capCell = canEditCaps ? `<input class="cap-input" data-cap-input data-product="${esc(p.id)}" type="number" min="0" step="1" value="${cap == null ? '' : esc(cap)}" aria-label="${esc(p.name)}の月間上限">` : (cap == null ? '—' : esc(cap));
      return `<tr><td>${esc(p.manufacturer || '')}</td><td class="product-cell"><strong>${esc(p.name)}</strong><small>${esc(p.specification || '')}　${esc(p.jan || '')}</small>${productDetailsMarkup(p)}</td>${stores.map((s) => `<td class="total-cell">${Number(totals[p.id]?.[s.id]) || '—'}</td>`).join('')}<td class="total-cell">${total || '—'}</td><td>${capCell}</td><td>${cap == null ? '—' : esc(remaining)}</td></tr>`;
    }).join('');
    const heads = `<th>メーカー</th><th>商品・規格・JAN</th>${stores.map((s) => `<th>${esc(s.name)}<small>ケース</small></th>`).join('')}<th>月計</th><th>上限</th><th>残数</th>`;
    return `<section class="week-card"><div class="week-heading"><h3>${esc(data.month?.label || '月間合計')}</h3><span>${canEditCaps ? '上限欄を変更すると保存されます' : '商品・店舗別'}</span></div><div class="table-scroll"><table class="order-table month-table"><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  function productDetailsMarkup(product) {
    const margin = Number(product.marginRate);
    const marginLabel = Number.isFinite(margin) ? `${Math.round((Math.abs(margin) <= 1 ? margin * 100 : margin) * 10) / 10}%` : '';
    const details = [
      ['入数', product.packSize ? `${product.packSize}個／ケース` : ''],
      ['原価', product.costNet !== '' && product.costNet != null ? `${product.costNet}円（本体）` : ''],
      ['原価税込', product.costGross !== '' && product.costGross != null ? `${product.costGross}円` : ''],
      ['売価', product.priceNet !== '' && product.priceNet != null ? `${product.priceNet}円（本体）` : ''],
      ['売価税込', product.priceGross !== '' && product.priceGross != null ? `${product.priceGross}円` : ''],
      ['値入率', product.marginRate !== '' && product.marginRate != null ? marginLabel : '']
    ].filter((entry) => entry[1]);
    if (!details.length) return '';
    return `<details class="product-details"><summary>商品情報</summary><span>${details.map(([label, value]) => `${esc(label)} ${esc(value)}`).join('　')}</span></details>`;
  }

  function filteredProducts(products, query) {
    if (!query.trim()) return products;
    const candidates = new Set((state.searchMatches || []).map(String));
    return products.filter((p) => candidates.has(String(p.id)));
  }

  function emptyState(title, description) { return `<div class="empty-state"><div><strong>${esc(title)}</strong><p>${esc(description)}</p></div></div>`; }
  function makeButton(label, handler, classes) { const button = document.createElement('button'); button.type = 'button'; button.className = classes; button.textContent = label; button.addEventListener('click', handler); return button; }
  function requestId() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

  async function onOrderInput(event) {
    const input = event.currentTarget; const value = input.value === '' ? null : Number(input.value);
    if (value !== null && (!Number.isInteger(value) || value < 0)) { input.value = ''; toast('数量は0以上の整数で入力してください。', true); return; }
    input.dataset.pending = value === null ? '' : String(value);
  }

  async function saveVisibleOrders() {
    const inputs = [...document.querySelectorAll('[data-order-input]:not(:disabled)')].filter((el) => el.dataset.pending !== undefined);
    if (!inputs.length) { toast('保存する変更はありません。'); return; }
    const changes = inputs.map((el) => ({ date: el.dataset.date, productId: el.dataset.product, storeId: el.dataset.store, quantity: el.dataset.pending === '' ? null : Number(el.dataset.pending) }));
    const button = [...document.querySelectorAll('#role-actions button')].find((b) => b.textContent === '注文を保存');
    if (button) { button.disabled = true; button.textContent = '保存中…'; }
    try { const result = await api('saveOrderBatch', { month: state.data.month?.month, changes, requestId: requestId() }); await refreshWorkspace(state.data.month?.month); toast(result?.message || '注文を保存しました。'); }
    catch (e) { toast(e.message, true); }
    finally { if (button) { button.disabled = false; button.textContent = '注文を保存'; } }
  }

  async function onCapInput(event) {
    const input = event.currentTarget; const value = input.value === '' ? null : Number(input.value);
    if (value !== null && (!Number.isInteger(value) || value < 0)) { toast('上限は0以上の整数で入力してください。', true); return; }
    try { await api('setProductCap', { month: state.data.month?.month, productId: input.dataset.product, cap: value, requestId: requestId() }); await refreshWorkspace(state.data.month?.month); toast('上限を保存しました。'); }
    catch (e) { toast(e.message, true); }
  }

  function openSettings() {
    const c = state.data?.month || {}; const localDeadline = c.deadline ? new Date(new Date(c.deadline).getTime() - new Date(c.deadline).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
    showModal('月度設定', `<label>対象月<input name="month" type="month" value="${esc(c.month || '')}" required></label><label>受注締切日時<input name="deadline" type="datetime-local" value="${esc(localDeadline)}"></label><label class="check-line"><input name="capEnabled" type="checkbox" ${c.capEnabled ? 'checked' : ''}> 月間上限を有効にする</label><label class="check-line"><input name="warehouseCanEditCaps" type="checkbox" ${c.warehouseCanEditCaps ? 'checked' : ''}> 倉庫に上限設定を許可する</label>`, async (form) => {
      const month = form.elements.month.value; if (!month) throw new Error('対象月を入力してください。');
      const deadline = form.elements.deadline.value ? new Date(form.elements.deadline.value).toISOString() : '';
      await api('saveMonthConfig', { month, deadline, capEnabled: form.elements.capEnabled.checked, warehouseCanEditCaps: form.elements.warehouseCanEditCaps.checked, requestId: requestId() });
      await refreshWorkspace(month); toast('月度設定を保存しました。');
    });
  }

  function openProductManager() {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop"><section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-heading"><h2 id="modal-title">商品マスター・${esc(state.data?.month?.label || '対象月')}の商品</h2><button type="button" class="modal-close" aria-label="閉じる">×</button></div><div class="product-manager"><div class="product-manager-actions"><input class="product-manager-search" type="search" placeholder="商品名・読み・メーカー・JAN" aria-label="商品マスターを検索"><button type="button" class="button button-primary product-add">商品を追加</button></div><div class="product-manager-list"></div></div></section></div>`;
    const close = () => root.replaceChildren(); root.querySelector('.modal-close').addEventListener('click', close); root.querySelector('.modal-backdrop').addEventListener('click', (e) => { if (e.target.classList.contains('modal-backdrop')) close(); });
    const search = root.querySelector('.product-manager-search'); const list = root.querySelector('.product-manager-list');
    const draw = () => {
      const q = normalize(search.value); const products = (state.data?.productMaster || state.data?.products || []).filter((p) => normalize([p.name, p.manufacturer, p.specification, p.jan, ...(p.aliases || [])].join(' ')).includes(q));
      list.replaceChildren();
      products.slice(0, 150).forEach((product) => {
        const row = document.createElement('div'); row.className = 'product-manager-row';
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'product-manager-item';
        const name = document.createElement('strong'); name.textContent = product.name || '';
        const meta = document.createElement('small'); meta.textContent = [product.manufacturer, product.specification, product.jan].filter(Boolean).join('　');
        edit.append(name, meta); edit.addEventListener('click', () => openProductEditor(product));
        const included = new Set((state.data?.monthProductIds || []).map(String)).has(String(product.id));
        const toggle = makeButton(included ? '今月から除外' : '今月に追加', async () => {
          toggle.disabled = true;
          try { await api('setMonthProduct', { month: state.data.month?.month, productId: product.id, included: !included, requestId: requestId() }); await refreshWorkspace(state.data.month?.month); draw(); }
          catch (error) { toast(error.message, true); toggle.disabled = false; }
        }, 'button button-secondary product-month-toggle');
        row.append(edit, toggle); list.append(row);
      });
      if (!products.length) { const empty = document.createElement('p'); empty.className = 'guide-footnote'; empty.textContent = '該当する商品はありません。'; list.append(empty); }
    };
    root.querySelector('.product-add').addEventListener('click', () => openProductEditor());
    search.addEventListener('input', draw); draw();
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
      const actionNames = { startSession: 'ログイン', getWorkspace: '発注一覧を表示', saveOrderBatch: '注文を保存', setProductCap: '上限を変更', setWarehouseCapsAllowed: '倉庫の上限編集を設定', saveProduct: '商品を保存', saveMonthConfig: '月度設定を保存', confirmMonth: '締切後に確定', endSession: 'ログアウト', getAuditLog: '操作履歴を表示' };
      const roleNames = { BY: '本部', STORE: '店舗', WAREHOUSE: '倉庫', SYSTEM: '自動処理' };
      list.innerHTML = entries.length ? entries.map((entry) => {
        const time = entry.at ? new Date(entry.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '';
        const before = entry.beforeJson ? esc(entry.beforeJson) : '変更前の記録なし';
        const after = entry.afterJson ? esc(entry.afterJson) : '変更後の記録なし';
        const denied = String(entry.result || '').indexOf('DENY') === 0;
        const actionName = actionNames[entry.action] || entry.action || '操作';
        const resultName = denied ? '拒否' : (entry.result === 'ALLOW' ? '完了' : entry.result || '記録');
        return `<article class="audit-item"><div class="audit-line"><strong>${esc(actionName)}</strong><time>${esc(time)}</time><span class="audit-result ${denied ? 'is-denied' : ''}">${esc(resultName)}</span></div><p>${esc(entry.email || '未認証')}　·　${esc(roleNames[entry.role] || entry.role || '')}　·　${esc(entry.target || '—')}</p><details><summary>変更内容・結果</summary><div class="audit-diff"><div><b>変更前</b><code>${before}</code></div><div><b>変更後・結果</b><code>${after}</code></div></div></details></article>`;
      }).join('') : '<p class="guide-footnote">操作履歴はまだありません。</p>';
    } catch (error) {
      const list = root.querySelector('.audit-list'); if (list) list.innerHTML = `<p class="guide-footnote">${esc(error.message)}</p>`;
    }
  }

  function openProductEditor(existing = {}) {
    const aliases = Array.isArray(existing.aliases) ? existing.aliases.join('、') : '';
    const fields = `<input name="productId" type="hidden" value="${esc(existing.id || '')}"><label>メーカー<input name="manufacturer" maxlength="120" value="${esc(existing.manufacturer || '')}"></label><label>商品名<input name="name" maxlength="120" required value="${esc(existing.name || '')}"></label><label>規格<input name="specification" maxlength="120" value="${esc(existing.specification || '')}"></label><label>JAN<input name="jan" inputmode="numeric" maxlength="32" value="${esc(existing.jan || '')}"></label><label>入数<input name="packSize" type="number" min="0" step="1" value="${esc(existing.packSize || '')}"></label><label>検索用の読み・別名<input name="aliases" placeholder="例：ひらがな、カタカナ、略称" value="${esc(aliases)}"></label><div class="form-grid"><label>原価（本体）<input name="costNet" type="number" min="0" step="0.01" value="${esc(existing.costNet || '')}"></label><label>原価（税込）<input name="costGross" type="number" min="0" step="0.01" value="${esc(existing.costGross || '')}"></label><label>売価（本体）<input name="priceNet" type="number" min="0" step="0.01" value="${esc(existing.priceNet || '')}"></label><label>売価（税込）<input name="priceGross" type="number" min="0" step="0.01" value="${esc(existing.priceGross || '')}"></label><label>値入率<input name="marginRate" type="number" step="0.01" value="${esc(existing.marginRate || '')}"></label></div>`;
    showModal(existing.id ? '商品を編集' : '商品を追加', fields, async (form) => {
      const product = Object.fromEntries(['manufacturer', 'name', 'specification', 'jan', 'packSize', 'costNet', 'costGross', 'priceNet', 'priceGross', 'marginRate'].map((key) => [key, form.elements[key].value]));
      product.productId = form.elements.productId.value || undefined;
      product.aliases = form.elements.aliases.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
      await api('saveProduct', { product, month: state.data.month?.month, requestId: requestId() }); await refreshWorkspace(state.data.month?.month); toast('商品を保存しました。');
    });
  }

  function showModal(title, fields, onSave) {
    const root = $('#modal-root'); root.innerHTML = `<div class="modal-backdrop"><section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-heading"><h2 id="modal-title">${esc(title)}</h2><button type="button" class="modal-close" aria-label="閉じる">×</button></div><form class="modal-form">${fields}<div class="modal-actions"><button type="button" class="button button-secondary modal-cancel">キャンセル</button><button type="submit" class="button button-primary">保存</button></div></form></section></div>`;
    const close = () => root.replaceChildren(); root.querySelector('.modal-close').addEventListener('click', close); root.querySelector('.modal-cancel').addEventListener('click', close);
    root.querySelector('.modal-backdrop').addEventListener('click', (e) => { if (e.target.classList.contains('modal-backdrop')) close(); });
    root.querySelector('form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type="submit"]'); button.disabled = true; button.textContent = '保存中…'; try { await onSave(form); close(); } catch (error) { toast(error.message, true); button.disabled = false; button.textContent = '保存'; } });
  }

  function setupWorker() {
    try { state.worker = new Worker('search-worker.js'); state.worker.onmessage = (event) => { if (event.data.query !== state.search) return; state.searchMatches = event.data.ids || []; renderOrders(state.data, state.data?.month || {}); renderSearchSuggestions(); }; }
    catch { state.worker = null; }
  }

  function renderSearchSuggestions() {
    const host = $('#search-suggestions'); const input = $('#product-search'); host.replaceChildren();
    if (!state.search || !state.data || !state.searchMatches?.length) { host.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }
    const matches = state.data.products.filter((p) => state.searchMatches.map(String).includes(String(p.id))).slice(0, 8);
    matches.forEach((product) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'suggestion-item';
      const title = document.createElement('strong'); title.textContent = product.name || '';
      const sub = document.createElement('small'); sub.textContent = [product.manufacturer, product.specification, product.jan].filter(Boolean).join('　');
      button.append(title, sub); button.addEventListener('click', () => { input.value = product.name || ''; state.search = input.value; state.searchMatches = [product.id]; renderOrders(state.data, state.data.month || {}); host.hidden = true; input.setAttribute('aria-expanded', 'false'); }); host.append(button);
    });
    host.hidden = matches.length === 0; input.setAttribute('aria-expanded', String(matches.length > 0));
  }

  $('#login-button').addEventListener('click', () => { if (window.google?.accounts?.id && state.clientId) google.accounts.id.prompt(); });
  $('#signout-button').addEventListener('click', () => { api('endSession', { requestId: requestId() }).catch(() => {}); saveSession(''); state.data = null; $('#workspace').hidden = true; $('#period-control').hidden = true; $('#login-panel').hidden = false; $('#notice').hidden = true; text($('#account-label'), '未ログイン'); setStatus('ログアウトしました', false); });
  $('#month-select').addEventListener('change', () => refreshWorkspace($('#month-select').value).catch(() => {}));
  $('#print-button').addEventListener('click', () => window.print());
  $('#product-search').addEventListener('input', (event) => {
    state.search = event.target.value.trim(); state.searchMatches = [];
    if (!state.search) { renderOrders(state.data, state.data?.month || {}); return; }
    if (state.worker) state.worker.postMessage({ query: state.search, products: state.data?.products || [] });
    else { state.searchMatches = simpleSearch(state.data?.products || [], state.search); renderOrders(state.data, state.data?.month || {}); renderSearchSuggestions(); }
  });
  document.addEventListener('click', (event) => { if (!event.target.closest('.search-area')) { $('#search-suggestions').hidden = true; $('#product-search').setAttribute('aria-expanded', 'false'); } });
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    state.view = button.dataset.view;
    document.querySelectorAll('[data-view]').forEach((b) => { b.classList.toggle('is-active', b === button); b.setAttribute('aria-selected', String(b === button)); });
    if (state.data) renderOrders(state.data, state.data.month || {});
  }));
  setupWorker(); prepareLogin().catch(() => {});

  function simpleSearch(products, query) {
    const q = normalize(query);
    return products.filter((p) => normalize([p.name, p.manufacturer, p.specification, p.jan, ...(p.aliases || [])].join(' ')).includes(q)).map((p) => p.id);
  }
  function normalize(value) { return String(value || '').normalize('NFKC').toLowerCase().replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/[\s　・･‐‑‒–—―ー_.,，。/\\-]+/g, ''); }
})();
