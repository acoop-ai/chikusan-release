// 商品マスターの登録用紙（xlsx）を読む・確かめる・照合する部品。外の部品は使わない（xlsx＝zip を DecompressionStream と DOMParser で読む）。
//   画面（app.js）と試験（tests/test_frontend.js）が使う。window.ProductSheet。
// 信頼境界: 用紙の中身は人が書いた文字。ここでは値として扱うだけ（画面に出すときは、app.js が textContent か esc() を通す）。
// GAS（Code.gs の productItem_・fillComputed_・matchKey_・saveProductsBatch_）が、同じ決まりで全部を確かめ直す（画面を信じない）。
//   決まり（税率・照合の鍵・JAN の直し方・欄の決まり fieldProblem・重なり）を変えるときは、両方を直す。試験が、両方で同じかを見る。
(function (root) {
  'use strict';
  const TAX_PERCENT = 8;                 // 税込（総額）＝本体 ×（100＋8）÷100 の端数切り捨て。GAS の TAX_PERCENT と同じ値（試験で確かめる）
  const MAX_ROWS = 300;                  // 1回に登録できる行
  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  const MAX_PART_BYTES = 20 * 1024 * 1024; // 中の1つのファイルを開いた大きさの上限（壊れた・細工した用紙で止まらないように）
  const SHEET_NAME = '入力';
  const NUMBER_MAX = 9999999;
  // 見出しの名前で列を探す（並びは決め打ちしない・「※必須」は外して比べる）。old＝0.2.3 までの11列の用紙だけにある列（読むだけ・いまの用紙には無い）
  const COLUMNS = [
    { key: 'manufacturer', label: 'メーカー', kind: 'text', names: ['メーカー', 'メーカー名'] },
    { key: 'name', label: '商品名', kind: 'text', names: ['商品名'] },
    { key: 'specification', label: '規格', kind: 'text', names: ['規格'] },
    { key: 'jan', label: 'JAN', kind: 'jan', names: ['JAN', 'JANコード'] },
    { key: 'packSize', label: '入数', kind: 'number', names: ['入数'] },
    { key: 'costNet', label: '原価（本体）', kind: 'number', names: ['原価（本体）', '原価'] },
    { key: 'costGross', label: '原価（総額）', kind: 'number', names: ['原価（総額）', '原価（税込）'], old: true },
    { key: 'priceNet', label: '売価（本体）', kind: 'number', names: ['売価（本体）', '売価'] },
    { key: 'priceGross', label: '売価（総額）', kind: 'number', names: ['売価（総額）', '売価（税込）'], old: true },
    { key: 'marginRate', label: '値入率', kind: 'number', names: ['値入率'], old: true },
    { key: 'aliases', label: '別名', kind: 'aliases', names: ['別名', '検索用の読み・別名', '読み・別名'], old: true },
    { key: 'leadDays', label: '締切（何日前）', kind: 'lead', names: ['締切（何日前）', '締切(何日前)', '締切', '何日前'] },
    { key: 'orderType', label: '発注区分', kind: 'type', names: ['発注区分', '区分'] }
  ];
  const TEMPLATE_KEYS = COLUMNS.filter((c) => !c.old).map((c) => c.key); // いまの登録用紙の9列（9つとも「※必須」・0.2.5 で発注区分を足した）
  const FILL_LATER = ['manufacturer', 'specification', 'jan', 'packSize', 'costNet', 'priceNet']; // 空でも登録できる6つ（あとで埋める・注文は止めない）。商品名・締切（何日前）は空なら登録できない
  const JAN_DIGITS = /^[0-9]{8,13}$/; // JAN の形（数字だけ・8〜13けた）。店内のコードも認めるときは、ここと GAS の JAN_DIGITS_ だけを直す
  const KEYS = COLUMNS.map((c) => c.key);
  const NUMBER_KEYS = COLUMNS.filter((c) => c.kind === 'number').map((c) => c.key);
  const LABEL = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label]));
  const MAX_LEAD = 30;
  const ORDER_TYPE_LABEL = { normal: '通常発注', aggregate: '集約発注' };
  /** 発注区分の書き方（GAS の orderTypeKey_ と同じ）。通常発注・通常・normal → 'normal'／集約発注・集約・aggregate → 'aggregate'／空 → ''／ほかは null（エラー） */
  function orderTypeKey(value) {
    const s = String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    if (s === '') return '';
    if (s === '通常発注' || s === '通常' || s === 'normal') return 'normal';
    if (s === '集約発注' || s === '集約' || s === 'aggregate') return 'aggregate';
    return null;
  }

  // ------------------------------------------------------------ 商品の欄の決まり（1か所。GAS の fieldProblem_・missingFields_ と同じ文・試験が同じかを見る）
  const emptyValue = (v) => v === '' || v == null || (typeof v === 'string' && v.trim() === '');
  /** 1つの欄の決まり。よければ ''。空: 商品名・締切（何日前）だけエラー。書いてあれば形を確かめる */
  function fieldProblem(key, value) {
    const label = LABEL[key] || key;
    if (emptyValue(value)) {
      if (key === 'name') return '商品名を入れてください（必ず書きます）。';
      if (key === 'leadDays') return '締切（何日前）を入れてください（必ず書きます・0〜' + MAX_LEAD + ' の整数）。';
      return '';
    }
    if (key === 'orderType') return orderTypeKey(value) === null ? '発注区分は「通常発注」か「集約発注」で入れてください。' : '';
    if (key === 'jan') return JAN_DIGITS.test(janKey(value)) ? '' : 'JAN は数字だけ・8〜13けたで入れてください（JAN の無い商品は空のままでよい）。';
    if (key === 'manufacturer' || key === 'name' || key === 'specification') return String(value).trim().length > 120 ? label + 'は120文字までです。' : '';
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (typeof value === 'boolean' || !Number.isFinite(n)) return label + 'は数で入れてください。';
    if (key === 'leadDays') return Number.isInteger(n) && n >= 0 && n <= MAX_LEAD ? '' : '締切（何日前）は 0〜' + MAX_LEAD + ' の整数で入れてください。';
    if (key === 'packSize') return Number.isInteger(n) && n >= 1 && n <= NUMBER_MAX ? '' : '入数は 1 以上の整数で入れてください。';
    if (key === 'marginRate') return n >= 0 && n <= NUMBER_MAX ? '' : '値入率は 0 以上の数で入れてください。';
    return n > 0 && n <= NUMBER_MAX ? '' : label + 'は 0 より大きい数で入れてください（9,999,999 まで）。';
  }
  /** 埋めていない項目（6つのうち空の欄）。注文は止めない。BY への知らせ */
  function missingFields(rec) { return FILL_LATER.filter((k) => emptyValue(rec ? rec[k] : '')); }
  function missingLabel(keys) { return (keys || []).map((k) => LABEL[k]).join('・'); }
  const SMALL_KANA = 'ぁぃぅぇぉっゃゅょゎゕゖ', LARGE_KANA = 'あいうえおつやゆよわかけ';
  const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

  // ------------------------------------------------------------ 計算（GAS と同じ）
  /** 税込（総額）＝本体 ×（100＋TAX_PERCENT）÷100 の端数切り捨て（70 → 75・99 → 106）。本体が空なら空 */
  function grossOf(net) {
    if (net === '' || net === null || net === undefined || !Number.isFinite(Number(net))) return '';
    return Math.floor(Math.round(Number(net) * 100) * (100 + TAX_PERCENT) / 10000);
  }
  /** 値入率＝（売価本体 − 原価本体）÷ 売価本体（小数4けた: 70・99 → 0.2929）。売価が空・0、原価が空、原価が売価より高いときは空 */
  function marginOf(cost, price) {
    if (cost === '' || price === '' || cost == null || price == null) return '';
    const c = Number(cost), p = Number(price);
    if (!Number.isFinite(c) || !Number.isFinite(p) || p <= 0 || c > p) return '';
    return Math.round((p - c) / p * 10000) / 10000;
  }
  /** その操作で書いた欄（空でない欄） */
  function givenKeys(item) {
    const given = {};
    KEYS.forEach((k) => { const v = item[k]; if (k === 'aliases' ? (Array.isArray(v) && v.length) : (v !== '' && v != null)) given[k] = true; });
    return given;
  }
  /** 本体を書いて総額が空なら総額を、原価・売価を書いて値入率が空なら値入率を入れる。入れた欄の名前を返す */
  function fillComputed(rec, given) {
    given = given || givenKeys(rec);
    const done = [];
    if (given.costNet && !given.costGross) { rec.costGross = grossOf(rec.costNet); done.push('costGross'); }
    if (given.priceNet && !given.priceGross) { rec.priceGross = grossOf(rec.priceNet); done.push('priceGross'); }
    if (!given.marginRate && (given.costNet || given.priceNet)) { const m = marginOf(rec.costNet, rec.priceNet); if (m !== '') { rec.marginRate = m; done.push('marginRate'); } }
    return done;
  }

  // ------------------------------------------------------------ 照合の鍵（GAS の janKey_・matchKey_ と同じ）
  function janKey(value) { return String(value == null ? '' : value).normalize('NFKC').replace(/[\s\-‐‑‒–—―−ー]/g, ''); }
  function matchKey(value) {
    return String(value == null ? '' : value).normalize('NFKC').toLowerCase()
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
      .replace(/[ぁぃぅぇぉっゃゅょゎゕゖ]/g, (c) => LARGE_KANA.charAt(SMALL_KANA.indexOf(c)))
      .replace(/[\s・()[\]{}【】「」『』〈〉《》〔〕、,]/g, '');
  }
  function nameSpecKey(name, spec) { return matchKey(name) + '\u001f' + matchKey(spec); }
  /** 見出しを比べる形（全角半角・空白・「※必須」を外す） */
  function headerKey(value) { return String(value == null ? '' : value).normalize('NFKC').replace(/※?必須|\(必須\)/g, '').replace(/\s+/g, '').toLowerCase(); }

  // ------------------------------------------------------------ xlsx を読む（zip → 「入力」のシート）
  function sheetError(message) { const e = new Error(message); e.userMessage = message; return e; }
  const NOT_XLSX = '用紙を xlsx として読めませんでした。ダウンロードした登録用紙に書いて、Excel の形（.xlsx）のまま保存してください。';

  function zipEntries(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length >= 8 && dv.getUint32(0, false) === 0xD0CF11E0) throw sheetError('この用紙は .xlsx の形ではありません（古い .xls か、パスワード付き）。Excel で「名前を付けて保存」→「Excel ブック（*.xlsx）」で保存し直してください。パスワードは外してください。');
    if (bytes.length < 22 || dv.getUint32(0, true) !== 0x04034b50) throw sheetError(NOT_XLSX);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw sheetError(NOT_XLSX);
    const count = dv.getUint16(eocd + 10, true), size = dv.getUint32(eocd + 12, true), offset = dv.getUint32(eocd + 16, true);
    if (offset + size > bytes.length) throw sheetError(NOT_XLSX);
    const out = new Map(); const dec = new TextDecoder('utf-8'); let p = offset;
    for (let n = 0; n < count; n++) {
      if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw sheetError(NOT_XLSX);
      const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen)).replace(/\\/g, '/').replace(/^\/+/, '');
      out.set(name.toLowerCase(), { name, flags, method, csize, usize, local });
      p += 46 + nlen + elen + clen;
    }
    return out;
  }

  async function entryBytes(bytes, entry) {
    if (entry.flags & 1) throw sheetError('パスワードの付いた用紙は読めません。パスワードを外して保存してください。');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const p = entry.local;
    if (p + 30 > bytes.length || dv.getUint32(p, true) !== 0x04034b50) throw sheetError(NOT_XLSX);
    const start = p + 30 + dv.getUint16(p + 26, true) + dv.getUint16(p + 28, true);
    if (start + entry.csize > bytes.length) throw sheetError(NOT_XLSX);
    const data = bytes.subarray(start, start + entry.csize);
    if (entry.method === 0) return data;
    if (entry.method !== 8) throw sheetError(NOT_XLSX);
    if (typeof DecompressionStream !== 'function') throw sheetError('このブラウザでは用紙を読めません。パソコンの Chrome か Edge で開いてください。');
    if (entry.usize > MAX_PART_BYTES) throw sheetError('用紙が大きすぎます。ダウンロードした登録用紙に、300行までで書いてください。');
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks = []; let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_PART_BYTES) { try { await reader.cancel(); } catch (_) { /* 止めた */ } throw sheetError('用紙が大きすぎます。ダウンロードした登録用紙に、300行までで書いてください。'); }
        chunks.push(value);
      }
    } catch (error) { if (error && error.userMessage) throw error; throw sheetError(NOT_XLSX); }
    const out = new Uint8Array(total); let at = 0;
    chunks.forEach((c) => { out.set(c, at); at += c.length; });
    return out;
  }

  async function entryText(bytes, entries, name) {
    const entry = entries.get(name.toLowerCase());
    if (!entry) return null;
    return new TextDecoder('utf-8').decode(await entryBytes(bytes, entry));
  }

  function defaultParseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw sheetError(NOT_XLSX);
    return doc;
  }
  const all = (node, local) => Array.from(node.getElementsByTagNameNS('*', local));
  const kids = (node, local) => Array.from(node.childNodes || []).filter((n) => n.nodeType === 1 && (!local || n.localName === local));
  const firstKid = (node, local) => kids(node, local)[0] || null;
  /** 文字の欄（si・is）: t と r の中の t をつなぐ。ふりがな（rPh）は読まない */
  function richText(node) {
    let s = '';
    kids(node).forEach((k) => {
      if (k.localName === 't') s += k.textContent;
      else if (k.localName === 'r') kids(k, 't').forEach((t) => { s += t.textContent; });
    });
    return s;
  }
  /** Excel の文字の中の _x000D_ の形（使えない字の書き方）を戻す */
  function unescapeOoxml(s) { return String(s).replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16))); }
  function colIndex(ref) { const m = /^([A-Za-z]+)/.exec(ref || ''); if (!m) return -1; let n = 0; for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
  function resolveTarget(target) {
    let t = String(target || '').replace(/\\/g, '/');
    t = t.startsWith('/') ? t.slice(1) : 'xl/' + t;
    const parts = [];
    t.split('/').forEach((seg) => { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); });
    return parts.join('/');
  }

  /**
   * xlsx の「入力」のシートを読む。返す値: { rows: Map(行の番号 → [欄…]) }。欄＝{ t: 's'（文字）| 'n'（数）| 'b' | 'e'（エラー）, v }
   *   opts.parseXml: XML を読む関数（既定は DOMParser。試験は代わりの部品を渡す）／opts.sheetName: 読むシートの名前（既定は「入力」）
   */
  async function readXlsx(buffer, opts) {
    opts = opts || {};
    const parseXml = opts.parseXml || defaultParseXml;
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.length > MAX_FILE_BYTES) throw sheetError('用紙が大きすぎます（5MB まで）。ダウンロードした登録用紙に、300行までで書いてください。');
    const entries = zipEntries(bytes);
    const wbText = await entryText(bytes, entries, 'xl/workbook.xml');
    const relText = await entryText(bytes, entries, 'xl/_rels/workbook.xml.rels');
    if (!wbText || !relText) throw sheetError(NOT_XLSX);
    const parse = (text) => { try { return parseXml(text); } catch (e) { throw (e && e.userMessage) ? e : sheetError(NOT_XLSX); } };
    const want = String(opts.sheetName || SHEET_NAME).normalize('NFKC').trim();
    const sheetEls = all(parse(wbText), 'sheet');
    const sheet = sheetEls.find((s) => String(s.getAttribute('name') || '').normalize('NFKC').trim() === want);
    if (!sheet) throw sheetError('「' + want + '」のシートが見つかりません。ダウンロードした登録用紙の1枚目「' + SHEET_NAME + '」に書いてください（シートの名前は変えないでください）。');
    const ridAttr = Array.from(sheet.attributes || []).find((a) => /(^|:)id$/.test(a.name) && a.name !== 'sheetId');
    const rel = all(parse(relText), 'Relationship').find((r) => r.getAttribute('Id') === (ridAttr && ridAttr.value));
    const sheetText = rel ? await entryText(bytes, entries, resolveTarget(rel.getAttribute('Target'))) : null;
    if (!sheetText) throw sheetError(NOT_XLSX);
    const sstText = await entryText(bytes, entries, 'xl/sharedStrings.xml');
    const shared = sstText ? all(parse(sstText), 'si').map((si) => unescapeOoxml(richText(si))) : [];
    const rows = new Map(); let lastRow = 0;
    all(parse(sheetText), 'row').forEach((rowEl) => {
      const rn = Number(rowEl.getAttribute('r')) || lastRow + 1; lastRow = rn;
      const cells = []; let lastCol = -1;
      kids(rowEl, 'c').forEach((c) => {
        const ref = c.getAttribute('r'); const ci = ref ? colIndex(ref) : lastCol + 1; lastCol = ci;
        if (ci < 0 || ci > 200) return;
        const t = c.getAttribute('t') || 'n'; const vEl = firstKid(c, 'v'); const v = vEl ? vEl.textContent : '';
        let cell = null;
        if (t === 's') { const s = shared[Number(v)]; cell = { t: 's', v: s == null ? '' : s }; }
        else if (t === 'inlineStr') { const is = firstKid(c, 'is'); cell = { t: 's', v: is ? unescapeOoxml(richText(is)) : '' }; }
        else if (t === 'str') cell = { t: 's', v: unescapeOoxml(v) };
        else if (t === 'b') cell = v === '' ? null : { t: 'b', v: v === '1' || v.toLowerCase() === 'true' };
        else if (t === 'e') cell = { t: 'e', v: v };
        else if (v !== '') cell = { t: 'n', v: Number(v) };
        if (cell) cells[ci] = cell;
      });
      if (cells.length) rows.set(rn, cells);
    });
    return { rows, sheetNames: sheetEls.map((s) => String(s.getAttribute('name') || '')) };
  }

  // ------------------------------------------------------------ 行を読む・確かめる（GAS の productItem_ と同じ決まり＋用紙だけの決まり）
  function cellString(cell) {
    if (!cell) return '';
    if (cell.t === 'n') return Number.isFinite(cell.v) ? String(cell.v) : '';
    if (cell.t === 'b') return cell.v ? 'TRUE' : 'FALSE';
    return String(cell.v == null ? '' : cell.v);
  }
  const isBlank = (cell) => !cell || (cell.t === 's' && String(cell.v).trim() === '');

  function readText(cell, col, errors) {
    if (cell && cell.t === 'e') { errors.push(col.label + 'がエラーの値（' + cell.v + '）です。'); return ''; }
    const s = cellString(cell).replace(/[\r\n\t]+/g, ' ').trim();
    if (CONTROL.test(s)) { errors.push(col.label + 'に、使えない文字があります。'); return ''; }
    if (s.length > 120) { errors.push(col.label + 'が長すぎます（120文字まで・いま ' + s.length + ' 文字）。'); return ''; }
    return s;
  }
  function readJan(cell, errors) {
    if (isBlank(cell)) return '';
    if (cell.t === 'e') { errors.push('JANがエラーの値（' + cell.v + '）です。'); return ''; }
    if (cell.t === 'n') {
      const n = cell.v;
      if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) { errors.push('JANは数字だけで入れてください。'); return ''; }
      const s = String(n);
      if (s.length !== 8 && s.length !== 13) { errors.push('JANが「数」として入っていて、' + s.length + 'けたです（先頭の0が消えたかもしれません）。JANの列を「文字列」の書式にして、打ち直してください。'); return ''; }
      return s;
    }
    const s = janKey(cellString(cell));
    const problem = fieldProblem('jan', s);
    if (problem) { errors.push(problem.replace(/。$/, '') + '（いま「' + cellString(cell).trim().slice(0, 20) + '」）。'); return ''; }
    return s;
  }
  function readNumber(cell, col, errors) {
    if (isBlank(cell)) return '';
    if (cell.t === 'e') { errors.push(col.label + 'がエラーの値（' + cell.v + '）です。'); return ''; }
    let n;
    if (cell.t === 'n') n = cell.v;
    else if (cell.t === 'b') n = NaN;
    else { const s = String(cell.v).normalize('NFKC').replace(/[\s,¥$円%]/g, ''); n = s === '' ? NaN : Number(s); }
    if (!Number.isFinite(n)) { errors.push(col.label + 'が数ではありません（「' + cellString(cell).trim().slice(0, 20) + '」）。'); return ''; }
    const problem = fieldProblem(col.key, n);
    if (problem) { errors.push(problem); return ''; }
    return n;
  }
  /** 締切（何日前）: 0〜30 の整数。「3日前」「3日」も読む。空なら ''（行のエラーにする＝必ず書く） */
  function readLead(cell, errors) {
    if (isBlank(cell)) return '';
    if (cell.t === 'e') { errors.push('締切（何日前）がエラーの値（' + cell.v + '）です。'); return ''; }
    const n = cell.t === 'n' ? cell.v : Number(String(cell.v).normalize('NFKC').replace(/\s|日前|日/g, ''));
    const problem = fieldProblem('leadDays', Number.isFinite(n) ? n : NaN);
    if (problem) { errors.push(problem.replace(/。$/, '') + '（いま「' + cellString(cell).trim().slice(0, 12) + '」）。'); return ''; }
    return n;
  }
  /** 発注区分: 「通常発注」「集約発注」（通常・集約も読む）。空なら ''（新しい商品は通常発注・すでにある商品はいまのまま） */
  function readType(cell, errors) {
    if (isBlank(cell)) return '';
    if (cell.t === 'e') { errors.push('発注区分がエラーの値（' + cell.v + '）です。'); return ''; }
    const key = orderTypeKey(cellString(cell));
    if (key === null) { errors.push(fieldProblem('orderType', cellString(cell)).replace(/。$/, '') + '（いま「' + cellString(cell).trim().slice(0, 12) + '」）。'); return ''; }
    return key;
  }
  function readAliases(cell, errors) {
    if (isBlank(cell)) return [];
    if (cell.t === 'e') { errors.push('別名がエラーの値（' + cell.v + '）です。'); return []; }
    const list = cellString(cell).split(/[、,，\r\n]/).map((s) => s.replace(/\t/g, ' ').trim()).filter(Boolean);
    if (list.length > 30) errors.push('別名は30個までです（いま ' + list.length + ' 個）。');
    list.forEach((a) => { if (a.length > 60) errors.push('別名「' + a.slice(0, 12) + '…」が長すぎます（1つ60文字まで）。'); if (CONTROL.test(a)) errors.push('別名に、使えない文字があります。'); });
    return list.slice(0, 30);
  }

  /** 読んだシートを、行ごとの商品にする。返す値: { items: [{ row, item, errors }], fileErrors: [], columns: [見つかった見出し] } */
  function parseSheet(sheet) {
    const rows = sheet && sheet.rows ? sheet.rows : new Map();
    const fileErrors = [];
    const numbers = Array.from(rows.keys()).sort((a, b) => a - b);
    // 見出しの行: 上から10行の中で「商品名」のある行（見出しは名前で探す・並びは決め打ちしない）
    const nameKeys = COLUMNS.find((c) => c.key === 'name').names.map(headerKey);
    const headerRow = numbers.slice(0, 10).find((rn) => (rows.get(rn) || []).some((c) => c && nameKeys.includes(headerKey(cellString(c)))));
    if (!headerRow) return { items: [], fileErrors: ['「入力」のシートに「商品名」の見出しが見つかりません。ダウンロードした登録用紙の1行目（見出し）は消さないでください。'], columns: [] };
    const map = {};
    (rows.get(headerRow) || []).forEach((cell, ci) => {
      if (!cell) return;
      const h = headerKey(cellString(cell)); if (!h) return;
      const col = COLUMNS.find((c) => c.names.map(headerKey).includes(h)); if (!col) return;
      if (map[col.key] !== undefined) fileErrors.push('見出し「' + col.label + '」が2つあります。1つにしてください。');
      else map[col.key] = ci;
    });
    const items = [];
    const noLeadCol = map.leadDays === undefined; // 締切の列の無い古い用紙（0.2.3 の11列）は、行ごとにエラー
    numbers.filter((rn) => rn > headerRow).forEach((rn) => {
      const cells = rows.get(rn) || [];
      if (COLUMNS.every((col) => map[col.key] === undefined || isBlank(cells[map[col.key]]))) return; // 空の行は読まない
      const errors = []; const item = {};
      COLUMNS.forEach((col) => {
        const cell = map[col.key] === undefined ? null : cells[map[col.key]];
        if (col.kind === 'text') item[col.key] = readText(cell, col, errors);
        else if (col.kind === 'jan') item[col.key] = readJan(cell, errors);
        else if (col.kind === 'number') item[col.key] = readNumber(cell, col, errors);
        else if (col.kind === 'lead') item[col.key] = readLead(cell, errors);
        else if (col.kind === 'type') item[col.key] = readType(cell, errors);
        else item[col.key] = readAliases(cell, errors);
      });
      if (!item.name && !errors.some((e) => e.startsWith('商品名'))) errors.unshift(fieldProblem('name', ''));
      if (item.leadDays === '' && !errors.some((e) => e.startsWith('締切'))) errors.push(noLeadCol ? '締切（何日前）が空です（前の用紙には、この列がありません。新しい登録用紙をダウンロードして書いてください）。' : fieldProblem('leadDays', ''));
      items.push({ row: rn, item, errors });
    });
    return { items, fileErrors, columns: COLUMNS.filter((c) => map[c.key] !== undefined).map((c) => c.label) };
  }

  // ------------------------------------------------------------ 照合して、確かめの表を作る（GAS の saveProductsBatch_ と同じ決まり）
  function sameValue(key, a, b) {
    const empty = (x) => x === '' || x == null;
    if (key === 'aliases') return JSON.stringify(a || []) === JSON.stringify(b || []);
    if (key === 'orderType') return (orderTypeKey(a) || 'normal') === (orderTypeKey(b) || 'normal'); // 空は通常発注（GAS と同じ）
    if (empty(a) || empty(b)) return empty(a) && empty(b);
    if (NUMBER_KEYS.includes(key)) return Number(a) === Number(b);
    return String(a) === String(b);
  }
  function blankProduct() { const p = {}; KEYS.forEach((k) => { p[k] = k === 'aliases' ? [] : ''; }); return p; }

  /**
   * 用紙（1つ以上）とマスターから、確かめの表を作る。
   *   files: [{ name, items, fileErrors }]・master: 画面に届いた商品マスター（使う商品だけ）
   *   返す値: { lines: [{ file, row, at, status: 'new'|'update'|'same'|'error', item, record, target, changes: [{ key, label, before, after, computed }], computed: [欄], errors, missing: [埋めていない欄] }], counts, incomplete, fileErrors, total }
   */
  function plan(files, master) {
    files = files || []; master = master || [];
    const many = files.length > 1;
    const fileErrors = [];
    const lines = [];
    files.forEach((f) => {
      (f.fileErrors || []).forEach((e) => fileErrors.push((many ? f.name + ': ' : '') + e));
      (f.items || []).forEach((x) => lines.push({ file: f.name, row: x.row, at: (many ? f.name + ' の ' : '') + x.row + '行目', item: x.item, errors: x.errors.slice(), status: 'error', changes: [], computed: [], target: null, record: null }));
    });
    const total = lines.length;
    if (total > MAX_ROWS) fileErrors.push('行が ' + total + ' 行あります。1回に登録できるのは ' + MAX_ROWS + ' 行までです。用紙を分けてください。');
    const ok = lines.filter((l) => !l.errors.length);
    ok.forEach((l) => { l.jan = l.item.jan; l.ns = nameSpecKey(l.item.name, l.item.specification); });
    // 用紙の中の重なり
    const byJanRow = new Map(), groups = new Map();
    ok.forEach((l) => { if (l.jan) (byJanRow.get(l.jan) || byJanRow.set(l.jan, []).get(l.jan)).push(l); (groups.get(l.ns) || groups.set(l.ns, []).get(l.ns)).push(l); });
    byJanRow.forEach((g) => { if (g.length > 1) g.forEach((l) => l.errors.push('同じJANが ' + g.filter((o) => o !== l).map((o) => o.at).join('・') + ' にもあります。1行にまとめてください。')); });
    groups.forEach((g) => { if (g.length > 1 && g.some((l) => !l.jan)) g.forEach((l) => l.errors.push('同じ商品名・規格が ' + g.filter((o) => o !== l).map((o) => o.at).join('・') + ' にもあります（JANの空の行は、どちらの商品か決められません）。')); });
    // マスターの索引（使う商品だけ）
    const mJan = new Map(), mNs = new Map();
    master.forEach((p) => { const j = janKey(p.jan); if (j) (mJan.get(j) || mJan.set(j, []).get(j)).push(p); const k = nameSpecKey(p.name, p.specification); (mNs.get(k) || mNs.set(k, []).get(k)).push(p); });
    const used = new Map();
    ok.filter((l) => !l.errors.length).forEach((l) => {
      let target = null;
      if (l.jan) {
        const same = mJan.get(l.jan) || [];
        if (same.length > 1) { l.errors.push('商品マスターに、同じJANの商品が2つあります。どちらを直すか決められません。「商品マスター」で確かめてください。'); return; }
        if (same.length) target = same[0];
        else {
          const noJan = (mNs.get(l.ns) || []).filter((p) => !janKey(p.jan));
          if (noJan.length > 1) { l.errors.push('商品マスターに、JANの無い同じ商品名・規格の商品が2つあります。どちらにJANを入れるか決められません。'); return; }
          if (noJan.length) target = noJan[0];
        }
      } else {
        const same = mNs.get(l.ns) || [];
        if (same.length > 1) { l.errors.push('商品マスターに、同じ商品名・規格の商品が2つあります。JANを書くと、どちらか決められます。'); return; }
        if (same.length) target = same[0];
      }
      if (target) {
        const other = used.get(String(target.id));
        if (other) { l.errors.push(other.at + ' と同じ商品を直そうとしています。どちらか1行にしてください。'); if (!other.errors.length) other.errors.push(l.at + ' と同じ商品を直そうとしています。どちらか1行にしてください。'); return; }
        used.set(String(target.id), l);
      }
      l.target = target;
    });
    // 新規・更新・変わらない
    lines.forEach((l) => {
      if (l.errors.length) { l.status = 'error'; l.target = null; return; }
      const given = givenKeys(l.item);
      if (!l.target) {
        const rec = Object.assign(blankProduct(), l.item);
        l.computed = fillComputed(rec, given); l.record = rec; l.status = 'new'; l.missing = missingFields(rec);
        if (!rec.orderType) { rec.orderType = 'normal'; l.notes = ['発注区分が空なので「通常発注」にします']; } // GAS も同じ（新しい商品の空は通常発注）
        return;
      }
      const before = l.target; const rec = {};
      KEYS.forEach((k) => { rec[k] = given[k] ? l.item[k] : (before[k] == null ? (k === 'aliases' ? [] : '') : before[k]); });
      l.computed = fillComputed(rec, given); l.record = rec;
      l.changes = KEYS.filter((k) => !sameValue(k, before[k], rec[k])).map((k) => ({ key: k, label: LABEL[k], before: before[k], after: rec[k], computed: l.computed.includes(k) }));
      l.status = l.changes.length ? 'update' : 'same'; l.missing = missingFields(rec);
    });
    const counts = { new: 0, update: 0, same: 0, error: 0 };
    lines.forEach((l) => { counts[l.status]++; if (!l.missing || l.status === 'error') l.missing = []; if (!l.notes || l.status === 'error') l.notes = []; });
    const incomplete = lines.filter((l) => l.missing.length).length; // 埋めていない項目のある行（黄色の注意・登録はできる）
    return { lines, counts, incomplete, fileErrors, total, canSave: !fileErrors.length && !counts.error && total > 0 && (counts.new + counts.update) > 0 };
  }

  /** GAS へ送る行（エラーの無いときだけ使う）。空の欄は ''（＝いまの値のまま） */
  function payload(result) {
    return result.lines.map((l) => { const out = { row: l.row }; KEYS.forEach((k) => { out[k] = l.item[k]; }); return out; });
  }

  // ------------------------------------------------------------ 手入力のたすけ
  /** 「商品を追加」で打った商品名・JAN に似た、マスターの商品（上から5件）。keyOf＝探す鍵（SearchNorm.key）・terms/hit＝SearchNorm */
  function similar(name, jan, master, sn, keyOf) {
    const out = []; const seen = new Set();
    const j = janKey(jan);
    if (j.length >= 8) (master || []).forEach((p) => { if (janKey(p.jan) === j && !seen.has(String(p.id))) { seen.add(String(p.id)); out.push({ product: p, why: 'jan' }); } });
    const q = String(name || '').trim();
    if (q) {
      const qk = matchKey(q);
      const terms = sn ? sn.terms(q) : null;
      const hits = (master || []).filter((p) => !seen.has(String(p.id)) && (terms ? (terms.length && sn.hit(keyOf ? keyOf(p) : sn.key([p.name, p.manufacturer, p.specification, p.jan].concat(p.aliases || []).filter(Boolean).join(' ')), terms)) : matchKey(p.name).includes(qk)));
      const rank = (p) => { const k = matchKey(p.name); return k === qk ? 0 : k.startsWith(qk) ? 1 : k.includes(qk) ? 2 : 3; };
      hits.map((p) => ({ p, r: rank(p) })).sort((a, b) => a.r - b.r || String(a.p.name).length - String(b.p.name).length).forEach((h) => out.push({ product: h.p, why: h.r === 0 ? 'same' : 'name' }));
    }
    return out.slice(0, 5);
  }
  /** 商品マスターの一覧が空のときの文（マスターが空／探して見つからない） */
  function managerEmptyText(total, searching) {
    if (!total) return 'まだ商品がありません。「商品を追加」か「登録用紙をアップロード」で登録してください。';
    return searching ? '当たる商品はありません。' : '';
  }

  root.ProductSheet = Object.freeze({ TAX_PERCENT, MAX_ROWS, MAX_FILE_BYTES, SHEET_NAME, COLUMNS, LABEL, TEMPLATE_KEYS, FILL_LATER, ORDER_TYPE_LABEL, orderTypeKey, fieldProblem, missingFields, missingLabel, grossOf, marginOf, givenKeys, fillComputed, janKey, matchKey, nameSpecKey, readXlsx, parseSheet, plan, payload, similar, managerEmptyText });
})(typeof window !== 'undefined' ? window : globalThis);
