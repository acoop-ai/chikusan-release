// 注文の Excel（xlsx）を作る部品と、行ごとの「確定・未確定」の決まり。外の部品は使わない（zip は縮めない stored・CRC32 は自前）。window.OrderBook
//   画面（app.js の印刷と Excel でダウンロード）と試験が使う。中身は GAS の exportOrders が返した保存済みの値だけ（画面の入力途中の値は入れない）。
// 確定・未確定の決まり（0.2.5・PO 2026-10-29）。行＝着く日 D × 商品。月の締切は無い。上から順に決める（店は「受付中」のほかは直せない・BY と倉庫は直せる）:
//   ①締切（何日前）の無い商品＝「締切が未設定」
//   ②商品の締切（（D − N 日）の 12:00 日本時間）を過ぎた: 通常発注＝「確定（2日前 12:00 の締切）」／集約発注＝BY が確定していれば「確定（BY 確定 …）」・まだなら「未確定（BY の確定待ち）」
//   ③在庫数が未入力＝「在庫数の入力待ち」　④SOLD OUT（通常発注＝確定・集約発注＝BY の確定待ち）　⑤ほかは「M/D HH:MM まで直せる」
//   GAS の rowLock_ と同じ決まり（試験が同じかを見る）。日本時間は +9 時間で決める（夏時間なし）
(function (root) {
  'use strict';
  const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const WEEKDAY = '日月火水木金土';

  // ------------------------------------------------------------ 確定・未確定（画面・印刷・Excel で同じ）
  const LEAD_CUTOFF_HOUR = 12, MAX_LEAD_DAYS = 30, JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const p2 = (n) => String(n).padStart(2, '0');
  /** 締切（何日前）。0〜30 の整数でなければ null（締切が未設定） */
  function leadDaysOf(value) { const n = Number(value); return value === '' || value == null || typeof value === 'boolean' || !Number.isInteger(n) || n < 0 || n > MAX_LEAD_DAYS ? null : n; }
  /** 発注区分（GAS の orderTypeOf_ と同じ）: 集約発注だけ 'aggregate'・ほかは 'normal' */
  function orderTypeOf(value) { const s = String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, '').toLowerCase(); return s === 'aggregate' || s === '集約発注' || s === '集約' ? 'aggregate' : 'normal'; }
  const isAggregate = (product) => orderTypeOf(product && product.orderType) === 'aggregate';
  /** 商品の締切の時刻（ミリ秒）＝（D − N 日）の 12:00 日本時間 */
  function leadCutoffMs(date, leadDays) { const [y, m, d] = String(date).split('-').map(Number); return Date.UTC(y, m - 1, d - leadDays, LEAD_CUTOFF_HOUR, 0, 0) - JST_OFFSET_MS; }
  function jstLabel(ms) { const d = new Date(ms + JST_OFFSET_MS); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()); }
  /** 日本時間のいまの日付（yyyy-MM-dd）。画面の「今日」 */
  function jstToday(nowMs) { return new Date((nowMs == null ? Date.now() : nowMs) + JST_OFFSET_MS).toISOString().slice(0, 10); }
  const leadName = (n) => (n === 0 ? '当日' : n + '日前') + ' 12:00';
  const LOCKED = ['lead', 'aggwait', 'aggdone', 'nostock', 'soldout', 'aggsold', 'nolead'];
  /** 行に数（quantities）があって、どの店も 0 か空 */
  const noOrders = (row) => Boolean(row.quantities) && !Object.values(row.quantities).some((v) => Number(v) > 0);
  /**
   * 行の状態（GAS の rowLock_ と同じ決まり）。返す値:
   *   { code: 'nolead'|'lead'|'aggwait'|'aggdone'|'nostock'|'soldout'|'aggsold'|'open'|'', locked（店が直せない）, mark: '確定'|'未確定'|'未設定'|'', label: 印刷・Excel の言葉, until: 'M/D HH:MM', aggregate }
   *   row: { date, inMonth, soldOut, stockMissing, agg: { confirmed, at }, quantities }・product: その行の商品（leadDays・orderType）・nowMs: いまの時刻（省くと今）
   *   表示だけの決まり: 集約発注で締切の後、quantities があって注文が 0 の日は 'lead'（確定するものが無い）。BY・倉庫は全店の数、店は自店の数で見る。
   *   GAS の rowLock_ は数を見ないで 'aggwait' のまま（どちらも店は直せないので、受け付けの結果は同じ）
   */
  function rowStatus(row, product, nowMs) {
    if (!row || row.inMonth === false) return { code: '', locked: false, mark: '', label: '', until: '', aggregate: false };
    const now = nowMs == null ? Date.now() : nowMs;
    const n = leadDaysOf(product && product.leadDays); const agg = isAggregate(product);
    const at = row.agg && row.agg.at ? ' ' + row.agg.at : '';
    const out = (code, until) => {
      const label = code === 'lead' ? '確定（' + leadName(n) + ' の締切）' : code === 'aggdone' ? '確定（BY 確定' + at + '）' : code === 'aggwait' ? '未確定（BY の確定待ち）'
        : code === 'nostock' ? '在庫数の入力待ち（入れられません）' : code === 'soldout' ? '確定（SOLD OUT）' : code === 'aggsold' ? 'SOLD OUT（BY の確定待ち）'
          : code === 'nolead' ? '締切が未設定（入れられません）' : until + ' まで直せる';
      const mark = code === 'nolead' ? '未設定' : (code === 'lead' || code === 'aggdone' || code === 'soldout') ? '確定' : '未確定';
      return { code, locked: LOCKED.includes(code), mark, label, until, leadDays: n, aggregate: agg };
    };
    if (n === null) return out('nolead', '');
    const lead = leadCutoffMs(row.date, n); const until = jstLabel(lead);
    if (now >= lead) return out(!agg ? 'lead' : row.agg && row.agg.confirmed ? 'aggdone' : noOrders(row) ? 'lead' : 'aggwait', until); // 集約発注で注文の無い日は、BY が確定するものが無い＝締切で確定（店は直せないのは同じ）
    if (row.stockMissing) return out('nostock', until);
    if (row.soldOut) return out(agg ? 'aggsold' : 'soldout', until);
    return out('open', until);
  }
  const LEGEND = '印の見方: 確定＝締切を過ぎた（商品ごとの「着く日の何日前の 12:00」）・SOLD OUT の日・集約発注は BY が確定した分。店は直せません（BY・倉庫は直せます）／未確定＝表示の日時まで直せる・集約発注で BY の確定待ち・在庫数の入力待ち（網かけ）／未設定＝その商品の締切がまだ決まっていません／集約＝集約発注（紫の地）';

  // ------------------------------------------------------------ zip（縮めない stored）と CRC32
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function dosTime(d) { return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; }
  /** files: [{ name, text }] → zip の中身（Uint8Array）。縮めない（stored）ので、どの Excel でも開ける・部品が要らない */
  function zipStored(files, when) {
    const enc = new TextEncoder(); const t = dosTime(when || new Date());
    const parts = []; const central = []; let offset = 0;
    files.forEach((f) => {
      const name = enc.encode(f.name); const data = enc.encode(f.text); const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
      local.setUint16(10, t.time, true); local.setUint16(12, t.date, true); local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true);
      cd.setUint16(12, t.time, true); cd.setUint16(14, t.date, true); cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true); cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
      parts.push(new Uint8Array(local.buffer), name, data); central.push(new Uint8Array(cd.buffer), name);
      offset += 30 + name.length + data.length;
    });
    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0)); let at = 0;
    all.forEach((p) => { out.set(p, at); at += p.length; });
    return out;
  }

  // ------------------------------------------------------------ xlsx を書く
  const xml = (v) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const colName = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  // 集約発注の行は、薄い紫の地（textAgg・numAgg・janAgg・openAgg）。画面の .is-aggregate と同じ色の考え（色だけにせず「発注区分」の列に「集約発注」の文字）
  const STYLE = { plain: 0, title: 1, meta: 2, head: 3, text: 4, num: 5, jan: 6, total: 7, totalLabel: 8, open: 9, textAgg: 10, numAgg: 11, janAgg: 12, openAgg: 13 };
  const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="' + MAIN_NS + '">'
    + '<fonts count="3"><font><sz val="11"/><name val="Meiryo UI"/><family val="3"/><charset val="128"/></font><font><b/><sz val="11"/><name val="Meiryo UI"/><family val="3"/><charset val="128"/></font><font><b/><sz val="13"/><name val="Meiryo UI"/><family val="3"/><charset val="128"/></font></fonts>'
    + '<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF3ED"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="lightGray"><fgColor rgb="FFB0B0B0"/><bgColor rgb="FFFFFFFF"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF1EAFB"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="lightGray"><fgColor rgb="FFB0B0B0"/><bgColor rgb="FFF1EAFB"/></patternFill></fill></fills>'
    + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFC9D6CC"/></left><right style="thin"><color rgb="FFC9D6CC"/></right><top style="thin"><color rgb="FFC9D6CC"/></top><bottom style="thin"><color rgb="FFC9D6CC"/></bottom><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="14">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>'
    + '<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>'
    + '<xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>'
    + '<xf numFmtId="3" fontId="1" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>'
    + '<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>'
    + '<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>'
    + '<xf numFmtId="3" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/>'
    + '<xf numFmtId="49" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/>'
    + '<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>'
    + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  function cellXml(ref, cell) {
    if (cell == null || cell === '') return '';
    const c = typeof cell === 'object' ? cell : { v: cell };
    const s = STYLE[c.s || (typeof c.v === 'number' ? 'num' : 'text')] || 0;
    if (c.v === '' || c.v == null) return s ? '<c r="' + ref + '" s="' + s + '"/>' : '';
    if (typeof c.v === 'number' && Number.isFinite(c.v)) return '<c r="' + ref + '" s="' + s + '"><v>' + c.v + '</v></c>';
    return '<c r="' + ref + '" s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' + xml(c.v) + '</t></is></c>';
  }
  /** sheet: { name, rows: [[欄…]], widths: [], headerRow: 見出しの行の番号（1から）, freezeCols, filter } */
  function sheetXml(sheet, index) {
    const width = Math.max(1, ...sheet.rows.map((r) => r.length));
    const rowsXml = sheet.rows.map((row, ri) => '<row r="' + (ri + 1) + '">' + row.map((cell, ci) => cellXml(colName(ci) + (ri + 1), cell)).join('') + '</row>').join('');
    const h = sheet.headerRow || 0; const fc = sheet.freezeCols || 0;
    const pane = h ? '<pane' + (fc ? ' xSplit="' + fc + '"' : '') + ' ySplit="' + h + '" topLeftCell="' + colName(fc) + (h + 1) + '" activePane="' + (fc ? 'bottomRight' : 'bottomLeft') + '" state="frozen"/>' : '';
    const cols = '<cols>' + (sheet.widths || []).map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>';
    const last = colName(width - 1) + Math.max(1, sheet.rows.length);
    const filter = sheet.filter && h && sheet.rows.length > h ? '<autoFilter ref="A' + h + ':' + last + '"/>' : '';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="' + MAIN_NS + '" xmlns:r="' + REL_NS + '">'
      + '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:' + last + '"/>'
      + '<sheetViews><sheetView workbookViewId="0"' + (index === 0 ? ' tabSelected="1"' : '') + '>' + pane + '</sheetView></sheetViews>'
      + '<sheetFormatPr defaultRowHeight="15"/>' + cols + '<sheetData>' + rowsXml + '</sheetData>' + filter
      + '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>'
      + '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>';
  }
  /** Excel のシート名に使えない字（: \ / ? * [ ]）を外し、31字まで・同じ名前は番号を足す */
  function sheetName(raw, used) {
    let n = String(raw).replace(/[:\\/?*[\]]/g, '-').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'シート';
    let k = 2; const base = n;
    while (used.has(n)) n = base.slice(0, 28) + '(' + (k++) + ')';
    used.add(n); return n;
  }
  const quoteName = (n) => "'" + String(n).replace(/'/g, "''") + "'";
  /** sheets → xlsx の中身（Uint8Array） */
  function writeXlsx(sheets, when) {
    const files = [];
    files.push({ name: '[Content_Types].xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>' });
    files.push({ name: '_rels/.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' });
    const names = sheets.map((s) => s.name);
    const defined = sheets.map((s, i) => {
      if (!s.headerRow) return '';
      const width = Math.max(1, ...s.rows.map((r) => r.length));
      return '<definedName name="_xlnm.Print_Titles" localSheetId="' + i + '">' + xml(quoteName(s.name)) + '!$' + s.headerRow + ':$' + s.headerRow + '</definedName>'
        + (s.filter && s.rows.length > s.headerRow ? '<definedName name="_xlnm._FilterDatabase" localSheetId="' + i + '" hidden="1">' + xml(quoteName(s.name)) + '!$A$' + s.headerRow + ':$' + colName(width - 1) + '$' + s.rows.length + '</definedName>' : '');
    }).join('');
    files.push({ name: 'xl/workbook.xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="' + MAIN_NS + '" xmlns:r="' + REL_NS + '"><bookViews><workbookView activeTab="0"/></bookViews><sheets>' + names.map((n, i) => '<sheet name="' + xml(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets>' + (defined ? '<definedNames>' + defined + '</definedNames>' : '') + '</workbook>' });
    files.push({ name: 'xl/_rels/workbook.xml.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + names.map((n, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') + '<Relationship Id="rId' + (names.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' });
    files.push({ name: 'xl/styles.xml', text: STYLES_XML });
    sheets.forEach((s, i) => files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', text: sheetXml(s, i) }));
    return zipStored(files, when);
  }

  // ------------------------------------------------------------ 注文の帳面（週ごとのシート＋月間合計）
  const jst = (d) => new Date(d.getTime() + JST_OFFSET_MS); // 日本時間（画面の時計の地域に関わらず）
  const stamp = (d) => { const j = jst(d); return j.getUTCFullYear() + '/' + p2(j.getUTCMonth() + 1) + '/' + p2(j.getUTCDate()) + ' ' + p2(j.getUTCHours()) + ':' + p2(j.getUTCMinutes()); };
  function dayLabel(date) { const [y, m, d] = String(date).split('-').map(Number); const wd = new Date(y, m - 1, d).getDay(); return m + '/' + d + '（' + WEEKDAY.charAt(wd) + '）'; }
  const md = (date) => { const [, m, d] = String(date).split('-').map(Number); return m + '-' + d; };
  const storeLabel = (s) => s.short || s.name || s.id;
  const sum = (obj, stores) => stores.reduce((n, s) => n + (Number(obj && obj[s.id]) || 0), 0);

  /**
   * data＝GAS の exportOrders の返事（保存済みの値）・meta＝{ exportedAt: Date, who: '名前（役割）' }
   * 返す値: { bytes, fileName, sheetNames }
   *   0.2.5: 月の締切の行は無くした（確定は行ごと）。「発注区分」の列（通常発注／集約発注）・集約発注の行は薄い紫の地。月間合計は「在庫数」（空は「未入力」）
   */
  function build(data, meta) {
    meta = meta || {};
    const config = data.month || {}; const stores = data.stores || [];
    const products = new Map((data.products || []).map((p) => [String(p.id), p]));
    const when = meta.exportedAt instanceof Date && !isNaN(meta.exportedAt) ? meta.exportedAt : new Date();
    const top = (title) => [[{ v: title, s: 'title' }], [{ v: '確定は商品ごと（着く日の何日前の 12:00・SOLD OUT・集約発注は BY の確定）。月の締切はありません。', s: 'meta' }], [{ v: '出力: ' + stamp(when) + '　' + (meta.who || ''), s: 'meta' }], [{ v: '数はケース。空の欄は注文なし。' + LEGEND.replace('（網かけ）', '（網かけ・状態の列）'), s: 'meta' }]];
    const kind = (p) => (isAggregate(p) ? '集約発注' : '通常発注');
    const st = (base, p) => (isAggregate(p) ? base + 'Agg' : base); // 集約発注の行は紫の地
    const used = new Set(); const sheets = [];
    (data.weeks || []).forEach((w) => {
      const rows = (w.rows || []).filter((r) => r.inMonth !== false && products.has(String(r.productId)));
      if (!rows.length || !(w.rows || []).length) return;
      const first = w.rows[0].date, last = w.rows[w.rows.length - 1].date;
      const name = sheetName((w.label || '週') + ' ' + md(first) + '〜' + md(last), used);
      const head = ['日付', '状態', '発注区分', 'メーカー', '商品名', '規格', 'JAN', '入数'].concat(stores.map(storeLabel), ['合計']).map((v) => ({ v, s: 'head' }));
      const body = rows.map((r) => {
        const p = products.get(String(r.productId)); const status = rowStatus(r, p, when.getTime());
        const qty = stores.map((s) => { const v = r.quantities && r.quantities[s.id]; return v == null || v === '' || Number(v) === 0 ? { v: '', s: st('num', p) } : { v: Number(v), s: st('num', p) }; });
        const total = sum(r.quantities, stores);
        return [{ v: dayLabel(r.date), s: st('text', p) }, { v: status.label, s: status.mark === '確定' ? st('text', p) : st('open', p) }, { v: kind(p), s: st('text', p) }, { v: p.manufacturer || '', s: st('text', p) }, { v: p.name || '', s: st('text', p) }, { v: p.specification || '', s: st('text', p) }, { v: String(p.jan || ''), s: st('jan', p) }, { v: p.packSize === '' || p.packSize == null ? '' : Number(p.packSize), s: st('num', p) }].concat(qty, [{ v: total || '', s: st('num', p) }]);
      });
      const foot = [{ v: '週の合計', s: 'totalLabel' }].concat(Array(7).fill({ v: '', s: 'totalLabel' }), stores.map((s) => ({ v: rows.reduce((n, r) => n + (Number(r.quantities && r.quantities[s.id]) || 0), 0), s: 'total' })), [{ v: rows.reduce((n, r) => n + sum(r.quantities, stores), 0), s: 'total' }]);
      sheets.push({ name, headerRow: 5, freezeCols: 5, filter: true, widths: [11, 22, 10, 14, 28, 10, 15, 6].concat(stores.map((s) => Math.max(7, String(storeLabel(s)).length * 2 + 2)), [8]), rows: top('畜産 発注書　' + (config.label || '') + '　' + (w.label || '') + '（' + dayLabel(first) + '〜' + dayLabel(last) + '）').concat([head], body, [foot]) });
    });
    // 月間合計（在庫数が空＝未入力。店は注文できない）
    const head = ['発注区分', 'メーカー', '商品名', '規格', 'JAN', '入数'].concat(stores.map(storeLabel), ['月計'], ['在庫数', '残数', '不足']).map((v) => ({ v, s: 'head' }));
    const totals = data.monthTotals || {}; const caps = data.caps || {};
    const body = (data.products || []).map((p) => {
      const t = sum(totals[p.id], stores); const c = caps[p.id];
      return [{ v: kind(p), s: st('text', p) }, { v: p.manufacturer || '', s: st('text', p) }, { v: p.name || '', s: st('text', p) }, { v: p.specification || '', s: st('text', p) }, { v: String(p.jan || ''), s: st('jan', p) }, { v: p.packSize === '' || p.packSize == null ? '' : Number(p.packSize), s: st('num', p) }]
        .concat(stores.map((s) => { const v = Number(totals[p.id] && totals[p.id][s.id]) || 0; return { v: v || '', s: st('num', p) }; }), [{ v: t || '', s: st('num', p) }], [c == null ? { v: '未入力', s: st('open', p) } : { v: Number(c), s: st('num', p) }, { v: c == null ? '' : Math.max(0, Number(c) - t), s: st('num', p) }, { v: c != null && t > Number(c) ? t - Number(c) : '', s: st('num', p) }]);
    });
    const foot = [{ v: '総合計', s: 'totalLabel' }].concat(Array(5).fill({ v: '', s: 'totalLabel' }), stores.map((s) => ({ v: (data.products || []).reduce((n, p) => n + (Number(totals[p.id] && totals[p.id][s.id]) || 0), 0), s: 'total' })), [{ v: (data.products || []).reduce((n, p) => n + sum(totals[p.id], stores), 0), s: 'total' }], [{ v: '', s: 'totalLabel' }, { v: '', s: 'totalLabel' }, { v: '', s: 'totalLabel' }]);
    sheets.push({ name: sheetName('月間合計', used), headerRow: 5, freezeCols: 3, filter: true, widths: [10, 14, 28, 10, 15, 6].concat(stores.map((s) => Math.max(7, String(storeLabel(s)).length * 2 + 2)), [8], [8, 7, 9]), rows: top('畜産 発注書　' + (config.label || '') + '　月間合計').concat([head], body, [foot]) });
    const wj = jst(when); const fileName = '畜産発注_' + (config.label || config.month || '') + '_' + wj.getUTCFullYear() + p2(wj.getUTCMonth() + 1) + p2(wj.getUTCDate()) + '-' + p2(wj.getUTCHours()) + p2(wj.getUTCMinutes()) + '.xlsx';
    return { bytes: writeXlsx(sheets, when), fileName, sheetNames: sheets.map((s) => s.name) };
  }

  root.OrderBook = Object.freeze({ rowStatus, orderTypeOf, isAggregate, LEGEND, leadDaysOf, leadCutoffMs, jstLabel, jstToday, LEAD_CUTOFF_HOUR, MAX_LEAD_DAYS, crc32, zipStored, writeXlsx, sheetName, dayLabel, build, stamp });
})(typeof window !== 'undefined' ? window : globalThis);
