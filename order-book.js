// 注文の Excel（xlsx）を作る部品と、行ごとの「確定・未確定」の決まり。外の部品は使わない（zip は縮めない stored・CRC32 は自前）。window.OrderBook
//   画面（app.js の印刷と Excel でダウンロード）と試験が使う。中身は GAS の exportOrders が返した保存済みの値だけ（画面の入力途中の値は入れない）。
// 確定・未確定の決まり（いまの作り: 締切は月ごとに1つ・締切を過ぎると確定〈1時間ごとの自動か、BY の保存で確定の印〉・上限に達した後の日付は SOLD OUT）:
//   確定（締切後）＝その月の締切を過ぎた（店はもう直せない）。月の全部の行が同じ。
//   確定（SOLD OUT）＝締切の前でも、上限に達した後の日付（その日は、もう注文を増やせない）。
//   未確定＝締切の前（締切の日時まで、数が変わりうる）。締切が決まっていない月は「未確定（締切未設定）」。
(function (root) {
  'use strict';
  const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const WEEKDAY = '日月火水木金土';

  // ------------------------------------------------------------ 確定・未確定（画面・印刷・Excel で同じ）
  function shortDeadline(config) { return String((config && config.deadlineLabel) || '').replace(/^\d{4}\//, ''); }
  /** 行の状態: { code: 'closed'|'soldout'|'open'|'nodeadline'|'', mark: '確定'|'未確定'|'', label: Excel・印刷の言葉 } */
  function rowStatus(row, config) {
    config = config || {};
    if (!row || row.inMonth === false) return { code: '', mark: '', label: '' };
    if (config.confirmed) return { code: 'closed', mark: '確定', label: '確定（締切後）' };
    if (row.soldOut) return { code: 'soldout', mark: '確定', label: '確定（SOLD OUT）' };
    if (config.deadline) return { code: 'open', mark: '未確定', label: '未確定（' + shortDeadline(config) + ' まで変わる）' };
    return { code: 'nodeadline', mark: '未確定', label: '未確定（締切未設定）' };
  }
  /** 月の状態の1行（印刷の上・Excel の上） */
  function monthStatusText(config) {
    config = config || {};
    if (config.confirmed) return '締切後（確定）・締切 ' + (config.deadlineLabel || '');
    if (config.deadline) return '受付中・' + shortDeadline(config) + ' の締切まで数が変わります';
    return '締切未設定（まだ注文を受けていません）';
  }
  const LEGEND = '印の見方: 確定＝締切後（店は直せません）／確定・SOLD OUT＝上限に達した後の日付（その日は増えません）／未確定＝締切まで変わります（網かけ）';

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
  const STYLE = { plain: 0, title: 1, meta: 2, head: 3, text: 4, num: 5, jan: 6, total: 7, totalLabel: 8, open: 9 };
  const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="' + MAIN_NS + '">'
    + '<fonts count="3"><font><sz val="11"/><name val="Meiryo UI"/><family val="3"/><charset val="128"/></font><font><b/><sz val="11"/><name val="Meiryo UI"/><family val="3"/><charset val="128"/></font><font><b/><sz val="13"/><name val="Meiryo UI"/><family val="3"/><charset val="128"/></font></fonts>'
    + '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF3ED"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="lightGray"><fgColor rgb="FFB0B0B0"/><bgColor rgb="FFFFFFFF"/></patternFill></fill></fills>'
    + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFC9D6CC"/></left><right style="thin"><color rgb="FFC9D6CC"/></right><top style="thin"><color rgb="FFC9D6CC"/></top><bottom style="thin"><color rgb="FFC9D6CC"/></bottom><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="10">'
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
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = (d) => d.getFullYear() + '/' + p2(d.getMonth() + 1) + '/' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  function dayLabel(date) { const [y, m, d] = String(date).split('-').map(Number); const wd = new Date(y, m - 1, d).getDay(); return m + '/' + d + '（' + WEEKDAY.charAt(wd) + '）'; }
  const md = (date) => { const [, m, d] = String(date).split('-').map(Number); return m + '-' + d; };
  const storeLabel = (s) => s.short || s.name || s.id;
  const sum = (obj, stores) => stores.reduce((n, s) => n + (Number(obj && obj[s.id]) || 0), 0);

  /**
   * data＝GAS の exportOrders の返事（保存済みの値）・meta＝{ exportedAt: Date, who: '名前（役割）' }
   * 返す値: { bytes, fileName, sheetNames }
   */
  function build(data, meta) {
    meta = meta || {};
    const config = data.month || {}; const stores = data.stores || [];
    const products = new Map((data.products || []).map((p) => [String(p.id), p]));
    const when = meta.exportedAt instanceof Date && !isNaN(meta.exportedAt) ? meta.exportedAt : new Date();
    const top = (title) => [[{ v: title, s: 'title' }], [{ v: '締切: ' + (config.deadlineLabel || '未設定') + '　状態: ' + monthStatusText(config), s: 'meta' }], [{ v: '出力: ' + stamp(when) + '　' + (meta.who || ''), s: 'meta' }], [{ v: '数はケース。空の欄は注文なし。' + LEGEND.replace('（網かけ）', '（網かけ・状態の列）'), s: 'meta' }]];
    const used = new Set(); const sheets = [];
    (data.weeks || []).forEach((w) => {
      const rows = (w.rows || []).filter((r) => r.inMonth !== false && products.has(String(r.productId)));
      if (!rows.length || !(w.rows || []).length) return;
      const first = w.rows[0].date, last = w.rows[w.rows.length - 1].date;
      const name = sheetName((w.label || '週') + ' ' + md(first) + '〜' + md(last), used);
      const head = ['日付', '状態', 'メーカー', '商品名', '規格', 'JAN', '入数'].concat(stores.map(storeLabel), ['合計']).map((v) => ({ v, s: 'head' }));
      const body = rows.map((r) => {
        const p = products.get(String(r.productId)); const st = rowStatus(r, config);
        const qty = stores.map((s) => { const v = r.quantities && r.quantities[s.id]; return v == null || v === '' || Number(v) === 0 ? { v: '', s: 'num' } : { v: Number(v), s: 'num' }; });
        const total = sum(r.quantities, stores);
        return [{ v: dayLabel(r.date), s: 'text' }, { v: st.label, s: st.code === 'open' || st.code === 'nodeadline' ? 'open' : 'text' }, { v: p.manufacturer || '', s: 'text' }, { v: p.name || '', s: 'text' }, { v: p.specification || '', s: 'text' }, { v: String(p.jan || ''), s: 'jan' }, { v: p.packSize === '' || p.packSize == null ? '' : Number(p.packSize), s: 'num' }].concat(qty, [{ v: total || '', s: 'num' }]);
      });
      const foot = [{ v: '週の合計', s: 'totalLabel' }].concat(Array(6).fill({ v: '', s: 'totalLabel' }), stores.map((s) => ({ v: rows.reduce((n, r) => n + (Number(r.quantities && r.quantities[s.id]) || 0), 0), s: 'total' })), [{ v: rows.reduce((n, r) => n + sum(r.quantities, stores), 0), s: 'total' }]);
      sheets.push({ name, headerRow: 5, freezeCols: 4, filter: true, widths: [11, 18, 14, 28, 10, 15, 6].concat(stores.map((s) => Math.max(7, String(storeLabel(s)).length * 2 + 2)), [8]), rows: top('畜産 発注書　' + (config.label || '') + '　' + (w.label || '') + '（' + dayLabel(first) + '〜' + dayLabel(last) + '）').concat([head], body, [foot]) });
    });
    // 月間合計
    const cap = Boolean(config.capEnabled);
    const head = ['メーカー', '商品名', '規格', 'JAN', '入数'].concat(stores.map(storeLabel), ['月計'], cap ? ['上限', '残数'] : []).map((v) => ({ v, s: 'head' }));
    const totals = data.monthTotals || {}; const caps = data.caps || {};
    const body = (data.products || []).map((p) => {
      const t = sum(totals[p.id], stores); const c = caps[p.id];
      return [{ v: p.manufacturer || '', s: 'text' }, { v: p.name || '', s: 'text' }, { v: p.specification || '', s: 'text' }, { v: String(p.jan || ''), s: 'jan' }, { v: p.packSize === '' || p.packSize == null ? '' : Number(p.packSize), s: 'num' }]
        .concat(stores.map((s) => { const v = Number(totals[p.id] && totals[p.id][s.id]) || 0; return { v: v || '', s: 'num' }; }), [{ v: t || '', s: 'num' }], cap ? [{ v: c == null ? '' : Number(c), s: 'num' }, { v: c == null ? '' : Math.max(0, Number(c) - t), s: 'num' }] : []);
    });
    const foot = [{ v: '総合計', s: 'totalLabel' }].concat(Array(4).fill({ v: '', s: 'totalLabel' }), stores.map((s) => ({ v: (data.products || []).reduce((n, p) => n + (Number(totals[p.id] && totals[p.id][s.id]) || 0), 0), s: 'total' })), [{ v: (data.products || []).reduce((n, p) => n + sum(totals[p.id], stores), 0), s: 'total' }], cap ? [{ v: '', s: 'totalLabel' }, { v: '', s: 'totalLabel' }] : []);
    sheets.push({ name: sheetName('月間合計', used), headerRow: 5, freezeCols: 2, filter: true, widths: [14, 28, 10, 15, 6].concat(stores.map((s) => Math.max(7, String(storeLabel(s)).length * 2 + 2)), [8], cap ? [7, 7] : []), rows: top('畜産 発注書　' + (config.label || '') + '　月間合計').concat([head], body, [foot]) });
    const fileName = '畜産発注_' + (config.label || config.month || '') + '_' + when.getFullYear() + p2(when.getMonth() + 1) + p2(when.getDate()) + '-' + p2(when.getHours()) + p2(when.getMinutes()) + '.xlsx';
    return { bytes: writeXlsx(sheets, when), fileName, sheetNames: sheets.map((s) => s.name) };
  }

  root.OrderBook = Object.freeze({ rowStatus, monthStatusText, LEGEND, shortDeadline, crc32, zipStored, writeXlsx, sheetName, dayLabel, build, stamp });
})(typeof window !== 'undefined' ? window : globalThis);
