// ログインの部品（スマレコ v83〜v88 の形）。画面の部品を持たない、決まりだけの関数（試験 tests/test_frontend.js で確かめる）。
//   - PC・スマホは、同じタブのまま Google へ移って戻る（リダイレクト）。窓（ポップアップ）の方式は、スマホで別のタブになり結果が届かないことがある
//   - アプリの中の画面（LINE の QR など）・ホーム画面に置いたアプリ・戻り先の登録が無い所（手元の確かめ）は、窓の方式
//   - PC で、保存していない入力があるときは窓の方式（同じタブで移ると読み直しになり、入力が消えるため）
//   信頼境界: userAgent は書き換えられる値。案内と方式の出し分けにだけ使い、だれかの判断には使わない（判断はサーバー）。
//            戻りのアドレスの # 以降は、だれでも作れる値。端末に置いた合言葉（state）と合うときだけ使う。
(function (root) {
  'use strict';
  var STATE_KEY = 'livestock-oauth-state-v1';
  var STATE_MAX_AGE_MS = 10 * 60 * 1000;

  function detectBrowser(ua, standalone) {
    ua = String(ua || '');
    var isAndroid = /Android/i.test(ua);
    var isIOS = /iPhone|iPad|iPod/i.test(ua);
    var app = '';
    if (/\bLine\//i.test(ua)) app = 'LINE';
    else if (/FBAN|FBAV|FB_IAB/i.test(ua)) app = 'Facebook';
    else if (/Instagram/i.test(ua)) app = 'Instagram';
    else if (/YJApp/i.test(ua)) app = 'Yahoo! JAPAN';
    else if (isAndroid && /; wv\)/.test(ua)) app = 'アプリ';
    else if (isIOS && !standalone && !/Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)) app = 'アプリ';
    return { inApp: Boolean(app), app: app, isAndroid: isAndroid, isIOS: isIOS, isMobile: isAndroid || isIOS, standalone: Boolean(standalone) };
  }

  function originOf(url) { try { return new URL(url).origin; } catch (e) { return ''; } }

  /** どちらの方式でログインするか（o: ua・standalone・redirectUri・origin・hasUnsaved） */
  function chooseMode(o) {
    var d = detectBrowser(o.ua, o.standalone);
    if (d.inApp) return { mode: 'popup', reason: 'inApp', browser: d };
    if (d.standalone) return { mode: 'popup', reason: 'standalone', browser: d };
    if (!o.redirectUri || originOf(o.redirectUri) !== o.origin) return { mode: 'popup', reason: 'noRedirect', browser: d };
    if (o.hasUnsaved && !d.isMobile) return { mode: 'popup', reason: 'unsavedPc', browser: d };
    return { mode: 'redirect', reason: d.isMobile ? 'mobile' : 'pc', browser: d };
  }

  function randomState(cryptoObj) {
    var a = new Uint8Array(16);
    cryptoObj.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  }

  function readPending(storage) {
    try {
      var v = JSON.parse(storage.getItem(STATE_KEY) || '[]');
      return Array.isArray(v) ? v.filter(function (x) { return x && typeof x.s === 'string' && typeof x.t === 'number'; }) : [];
    } catch (e) { return []; }
  }

  /** 移る前に合言葉を置く（10分・1回限り・別のタブの分も並べて最大5つ） */
  function rememberState(storage, state, now) {
    var pending = readPending(storage).filter(function (x) { return now - x.t < STATE_MAX_AGE_MS; }).slice(-4);
    pending.push({ s: state, t: now });
    storage.setItem(STATE_KEY, JSON.stringify(pending));
  }

  /** Google のログイン画面のアドレス（戻り先は設定の固定の値） */
  function buildRedirectUrl(clientId, redirectUri, state) {
    var params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'token',
      scope: 'openid email profile',
      include_granted_scopes: 'true',
      prompt: 'select_account', // 会社以外のアカウントが自動で選ばれ続けないよう、毎回選ばせる
      state: state
    });
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
  }

  /** 戻ってきたところなら、Google の札を取り出す。戻りでなければ null。合言葉が合わなければ使わない */
  function consumeRedirect(hash, storage, now) {
    if (!hash) return null;
    var p = new URLSearchParams(String(hash).replace(/^#/, ''));
    var pending = readPending(storage);
    var hit = null;
    pending.forEach(function (x) { if (!hit && x.s === p.get('state') && now - x.t < STATE_MAX_AGE_MS) hit = x; });
    try {
      var rest = pending.filter(function (x) { return x !== hit && now - x.t < STATE_MAX_AGE_MS; });
      if (rest.length) storage.setItem(STATE_KEY, JSON.stringify(rest)); else storage.removeItem(STATE_KEY);
    } catch (e) { /* 片付けられなくても、使った合言葉は二度と合わない（10分で切れる） */ }
    if (!hit) return { error: 'redirect_state' };
    if (p.get('error')) return { error: p.get('error') === 'access_denied' ? 'redirect_denied' : 'redirect_failed' };
    var token = p.get('access_token');
    if (!token) return { error: 'redirect_failed' };
    return { accessToken: token };
  }

  /** アプリの中の画面で開いたときの案内（出す文字は決まった文だけ） */
  function inAppAdvice(d) {
    if (!d || !d.inApp) return null;
    var where = d.app === 'アプリ' ? 'アプリの中の画面' : d.app + ' の中の画面';
    var browser = d.isIOS ? 'Safari' : 'Chrome';
    var action = d.app === 'LINE' ? 'line' : (d.isAndroid ? 'chrome' : 'copy');
    return { title: 'この画面ではログインできません', text: where + 'で開いています。Googleのログインは、' + browser + ' などのブラウザで開いたときだけ使えます。', action: action, browser: browser };
  }

  function chromeIntentUrl(url) {
    var m = /^(https?):\/\/([^#]*)/i.exec(url);
    if (!m) return url;
    return 'intent://' + m[2] + '#Intent;scheme=' + m[1].toLowerCase() + ';package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(url) + ';end';
  }

  root.LivestockLogin = { STATE_KEY: STATE_KEY, detectBrowser: detectBrowser, chooseMode: chooseMode, randomState: randomState, readPending: readPending, rememberState: rememberState, buildRedirectUrl: buildRedirectUrl, consumeRedirect: consumeRedirect, inAppAdvice: inAppAdvice, chromeIntentUrl: chromeIntentUrl };
})(typeof window !== 'undefined' ? window : globalThis);
