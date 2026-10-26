// Google のログイン画面から戻ったところなら、アドレスの # 以降（Google の札）を、ほかのスクリプトより先に取り出して、アドレスから消す。
// （スマレコ v83 の形。CSP で書き込みのスクリプトを許さないので、<head> の最初に読む別のファイルにしてある）
(function () {
  'use strict';
  // ほかのサイトの枠（iframe）の中では開かない（GitHub Pages では frame-ancestors を出せないため、ここで止める）
  try { if (window.top !== window.self) { document.documentElement.style.display = 'none'; window.top.location = window.self.location.href; return; } }
  catch (e) { document.documentElement.style.display = 'none'; return; }
  try {
    var h = location.hash || '';
    if (/(^#|&)(access_token|error)=/.test(h)) {
      window.__oauthRedirectHash = h;
      history.replaceState(null, '', location.pathname + location.search);
    }
  } catch (e) { /* 取り出せなければ、ふつうに開く */ }
})();
