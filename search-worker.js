'use strict';

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s　・･‐‑‒–—―ー_.,，。/\\-]+/g, '');
}

self.onmessage = (event) => {
  const query = normalize(event.data?.query);
  const products = Array.isArray(event.data?.products) ? event.data.products : [];
  const ids = products
    .filter((p) => normalize([p.name, p.manufacturer, p.specification, p.jan, ...(Array.isArray(p.aliases) ? p.aliases : [])].join(' ')).includes(query))
    .map((p) => p.id);
  self.postMessage({ query: event.data?.query || '', ids });
};
