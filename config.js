// 公開の設定（秘密は置かない）。
//   gasUrl: GAS をデプロイした後に、/exec で終わるアドレスを '' の間に入れる（いまは空＝「接続先の設定待ち」と出る）。
//   oauthRedirectUri: 同じタブで Google へ移って戻るときの戻り先。Google Cloud の「承認済みのリダイレクト URI」に、同じ文字（末尾の / まで）を登録する。
window.APP_CONFIG = Object.freeze({
  gasUrl: 'https://script.google.com/macros/s/AKfycbzrvJcJp-4lQfW25voEQOOodZvwYHFuC_25h7UnQJD86NkLDRo7aLJBEhBMbA6T0w/exec',
  oauthRedirectUri: 'https://acoop-ai.github.io/chikusan-release/'
});
