/* OptiVet reporting dashboard - page script. Talks only to this server's /api. */
(() => {
  const $ = (id) => document.getElementById(id);
  const KPIS = [
    ['newLeads', 'New leads', 'Contacts created in range'],
    ['productsRequested', 'Products requested', 'Device requests across new leads'],
    ['callsIn', 'Calls in', 'Inbound calls'],
    ['callsOut', 'Calls out', 'Outbound calls'],
    ['smsIn', 'SMS in', 'Inbound texts'],
    ['smsOut', 'SMS out', 'Outbound texts'],
    ['postalMailers', 'Postal mailers', 'New leads wanting a physical packet'],
  ];

  const state = { preset: 'today', from: null, to: null, report: null, trendTable: false };

  const nf = new Intl.NumberFormat('en-US');
  const fmtNum = (n) => nf.format(n || 0);
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c !== null && c !== undefined) node.append(c);
    return node;
  };
  const svgEl = (tag, attrs = {}) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  /* ---------------- tooltip ---------------- */
  const tip = $('tooltip');
  function showTip(evt, rows) {
    tip.replaceChildren();
    for (const [k, v, strong] of rows) {
      const line = el('div');
      if (strong) line.append(el('b', { text: v }), ' ', el('span', { class: 'k', text: k }));
      else line.append(el('span', { class: 'k', text: k + ' ' }), el('span', { text: v }));
      tip.append(line);
    }
    tip.hidden = false;
    moveTip(evt);
  }
  function moveTip(evt) {
    const pad = 12;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    const r = tip.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  /* ---------------- fetch ---------------- */
  async function load({ refresh = false } = {}) {
    const params = new URLSearchParams();
    if (state.preset) params.set('preset', state.preset);
    else { params.set('from', state.from); params.set('to', state.to); }
    if (refresh) params.set('refresh', '1');

    $('main').classList.add('loading');
    $('refresh-btn').disabled = true;
    $('error').hidden = true;
    const status = $('refreshed');
    const prev = status.cloneNode(true);
    status.textContent = refresh ? 'Pulling fresh data from GoHighLevel… a full month can take about a minute.' : 'Loading… the first pull of a date range can take up to a minute.';
    try {
      const res = await fetch('/api/report?' + params.toString(), { headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => ({ ok: false, error: { type: 'server', message: `HTTP ${res.status}` } }));
      if (!data.ok) throw data.error || { message: 'Unknown error' };
      state.report = data;
      render(data);
    } catch (err) {
      status.replaceChildren(...prev.childNodes);
      showError(err);
    } finally {
      $('main').classList.remove('loading');
      $('refresh-btn').disabled = false;
    }
  }

  function showError(err) {
    const box = $('error');
    box.replaceChildren();
    const title = err.type === 'auth' ? `Cannot reach GoHighLevel (HTTP ${err.status})` : err.type === 'config' ? 'Dashboard is not configured' : 'Could not load the report';
    box.append(el('strong', { text: title }), el('div', { text: err.message || String(err) }));
    if (err.detail && err.detail !== err.message) box.append(el('div', { class: 'muted', text: err.detail }));
    box.hidden = false;
  }

  /* ---------------- render ---------------- */
  function render(r) {
    const tzFmt = new Intl.DateTimeFormat('en-US', { timeZone: r.range.tz, dateStyle: 'medium', timeStyle: 'short' });
    $('account-line').textContent = `${r.account?.name || 'GoHighLevel'} · read-only · times in ${r.range.tz}`;
    const refreshed = $('refreshed');
    refreshed.replaceChildren(`Last refreshed: ${tzFmt.format(new Date(r.cachedAt))}`, el('span', { class: 'badge', text: r.fromCache ? 'cached' : 'live pull' }));
    $('range-label').textContent = r.range.from === r.range.to ? r.range.from : `${r.range.from} → ${r.range.to} (${r.range.days} days)`;
    $('from').value = r.range.from;
    $('to').value = r.range.to;

    const warn = $('warnings');
    if (r.warnings?.length) { warn.textContent = r.warnings.join('\n'); warn.hidden = false; } else warn.hidden = true;

    renderKpis(r);
    renderTrend(r);
    renderTeam(r);
    renderProducts(r);
    renderFacilities(r);
    renderDataQuality(r);
    renderMeta(r);
  }

  function renderKpis(r) {
    const wrap = $('kpis');
    wrap.replaceChildren();
    for (const [key, label, hint] of KPIS) {
      wrap.append(el('div', { class: 'tile' }, [
        el('div', { class: 'label', text: label }),
        el('div', { class: 'value', text: fmtNum(r.kpis[key]) }),
        el('div', { class: 'hint', text: hint }),
      ]));
    }
  }

  /* Daily trend: one small column chart per KPI, one hue, shared x. */
  function renderTrend(r) {
    const charts = $('trend-charts');
    charts.replaceChildren();
    $('trend-sub').textContent = `${r.daily.length} day${r.daily.length === 1 ? '' : 's'} · counts per local day`;
    for (const [key, label] of KPIS) {
      const values = r.daily.map((d) => d[key]);
      const total = values.reduce((a, b) => a + b, 0);
      const panel = el('div', { class: 'panel' });
      panel.append(el('div', { class: 'ptitle' }, [el('span', { text: label }), el('b', { text: fmtNum(total) })]));
      panel.append(columnChart(r.daily.map((d) => d.date), values, label));
      charts.append(panel);
    }
    // table twin
    const t = $('trend-table');
    t.replaceChildren(table(
      ['Date', ...KPIS.map((k) => k[1])],
      r.daily.map((d) => [d.date, ...KPIS.map(([k]) => d[k])]),
      { numericFrom: 1, totals: true },
    ));
    t.hidden = !state.trendTable;
    charts.hidden = state.trendTable;
  }

  function columnChart(dates, values, label) {
    const W = 300, H = 110, padL = 28, padR = 8, padT = 8, padB = 22;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const max = Math.max(1, ...values);
    const niceMax = niceCeil(max);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${label} per day` });
    // gridlines: 0, half, max
    for (const frac of [0.5, 1]) {
      const y = padT + plotH - plotH * frac;
      svg.append(svgEl('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: 'grid' }));
      const t = svgEl('text', { x: padL - 4, y: y + 3.5, 'text-anchor': 'end' });
      t.textContent = compact(niceMax * frac);
      svg.append(t);
    }
    const base = padT + plotH;
    svg.append(svgEl('line', { x1: padL, x2: W - padR, y1: base, y2: base, class: 'baseline' }));
    const n = values.length;
    const slot = plotW / n;
    const bw = Math.min(24, Math.max(3, slot - 2));
    const fmtDay = (iso) => {
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    };
    values.forEach((v, i) => {
      const x = padL + slot * i + (slot - bw) / 2;
      const h = (v / niceMax) * plotH;
      const y = base - h;
      const g = svgEl('g');
      if (v > 0) {
        const rr = Math.min(4, bw / 2, h);
        const path = `M${x},${base} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + bw - rr} Q${x + bw},${y} ${x + bw},${y + rr} V${base} Z`;
        g.append(svgEl('path', { d: path, class: 'bar' }));
      }
      const hit = svgEl('rect', { x: padL + slot * i, y: padT, width: slot, height: plotH + padB, class: 'hit' });
      const rows = [[label, fmtNum(v), true], ['', fmtDay(dates[i])]];
      hit.addEventListener('pointerenter', (e) => { showTip(e, rows); g.querySelector('.bar')?.classList.add('hot'); });
      hit.addEventListener('pointermove', moveTip);
      hit.addEventListener('pointerleave', () => { hideTip(); g.querySelector('.bar')?.classList.remove('hot'); });
      g.append(hit);
      svg.append(g);
    });
    // x labels: first, last, and a few in between
    const step = Math.max(1, Math.ceil(n / 6));
    dates.forEach((d, i) => {
      if (i % step !== 0 && i !== n - 1) return;
      const t = svgEl('text', { x: padL + slot * i + slot / 2, y: H - 6, 'text-anchor': i === n - 1 && n > 1 ? 'end' : i === 0 ? 'start' : 'middle' });
      t.textContent = fmtDay(d);
      svg.append(t);
    });
    // end label on the max bar only
    const maxI = values.indexOf(Math.max(...values));
    if (values[maxI] > 0 && n > 1) {
      const t = svgEl('text', { x: padL + slot * maxI + slot / 2, y: base - (values[maxI] / niceMax) * plotH - 3, 'text-anchor': 'middle', class: 'vlabel' });
      t.textContent = fmtNum(values[maxI]);
      svg.append(t);
    }
    return svg;
  }

  function niceCeil(v) {
    if (v <= 5) return 5;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  const compact = (v) => (v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'K' : String(Math.round(v * 10) / 10));

  function renderTeam(r) {
    const rows = r.team.rows;
    $('team-sub').textContent = `${rows.filter((x) => !x.isSystem).length} people with activity`;
    $('team-note').textContent = r.team.note + (r.team.inboundAttributedByConversation ? ` (${fmtNum(r.team.inboundAttributedByConversation)} inbound messages credited this way.)` : '');
    const wrap = $('team-table');
    if (!rows.length) { wrap.replaceChildren(el('div', { class: 'empty', text: 'No calls or texts in this range.' })); return; }
    const t = table(
      ['Team member', 'Calls in', 'Calls out', 'SMS in', 'SMS out', 'Total'],
      rows.map((x) => [x.name, x.callsIn, x.callsOut, x.smsIn, x.smsOut, x.total]),
      { numericFrom: 1, totals: true, rowClass: (i) => (rows[i].isSystem ? 'system' : '') },
    );
    wrap.replaceChildren(t);
  }

  /* Products: horizontal bars, one hue, value at the tip. */
  function renderProducts(r) {
    const rows = r.products.rows;
    $('products-sub').textContent = `${fmtNum(r.products.totalRequests)} requests from ${fmtNum(r.products.leadsWithAnyProduct)} of ${fmtNum(r.facilities.leadsTotal)} new leads`;
    $('products-note').textContent = r.products.note + (r.products.leadsFromTags ? ` ${fmtNum(r.products.leadsFromTags)} lead(s) used tags.` : '');
    const wrap = $('products-chart');
    if (!rows.length) { wrap.replaceChildren(el('div', { class: 'empty', text: 'No product requests in this range.' })); return; }
    const W = 640, rowH = 30, padL = 190, padR = 56, padT = 6;
    const H = padT + rows.length * rowH + 6;
    const max = Math.max(1, ...rows.map((x) => x.count));
    const plotW = W - padL - padR;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Requests by product', style: 'width:100%;max-width:760px;height:auto;display:block' });
    svg.append(svgEl('line', { x1: padL, x2: padL, y1: padT, y2: H - 6, class: 'baseline' }));
    rows.forEach((p, i) => {
      const y = padT + i * rowH + (rowH - 18) / 2;
      const w = (p.count / max) * plotW;
      const g = svgEl('g');
      const name = svgEl('text', { x: padL - 10, y: y + 13, 'text-anchor': 'end', class: 'bname' });
      name.textContent = p.product;
      g.append(name);
      const rr = Math.min(4, w / 2);
      g.append(svgEl('path', { d: `M${padL},${y} H${padL + w - rr} Q${padL + w},${y} ${padL + w},${y + rr} V${y + 18 - rr} Q${padL + w},${y + 18} ${padL + w - rr},${y + 18} H${padL} Z`, class: 'bar' }));
      const val = svgEl('text', { x: padL + w + 8, y: y + 13, class: 'blabel' });
      val.textContent = fmtNum(p.count);
      g.append(val);
      const hit = svgEl('rect', { x: 0, y: padT + i * rowH, width: W, height: rowH, class: 'hit' });
      const pct = r.facilities.leadsTotal ? Math.round((p.count / r.facilities.leadsTotal) * 100) : 0;
      hit.addEventListener('pointerenter', (e) => { showTip(e, [[p.product, fmtNum(p.count), true], ['of new leads', pct + '%']]); g.querySelector('.bar').classList.add('hot'); });
      hit.addEventListener('pointermove', moveTip);
      hit.addEventListener('pointerleave', () => { hideTip(); g.querySelector('.bar').classList.remove('hot'); });
      g.append(hit);
      svg.append(g);
    });
    wrap.replaceChildren(svg);
  }

  function renderFacilities(r) {
    const f = r.facilities;
    $('facility-sub').textContent = `${fmtNum(f.rows.length)} facilities`;
    const note = $('facility-note');
    note.replaceChildren(
      el('strong', { text: `${f.pctWithFacility}% of new leads have a VA facility on file` }),
      ` (${fmtNum(f.leadsWithFacility)} of ${fmtNum(f.leadsTotal)}).`,
      f.communityCareLeads ? ` ${fmtNum(f.communityCareLeads)} lead(s) use a Community Care partner and are not expected to name a VA facility.` : '',
    );
    const wrap = $('facility-table');
    if (!f.rows.length) { wrap.replaceChildren(el('div', { class: 'empty', text: 'No leads with a facility on file in this range.' })); return; }
    const maxCell = Math.max(1, ...f.rows.flatMap((row) => Object.values(row.counts)));
    const head = ['VA facility', 'State', 'Leads', ...f.products, 'Devices'];
    const body = f.rows.map((row) => [row.facility, row.state || '—', row.leads, ...f.products.map((p) => row.counts[p]), row.total]);
    const t = table(head, body, {
      numericFrom: 2,
      totals: true,
      cellClass: (ri, ci, v) => {
        if (ci < 3 || ci === head.length - 1 || !v) return '';
        // Four tint steps. With tiny maxima (1-3) step by value so a lone
        // "1" is not painted as the darkest cell on the page.
        const level = maxCell < 4 ? Math.min(v, 3) : Math.max(1, Math.ceil((v / maxCell) * 4));
        return 'cell l' + level;
      },
    });
    wrap.replaceChildren(t);
  }

  function renderDataQuality(r) {
    const dq = r.dataQuality;
    const hideCC = $('dq-hide-cc').checked;
    const rows = hideCC ? dq.rows.filter((x) => x.carePath !== 'Community Care') : dq.rows;
    $('dq-sub').replaceChildren(
      el('strong', { text: `${fmtNum(dq.total)} of ${fmtNum(r.facilities.leadsTotal)} new leads` }),
      ` are missing a VA location (${fmtNum(dq.missingFacility)}) or a state (${fmtNum(dq.missingState)}).`,
      hideCC && rows.length !== dq.rows.length ? ` Showing ${fmtNum(rows.length)} after hiding Community Care leads.` : '',
    );
    const csv = $('dq-csv');
    csv.href = `/api/data-quality.csv?from=${encodeURIComponent(r.range.from)}&to=${encodeURIComponent(r.range.to)}`;
    csv.setAttribute('download', `optivet-data-quality-${r.range.from}-to-${r.range.to}.csv`);
    const wrap = $('dq-table');
    if (!rows.length) { wrap.replaceChildren(el('div', { class: 'empty', text: 'Every new lead in this range has both a VA location and a state. Nothing to fix.' })); return; }
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: r.range.tz, dateStyle: 'medium', timeStyle: 'short' });
    const t = el('table');
    t.append(el('thead', {}, el('tr', {}, ['Name', 'Created', 'Missing', 'Care path', 'Products'].map((h) => el('th', { text: h })))));
    const tb = el('tbody');
    for (const x of rows) {
      tb.append(el('tr', {}, [
        el('td', { text: x.name }),
        el('td', { text: fmt.format(new Date(x.createdAt)) }),
        el('td', {}, x.missing.map((m) => el('span', { class: 'pill', text: m }))),
        el('td', { text: x.carePath || '—' }),
        el('td', { text: x.products.join(', ') || '—' }),
      ]));
    }
    t.append(tb);
    wrap.replaceChildren(t);
  }

  function renderMeta(r) {
    const dl = el('dl');
    const add = (k, v) => dl.append(el('dt', { text: k }), typeof v === 'string' ? el('dd', { text: v }) : el('dd', {}, v));
    for (const [slot, m] of Object.entries(r.fieldMap)) {
      const names = m.fields.length ? m.fields.map((f) => f.name).join(' → ') : 'not found';
      add(m.label, `${names}${m.source === 'override' ? ' (set by environment)' : ''}${slot === 'postal' ? ' · plus tags "physical mail" / "postcard mailer"' : ''}${slot === 'state' ? ' · then the contact\'s own State' : ''}`);
    }
    add('Messages', r.sources.messagesNote || r.sources.messages);
    add('Timezone', r.range.tz);
    add('Window', `${r.range.startIso} → ${r.range.endIso}`);
    add('Pull', `${fmtNum(r.apiCalls)} GoHighLevel requests in ${(r.durationMs / 1000).toFixed(1)}s · cached for ${Math.round(r.cacheTtlSeconds / 60)} min · ${fmtNum(r.sources.messagesCount)} call/SMS records`);
    $('meta').replaceChildren(dl);
  }

  /* Generic table with optional totals row and numeric alignment. */
  function table(head, body, { numericFrom = 1, totals = false, rowClass, cellClass } = {}) {
    const t = el('table');
    t.append(el('thead', {}, el('tr', {}, head.map((h, i) => el('th', { class: i >= numericFrom ? 'num' : '', text: h })))));
    const tb = el('tbody');
    body.forEach((row, ri) => {
      const tr = el('tr', { class: rowClass ? rowClass(ri) : '' });
      row.forEach((v, ci) => {
        const extra = cellClass ? cellClass(ri, ci, v) : '';
        tr.append(el('td', { class: `${ci >= numericFrom ? 'num' : ''} ${extra}`.trim(), text: typeof v === 'number' ? fmtNum(v) : String(v) }));
      });
      tb.append(tr);
    });
    if (totals && body.length > 1) {
      const sums = head.map((_, ci) => (ci >= numericFrom ? body.reduce((a, row) => a + (Number(row[ci]) || 0), 0) : ci === 0 ? 'Total' : ''));
      tb.append(el('tr', { class: 'total' }, sums.map((v, ci) => el('td', { class: ci >= numericFrom ? 'num' : '', text: typeof v === 'number' ? fmtNum(v) : v }))));
    }
    t.append(tb);
    return t;
  }

  /* ---------------- wiring ---------------- */
  function setPreset(name) {
    state.preset = name;
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.preset === name)));
  }
  document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => { setPreset(c.dataset.preset); load(); }));
  $('custom-form').addEventListener('submit', (e) => {
    e.preventDefault();
    state.preset = null;
    state.from = $('from').value;
    state.to = $('to').value;
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
    load();
  });
  $('refresh-btn').addEventListener('click', () => load({ refresh: true }));
  $('trend-toggle').addEventListener('click', () => {
    state.trendTable = !state.trendTable;
    $('trend-toggle').setAttribute('aria-pressed', String(state.trendTable));
    $('trend-toggle').textContent = state.trendTable ? 'Chart view' : 'Table view';
    $('trend-charts').hidden = state.trendTable;
    $('trend-table').hidden = !state.trendTable;
  });
  $('dq-hide-cc').addEventListener('change', () => state.report && renderDataQuality(state.report));

  setPreset('today');
  load();
})();
