/* ScreamingFreed web UI — parses the uploaded URL list in the browser,
 * chunks it into small batches and calls POST /api/audit for each batch
 * (a serverless function). All results are held in the browser and can be
 * downloaded as CSV or JSON. */
'use strict';

(function () {
  const byId = (id) => document.getElementById(id);

  const fileInput = byId('file');
  const dropEl = byId('drop');
  const fileChip = byId('fileChip');
  const fileNameEl = byId('fileName');
  const fileMetaEl = byId('fileMeta');
  const clearFileBtn = byId('clearFile');
  const inputFileEl = byId('inputFile');
  const inputPasteEl = byId('inputPaste');
  const urlsInput = byId('urls');
  const rpsInput = byId('rps');
  const concurrencyInput = byId('concurrency');
  const timeoutInput = byId('timeout');
  const batchInput = byId('batch');
  const tokenInput = byId('token');
  const reqHeadersInput = byId('reqHeaders');
  const startBtn = byId('start');
  const startLabel = byId('startLabel');
  const stopBtn = byId('stop');
  const countHint = byId('countHint');
  const progressCard = byId('progressCard');
  const progressTitle = byId('progressTitle');
  const progressBar = byId('progressBar');
  const etaEl = byId('eta');
  const pctEl = byId('pct');
  const statusEl = byId('status');
  const barEl = byId('bar');
  const countersEl = byId('counters');
  const logBox = byId('logBox');
  const logEl = byId('log');
  const logCountEl = byId('logCount');
  const resultsCard = byId('resultsCard');
  const summaryEl = byId('summary');
  const csvBtn = byId('csv');
  const jsonBtn = byId('json');

  const CSV_COLUMNS = [
    ['page_url', 'pageUrl'], ['target_url', 'targetUrl'], ['final_url', 'finalUrl'],
    ['anchor_text', 'anchorText'], ['scope', 'scope'], ['http_status', 'httpStatus'],
    ['outcome', 'outcome'], ['redirect_hops', 'redirectHops'], ['method_used', 'methodUsed'],
    ['checked_at', 'checkedAt'],
  ];
  const MAX_LOG_LINES = 500;
  const MAX_TABLE_ROWS = 500;

  const CLASS_INFO = {
    ok: { label: 'OK (2xx)', tone: 'var(--ok)' },
    warn: { label: 'Redirected', tone: 'var(--warn)' },
    bad: { label: 'Broken (4xx/5xx)', tone: 'var(--bad)' },
    err: { label: 'Network error', tone: 'var(--err)' },
    blocked: { label: 'Bot-protected', tone: 'var(--info)' },
  };

  let state = null;
  let controller = null;
  let fileText = '';
  let fileIsCsv = false;
  let inputMode = 'file';
  let scope = '';
  let currentSnapshot = null;
  let activeTab = 'overview';
  const tableFilters = { links: { q: '', cls: '' }, broken: { q: '' }, pages: { q: '' } };
  let logLines = 0;

  // ---------- small DOM helpers ---------------------------------------------

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) {
          continue;
        }
        if (key === 'class') {
          node.className = value;
        } else if (key === 'text') {
          node.textContent = value;
        } else if (key === 'style') {
          node.setAttribute('style', value);
        } else if (key.startsWith('on')) {
          node.addEventListener(key.slice(2), value);
        } else {
          node.setAttribute(key, value === true ? '' : value);
        }
      }
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) {
        continue;
      }
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(pathD, size) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(size || 18));
    svg.setAttribute('height', String(size || 18));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathD);
    svg.appendChild(path);
    return svg;
  }
  const ICONS = {
    check: 'M20 6L9 17l-5-5',
    alert: 'M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
    shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z',
    info: 'M12 16v-4m0-4h.01M22 12a10 10 0 11-20 0 10 10 0 0120 0z',
    x: 'M18 6L6 18M6 6l12 12',
  };

  function banner(kind, title, text, items) {
    const iconName = { good: 'check', warn: 'alert', error: 'x', info: 'shield' }[kind] || 'info';
    return el('div', { class: `banner ${kind}` }, [
      icon(ICONS[iconName], 18),
      el('div', { class: 'body' }, [
        el('b', { text: title }),
        text ? el('p', { text }) : null,
        items && items.length > 0 ? el('ul', null, items.map((item) => el('li', { text: item }))) : null,
      ]),
    ]);
  }

  function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(Math.max(parsed, min), max);
  }

  function plural(n, word) {
    return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  }

  function formatDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) {
      return `${s}s`;
    }
    const m = Math.floor(s / 60);
    if (m < 60) {
      return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    }
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  }

  function setStatus(message, kind, busy) {
    statusEl.textContent = '';
    statusEl.className = kind || '';
    if (busy) {
      statusEl.appendChild(el('span', { class: 'spinner', 'aria-hidden': 'true' }));
    }
    statusEl.appendChild(document.createTextNode(message));
  }

  // ---------- link classification -------------------------------------------

  function classOf(link) {
    if (link.outcome === 'bot_protection') {
      return 'blocked';
    }
    if (link.httpStatus === null || link.httpStatus === undefined) {
      return 'err';
    }
    if (link.httpStatus < 300) {
      // A link that only works through a redirect is worth updating.
      return link.redirectHops > 0 ? 'warn' : 'ok';
    }
    if (link.httpStatus < 400) {
      return 'warn';
    }
    return 'bad';
  }

  function isBroken(link) {
    const cls = classOf(link);
    return cls === 'bad' || cls === 'err';
  }

  function statusLabelFor(link) {
    if (link.outcome === 'bot_protection') {
      return link.httpStatus ? `Blocked ${link.httpStatus}` : 'Blocked';
    }
    if (link.httpStatus === null || link.httpStatus === undefined) {
      return link.outcome.replace(/_/g, ' ');
    }
    if (link.httpStatus < 300 && link.redirectHops > 0) {
      return `Redirect → ${link.httpStatus}`;
    }
    return String(link.httpStatus);
  }

  function statusPill(link) {
    return el('span', { class: `pill ${classOf(link)}`, text: statusLabelFor(link) });
  }

  const LOG_CLASS = { ok: 's2', warn: 's3', bad: 's4', err: 'se', blocked: 'sb' };

  // ---------- theme ---------------------------------------------------------

  const root = document.documentElement;
  try {
    const savedTheme = localStorage.getItem('sf-theme');
    if (savedTheme === 'light' || savedTheme === 'dark') {
      root.setAttribute('data-theme', savedTheme);
    }
  } catch (error) {
    // Storage unavailable (private mode); fall back to the system theme.
  }
  byId('themeToggle').addEventListener('click', () => {
    const current = root.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('sf-theme', next);
    } catch (error) {
      // ignore
    }
  });

  // ---------- segmented controls ---------------------------------------------

  function wireSeg(container, attr, onChange) {
    const buttons = [...container.querySelectorAll(`button[${attr}]`)];
    for (const button of buttons) {
      button.addEventListener('click', () => {
        for (const other of buttons) {
          other.setAttribute('aria-selected', String(other === button));
        }
        onChange(button.getAttribute(attr));
      });
    }
  }

  wireSeg(byId('inputSeg'), 'data-input', (mode) => {
    inputMode = mode;
    inputFileEl.hidden = mode !== 'file';
    inputPasteEl.hidden = mode !== 'paste';
    if (mode === 'paste') {
      urlsInput.focus();
    }
    updateCountHint();
  });
  wireSeg(byId('scopeSeg'), 'data-scope', (value) => {
    scope = value;
  });
  wireSeg(byId('resultTabs'), 'data-tab', (tab) => {
    activeTab = tab;
    if (currentSnapshot) {
      renderResults(currentSnapshot);
    }
  });

  // ---------- seed collection ---------------------------------------------

  function firstCsvColumn(line) {
    const column = (line.split(',')[0] || '').trim();
    if (column.length >= 2 && column.startsWith('"') && column.endsWith('"')) {
      return column.slice(1, -1);
    }
    return column;
  }

  async function loadFile(file) {
    if (!file) {
      return;
    }
    fileText = await file.text();
    fileIsCsv = file.name.toLowerCase().endsWith('.csv');
    const count = parseSeedList().length;
    fileNameEl.textContent = file.name;
    fileMetaEl.textContent = `${plural(count, 'URL')} found · ${(file.size / 1024).toFixed(1)} KB`;
    dropEl.hidden = true;
    fileChip.hidden = false;
    updateCountHint();
  }

  fileInput.addEventListener('change', () => loadFile(fileInput.files && fileInput.files[0]));
  clearFileBtn.addEventListener('click', () => {
    fileText = '';
    fileIsCsv = false;
    fileInput.value = '';
    dropEl.hidden = false;
    fileChip.hidden = true;
    updateCountHint();
    fileInput.click();
  });
  for (const type of ['dragenter', 'dragover']) {
    dropEl.addEventListener(type, (event) => {
      event.preventDefault();
      dropEl.classList.add('drag');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dropEl.addEventListener(type, () => dropEl.classList.remove('drag'));
  }
  dropEl.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (file) {
      loadFile(file);
    }
  });
  urlsInput.addEventListener('input', updateCountHint);

  function parseSeedList() {
    let entries;
    if (inputMode === 'file') {
      entries = [];
      for (const rawLine of fileText.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length > 0) {
          entries.push(fileIsCsv ? firstCsvColumn(line) : line);
        }
      }
    } else {
      entries = urlsInput.value.split(/[\n,]+/);
    }
    const seen = new Set();
    const seeds = [];
    for (const rawEntry of entries) {
      const entry = rawEntry.trim();
      if (entry.length === 0 || seen.has(entry)) {
        continue;
      }
      // Skip a CSV header row such as "url" or "Address".
      if (!/^https?:\/\//i.test(entry) && seeds.length === 0 && !entry.includes('.')) {
        continue;
      }
      seen.add(entry);
      seeds.push(entry);
    }
    return seeds;
  }

  function updateCountHint() {
    if (state) {
      return;
    }
    const count = parseSeedList().length;
    countHint.textContent = '';
    if (count === 0) {
      countHint.textContent = inputMode === 'file'
        ? 'Upload a file to get started.'
        : 'Paste one URL per line.';
      startLabel.textContent = 'Start audit';
    } else {
      countHint.append(el('b', { text: plural(count, 'page') }), ' ready to audit');
      startLabel.textContent = `Audit ${plural(count, 'page')}`;
    }
  }

  // ---------- log ------------------------------------------------------------

  function addLogLine(text, cssClass) {
    if (logLines === 0) {
      logEl.textContent = '';
    }
    logLines += 1;
    logEl.appendChild(el('div', { class: cssClass || null, text }));
    while (logEl.children.length > MAX_LOG_LINES) {
      logEl.removeChild(logEl.firstChild);
    }
    logCountEl.textContent = plural(logLines, 'line');
    if (logBox.open) {
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  // ---------- audit loop ---------------------------------------------------

  function requestHeaders() {
    const headers = { 'content-type': 'application/json' };
    if (tokenInput.value.trim() !== '') {
      headers['x-audit-token'] = tokenInput.value.trim();
    }
    return headers;
  }

  function mergeBatch(data) {
    for (const page of data.pages) {
      state.pages.set(page.url, page);
      if (page.selectorUsed === null) {
        addLogLine(
          `PAGE ${page.httpStatus === null ? '' : page.httpStatus} ${page.fetchError || 'no content'}  ${page.url}`,
          page.fetchError === 'bot_protection' ? 'sb' : 'se',
        );
      }
    }
    for (const link of data.links) {
      const key = `${link.pageUrl}\u0000${link.targetUrl}`;
      if (!state.links.has(key)) {
        state.links.set(key, link);
        state.targets.add(link.targetUrl);
        let line = `${statusLabelFor(link).padEnd(14)} ${link.targetUrl}`;
        if (link.finalUrl !== null && link.finalUrl !== link.targetUrl) {
          line += ` → ${link.finalUrl}`;
        }
        addLogLine(line, LOG_CLASS[classOf(link)]);
      }
    }
    for (const seed of data.processedSeeds) {
      if (!data.partialSeeds.includes(seed)) {
        state.doneSeeds.add(seed);
      }
    }
    for (const seed of data.invalidSeeds) {
      state.invalidSeeds.push(seed);
    }
  }

  function countBy(links) {
    const counts = { ok: 0, warn: 0, bad: 0, err: 0, blocked: 0 };
    for (const link of links.values()) {
      counts[classOf(link)] += 1;
    }
    return counts;
  }

  function failedPagesOf(pages) {
    return [...pages.values()].filter((page) => page.selectorUsed === null);
  }

  function updateProgress() {
    const done = state.doneSeeds.size + state.failedSeeds.size;
    const pct = state.totalSeeds === 0 ? 0 : Math.round((done / state.totalSeeds) * 100);
    barEl.style.width = `${pct}%`;
    pctEl.textContent = `${pct}%`;
    progressBar.setAttribute('aria-valuenow', String(pct));
    const elapsed = Date.now() - state.startedAt;
    if (done > 0 && done < state.totalSeeds) {
      const remaining = (elapsed / done) * (state.totalSeeds - done);
      etaEl.textContent = `${formatDuration(elapsed)} elapsed · ~${formatDuration(remaining)} left`;
    } else {
      etaEl.textContent = `${formatDuration(elapsed)} elapsed`;
    }
    renderCounters(state);
  }

  function renderCounters(source) {
    const counts = countBy(source.links);
    const done = source.doneSeeds.size;
    const items = [
      ['Pages', `${done.toLocaleString()} / ${source.totalSeeds.toLocaleString()}`, 'accent'],
      ['Links checked', source.links.size.toLocaleString(), ''],
      ['OK', counts.ok.toLocaleString(), 'ok'],
      ['Redirects', counts.warn.toLocaleString(), 'warn'],
      ['Broken', counts.bad.toLocaleString(), 'bad'],
      ['Errors', counts.err.toLocaleString(), 'err'],
      ['Bot-protected', counts.blocked.toLocaleString(), 'blocked'],
      ['Page failures', failedPagesOf(source.pages).length.toLocaleString(), 'err'],
    ];
    countersEl.textContent = '';
    for (const [label, value, tone] of items) {
      countersEl.appendChild(
        el('div', { class: `stat ${tone}` }, [
          el('div', { class: 'label' }, [el('span', { class: 'dot' }), label]),
          el('div', { class: 'value', text: value }),
        ]),
      );
    }
  }

  async function runAudit(seeds) {
    const settings = {
      requestsPerSecond: clampNumber(rpsInput.value, 2, 0.1, 20),
      concurrency: clampNumber(concurrencyInput.value, 10, 1, 10),
      timeoutSeconds: clampNumber(timeoutInput.value, 10, 1, 15),
      batchSize: clampNumber(batchInput.value, 3, 1, 12),
      scopeFilter: scope === '' ? undefined : scope,
    };

    const attempts = new Map();
    let queue = seeds.map((url) => ({ url }));
    let batchIndex = 0;

    while (queue.length > 0 && !state.aborted) {
      const batch = queue.splice(0, settings.batchSize);
      batchIndex += 1;
      setStatus(
        `Batch ${batchIndex}: checking ${plural(batch.length, 'page')} — ${plural(queue.length, 'page')} queued`,
        '',
        true,
      );

      const response = await fetch('/api/audit', {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify({
          seedUrls: batch.map((item) => item.url),
          skipTargets: [...state.targets].slice(-5000),
          requestsPerSecond: settings.requestsPerSecond,
          concurrency: settings.concurrency,
          timeoutSeconds: settings.timeoutSeconds,
          scopeFilter: settings.scopeFilter,
          requestHeaders: reqHeadersInput.value.trim() || undefined,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(
          (payload && payload.error) || `Request failed with HTTP ${response.status}`,
        );
      }

      const data = await response.json();
      mergeBatch(data);

      const retry = [];
      for (const url of data.unprocessedSeeds.concat(data.partialSeeds)) {
        const count = (attempts.get(url) || 0) + 1;
        attempts.set(url, count);
        if (count <= 3) {
          retry.push({ url });
        } else {
          state.failedSeeds.add(url);
        }
      }
      queue = retry.concat(queue);
      updateProgress();
      renderResults(snapshotOf(state));
      resultsCard.hidden = false;
    }
  }

  function snapshotOf(source) {
    return {
      pages: new Map(source.pages),
      links: new Map(source.links),
      doneSeeds: new Set(source.doneSeeds),
      failedSeeds: new Set(source.failedSeeds),
      invalidSeeds: source.invalidSeeds.slice(),
      totalSeeds: source.totalSeeds,
      aborted: source.aborted,
      error: null,
      running: !source.finished,
    };
  }

  function setRunning(running) {
    document.body.classList.toggle('running', running);
    startBtn.disabled = running;
    stopBtn.hidden = !running;
    fileInput.disabled = running;
    urlsInput.disabled = running;
  }

  async function startAudit() {
    if (state) {
      return;
    }
    const seeds = parseSeedList();
    if (seeds.length === 0) {
      countHint.textContent = inputMode === 'file'
        ? 'Upload a .csv or .txt file with URLs first.'
        : 'Paste at least one URL first.';
      countHint.style.color = 'var(--bad)';
      setTimeout(() => {
        countHint.style.color = '';
      }, 1800);
      return;
    }

    state = {
      pages: new Map(),
      links: new Map(),
      targets: new Set(),
      doneSeeds: new Set(),
      failedSeeds: new Set(),
      invalidSeeds: [],
      aborted: false,
      finished: false,
      totalSeeds: seeds.length,
      startedAt: Date.now(),
    };
    controller = new AbortController();

    setRunning(true);
    progressCard.hidden = false;
    progressTitle.textContent = 'Auditing';
    resultsCard.hidden = true;
    logLines = 0;
    logEl.textContent = '';
    logEl.appendChild(el('div', { class: 'muted', text: 'Waiting for the first batch…' }));
    logCountEl.textContent = '';
    countHint.textContent = `Auditing ${plural(seeds.length, 'page')}…`;
    activeTab = 'overview';
    selectTab('overview');
    updateProgress();
    progressCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const ticker = setInterval(() => {
      if (state) {
        updateProgress();
      }
    }, 1000);

    let error = null;
    try {
      await runAudit(seeds);
    } catch (runError) {
      if (!state.aborted) {
        error = runError;
      }
    }
    clearInterval(ticker);
    finish(error);
  }

  function finish(error) {
    state.finished = true;
    updateProgress();
    const snapshot = snapshotOf(state);
    snapshot.error = error;
    const elapsed = formatDuration(Date.now() - state.startedAt);
    if (error) {
      progressTitle.textContent = 'Audit failed';
      setStatus(error.message, 'error');
    } else if (snapshot.aborted) {
      progressTitle.textContent = 'Audit stopped';
      setStatus('Stopped — the results below are partial.', 'warn');
    } else {
      progressTitle.textContent = 'Audit complete';
      setStatus(
        `${plural(snapshot.doneSeeds.size, 'page')} and ${plural(snapshot.links.size, 'link')} checked in ${elapsed}.`,
        'good',
      );
    }
    etaEl.textContent = `Took ${elapsed}`;
    if (snapshot.failedSeeds.size > 0) {
      addLogLine(`Gave up on ${plural(snapshot.failedSeeds.size, 'page')} after repeated partial batches.`, 'se');
    }
    if (snapshot.invalidSeeds.length > 0) {
      addLogLine(
        `Skipped ${plural(snapshot.invalidSeeds.length, 'invalid URL')}, e.g. ${snapshot.invalidSeeds[0]}`,
        'se',
      );
    }
    controller = null;
    state = null;
    setRunning(false);
    updateCountHint();
    renderResults(snapshot);
    resultsCard.hidden = false;
  }

  stopBtn.addEventListener('click', () => {
    if (state) {
      state.aborted = true;
      setStatus('Stopping after the current batch…', 'warn', true);
    }
    if (controller) {
      controller.abort();
    }
  });

  startBtn.addEventListener('click', startAudit);

  // ---------- results ------------------------------------------------------

  function selectTab(tab) {
    for (const button of byId('resultTabs').querySelectorAll('button[data-tab]')) {
      button.setAttribute('aria-selected', String(button.getAttribute('data-tab') === tab));
    }
  }

  function brokenGroups(snapshot) {
    const groups = new Map();
    for (const link of snapshot.links.values()) {
      if (!isBroken(link)) {
        continue;
      }
      let group = groups.get(link.targetUrl);
      if (group === undefined) {
        group = { link, pages: [] };
        groups.set(link.targetUrl, group);
      }
      group.pages.push(link.pageUrl);
    }
    return [...groups.values()].sort(
      (a, b) => b.pages.length - a.pages.length || a.link.targetUrl.localeCompare(b.link.targetUrl),
    );
  }

  function renderResults(snapshot) {
    currentSnapshot = snapshot;
    const broken = brokenGroups(snapshot);
    const nBroken = byId('nBroken');
    nBroken.textContent = broken.length.toLocaleString();
    nBroken.classList.toggle('has', broken.length > 0);
    byId('nLinks').textContent = snapshot.links.size.toLocaleString();
    byId('nPages').textContent = snapshot.pages.size.toLocaleString();
    csvBtn.disabled = snapshot.links.size === 0;
    jsonBtn.disabled = snapshot.pages.size === 0;

    summaryEl.textContent = '';
    if (activeTab === 'overview') {
      renderOverview(snapshot, broken);
    } else if (activeTab === 'broken') {
      renderBroken(broken);
    } else if (activeTab === 'links') {
      renderLinks(snapshot);
    } else {
      renderPages(snapshot);
    }
  }

  function renderOverview(snapshot, broken) {
    const failedPages = failedPagesOf(snapshot.pages);
    const counts = countBy(snapshot.links);
    const blockedPages = failedPages.filter((page) => page.fetchError === 'bot_protection').length;

    // Callouts
    if (!snapshot.running && snapshot.links.size > 0 && broken.length === 0 && failedPages.length === 0) {
      summaryEl.appendChild(
        banner('good', 'No broken links found', `All ${plural(snapshot.links.size, 'link')} responded successfully or redirected.`),
      );
    }
    if (blockedPages > 0 || counts.blocked > 0) {
      summaryEl.appendChild(
        banner(
          'info',
          `Bot protection blocked ${plural(blockedPages, 'page')} and ${plural(counts.blocked, 'link check')}`,
          'These are shown as “unverified”, not broken. Cloudflare and similar services often block serverless (datacenter) IPs. Ways around it:',
          [
            'Your own site: add a Cloudflare WAF “Skip” rule for a secret header, then enter it under Settings → Cloudflare & bot protection.',
            'Set SCREAMINGFREED_PROXY on the deployment to route requests through a residential proxy.',
            'Run the CLI on your own machine — it retries blocked pages in a real browser (npm install playwright; --render headful for interactive checks).',
          ],
        ),
      );
    }
    const otherFailed = failedPages.length - blockedPages;
    if (otherFailed > 0) {
      summaryEl.appendChild(
        banner(
          'warn',
          `${plural(otherFailed, 'page')} could not be audited`,
          'Their links were never checked. See the Pages tab for the status code and reason.',
        ),
      );
    }

    const grid = el('div', { class: 'overview' });

    // Health panel
    const checked = snapshot.links.size;
    const healthy = counts.ok + counts.warn;
    const verifiable = checked - counts.blocked;
    const score = verifiable === 0 ? null : Math.round((healthy / verifiable) * 100);
    const healthPanel = el('div', { class: 'panel' }, [el('h3', { text: 'Link health' })]);
    healthPanel.appendChild(
      el('div', { class: 'health' }, [
        ring(score),
        el('div', null, [
          el('div', { class: 'big', text: score === null ? 'No verifiable links yet' : scoreLabel(score) }),
          el('p', {
            text: score === null
              ? 'Links will appear here as batches complete.'
              : `${healthy.toLocaleString()} of ${verifiable.toLocaleString()} verifiable links work.`,
          }),
        ]),
      ]),
    );
    const dl = el('dl', { class: 'kv' });
    for (const [k, v] of [
      ['Pages audited', `${snapshot.doneSeeds.size.toLocaleString()} / ${snapshot.totalSeeds.toLocaleString()}`],
      ['Links checked', checked.toLocaleString()],
      ['Unique broken targets', broken.length.toLocaleString()],
      ['Page failures', failedPages.length.toLocaleString()],
    ]) {
      dl.append(el('dt', { text: k }), el('dd', { text: v }));
    }
    healthPanel.appendChild(dl);
    grid.appendChild(healthPanel);

    // Distribution panel
    const distPanel = el('div', { class: 'panel' }, [el('h3', { text: 'Results by status' })]);
    const bars = el('div', { class: 'bars' });
    const max = Math.max(1, ...Object.values(counts));
    for (const cls of ['ok', 'warn', 'bad', 'err', 'blocked']) {
      const n = counts[cls];
      bars.appendChild(
        el('div', { class: 'bar-row', style: `--tone:${CLASS_INFO[cls].tone}` }, [
          el('span', { class: 'name', text: CLASS_INFO[cls].label }),
          el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${(n / max) * 100}%` })),
          el('span', { class: 'n', text: n.toLocaleString() }),
        ]),
      );
    }
    distPanel.appendChild(bars);

    // Top outcomes (detailed)
    const outcomeCounts = new Map();
    for (const link of snapshot.links.values()) {
      if (classOf(link) !== 'ok') {
        const key = statusLabelFor(link);
        outcomeCounts.set(key, (outcomeCounts.get(key) || 0) + 1);
      }
    }
    const top = [...outcomeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (top.length > 0) {
      distPanel.appendChild(el('h3', { text: 'Most common issues', style: 'margin-top:20px' }));
      distPanel.appendChild(
        el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px' },
          top.map(([label, n]) => el('span', { class: 'tag', text: `${label} · ${n.toLocaleString()}` }))),
      );
    }
    grid.appendChild(distPanel);
    summaryEl.appendChild(grid);

    if (broken.length > 0) {
      const head = el('div', { class: 'card-head', style: 'margin:22px 0 12px' }, [
        el('h2', { text: 'Top broken links', style: 'font-size:15px' }),
        el('button', {
          class: 'btn sm',
          type: 'button',
          text: `View all ${broken.length.toLocaleString()}`,
          onclick: () => {
            activeTab = 'broken';
            selectTab('broken');
            renderResults(currentSnapshot);
          },
        }),
      ]);
      summaryEl.appendChild(head);
      summaryEl.appendChild(brokenTable(broken.slice(0, 8)));
    }
  }

  function scoreLabel(score) {
    if (score >= 98) {
      return 'Excellent';
    }
    if (score >= 90) {
      return 'Good';
    }
    if (score >= 75) {
      return 'Needs attention';
    }
    return 'Poor';
  }

  function ring(score) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 120 120');
    svg.setAttribute('class', 'ring');
    const r = 50;
    const c = 2 * Math.PI * r;
    const tone = score === null ? 'var(--surface-3)'
      : score >= 90 ? 'var(--ok)' : score >= 75 ? 'var(--warn)' : 'var(--bad)';
    const track = document.createElementNS(SVG_NS, 'circle');
    for (const [k, v] of [['cx', 60], ['cy', 60], ['r', r], ['fill', 'none'], ['stroke-width', 11]]) {
      track.setAttribute(k, String(v));
    }
    track.setAttribute('stroke', 'var(--surface-3)');
    const arc = track.cloneNode();
    arc.setAttribute('stroke', tone);
    arc.setAttribute('stroke-linecap', 'round');
    arc.setAttribute('stroke-dasharray', `${(c * (score || 0)) / 100} ${c}`);
    arc.setAttribute('transform', 'rotate(-90 60 60)');
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', '60');
    text.setAttribute('y', '67');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '24');
    text.setAttribute('font-weight', '700');
    text.setAttribute('fill', 'var(--text)');
    text.textContent = score === null ? '—' : `${score}%`;
    svg.append(track, arc, text);
    return svg;
  }

  function urlCell(url, finalUrl) {
    return el('td', { class: 'url' }, [
      el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: url }),
      finalUrl && finalUrl !== url ? el('span', { class: 'redir', text: `→ ${finalUrl}` }) : null,
    ]);
  }

  function table(headers, rows) {
    return el('div', { class: 'table-wrap' },
      el('table', null, [
        el('thead', null, el('tr', null, headers.map((h) => el('th', { text: h })))),
        el('tbody', null, rows),
      ]));
  }

  function emptyState(title, text, good) {
    return el('div', { class: 'empty' }, [
      el('div', {
        class: 'ico',
        style: good ? null : 'background:var(--surface-2);color:var(--muted)',
      }, icon(good ? ICONS.check : ICONS.info, 22)),
      el('b', { text: title }),
      text,
    ]);
  }

  function searchToolbar(key, placeholder, extra) {
    const input = el('input', {
      type: 'search',
      placeholder,
      value: tableFilters[key].q,
      'aria-label': placeholder,
    });
    input.addEventListener('input', () => {
      tableFilters[key].q = input.value;
      const pos = input.selectionStart;
      renderResults(currentSnapshot);
      const again = summaryEl.querySelector('input[type="search"]');
      if (again) {
        again.focus();
        again.setSelectionRange(pos, pos);
      }
    });
    return el('div', { class: 'toolbar' }, [input].concat(extra || []));
  }

  function matches(query, ...fields) {
    const q = query.trim().toLowerCase();
    return q === '' || fields.some((f) => f && String(f).toLowerCase().includes(q));
  }

  function footer(shown, total) {
    if (shown >= total) {
      return el('div', { class: 'table-foot', text: `${plural(total, 'row')}` });
    }
    return el('div', {
      class: 'table-foot',
      text: `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} rows — narrow the search or download the CSV for everything.`,
    });
  }

  function brokenTable(groups) {
    return table(
      ['Status', 'Broken link', 'Found on', 'Pages'],
      groups.map((group) =>
        el('tr', null, [
          el('td', null, statusPill(group.link)),
          urlCell(group.link.targetUrl, group.link.finalUrl),
          el('td', { class: 'url' }, [
            el('a', { href: group.pages[0], target: '_blank', rel: 'noopener noreferrer', text: group.pages[0] }),
            group.pages.length > 1 ? el('span', { class: 'redir', text: `+ ${plural(group.pages.length - 1, 'more page')}` }) : null,
          ]),
          el('td', { class: 'num', text: String(group.pages.length) }),
        ])),
    );
  }

  function renderBroken(broken) {
    if (broken.length === 0) {
      summaryEl.appendChild(
        currentSnapshot.links.size === 0
          ? emptyState('No links checked yet', 'Results appear here as batches complete.', false)
          : emptyState('No broken links', 'Every checked link responded or redirected successfully.', true),
      );
      return;
    }
    const filtered = broken.filter((g) =>
      matches(tableFilters.broken.q, g.link.targetUrl, g.link.outcome, g.link.httpStatus, ...g.pages));
    summaryEl.appendChild(searchToolbar('broken', 'Search broken links or pages…'));
    summaryEl.appendChild(brokenTable(filtered.slice(0, MAX_TABLE_ROWS)));
    summaryEl.appendChild(footer(Math.min(filtered.length, MAX_TABLE_ROWS), filtered.length));
  }

  function renderLinks(snapshot) {
    if (snapshot.links.size === 0) {
      summaryEl.appendChild(emptyState('No links checked yet', 'Results appear here as batches complete.', false));
      return;
    }
    const select = el('select', { 'aria-label': 'Filter by status' }, [
      el('option', { value: '', text: 'All statuses' }),
    ].concat(['ok', 'warn', 'bad', 'err', 'blocked'].map((cls) =>
      el('option', { value: cls, text: CLASS_INFO[cls].label, selected: tableFilters.links.cls === cls })),
    ));
    select.addEventListener('change', () => {
      tableFilters.links.cls = select.value;
      renderResults(currentSnapshot);
    });
    const filtered = [...snapshot.links.values()].filter((link) =>
      (tableFilters.links.cls === '' || classOf(link) === tableFilters.links.cls) &&
      matches(tableFilters.links.q, link.targetUrl, link.pageUrl, link.anchorText, link.outcome, link.finalUrl));
    summaryEl.appendChild(searchToolbar('links', 'Search URLs, pages or anchor text…', [select]));
    summaryEl.appendChild(
      table(
        ['Status', 'Link', 'Anchor text', 'Scope', 'Found on'],
        filtered.slice(0, MAX_TABLE_ROWS).map((link) =>
          el('tr', null, [
            el('td', null, statusPill(link)),
            urlCell(link.targetUrl, link.finalUrl),
            el('td', { class: 'anchor', text: link.anchorText || '—' }),
            el('td', null, el('span', { class: 'tag', text: link.scope })),
            el('td', { class: 'url dim', text: link.pageUrl }),
          ])),
      ),
    );
    summaryEl.appendChild(footer(Math.min(filtered.length, MAX_TABLE_ROWS), filtered.length));
  }

  function renderPages(snapshot) {
    if (snapshot.pages.size === 0) {
      summaryEl.appendChild(emptyState('No pages audited yet', 'Pages appear here as batches complete.', false));
      return;
    }
    const linksPerPage = new Map();
    const brokenPerPage = new Map();
    for (const link of snapshot.links.values()) {
      linksPerPage.set(link.pageUrl, (linksPerPage.get(link.pageUrl) || 0) + 1);
      if (isBroken(link)) {
        brokenPerPage.set(link.pageUrl, (brokenPerPage.get(link.pageUrl) || 0) + 1);
      }
    }
    const pages = [...snapshot.pages.values()]
      .filter((page) => matches(tableFilters.pages.q, page.url, page.fetchError, page.selectorUsed))
      .sort((a, b) =>
        Number(b.selectorUsed === null) - Number(a.selectorUsed === null) ||
        (brokenPerPage.get(b.url) || 0) - (brokenPerPage.get(a.url) || 0) ||
        a.url.localeCompare(b.url));
    summaryEl.appendChild(searchToolbar('pages', 'Search pages…'));
    summaryEl.appendChild(
      table(
        ['Page', 'Status', 'Content found via', 'Links', 'Broken'],
        pages.slice(0, MAX_TABLE_ROWS).map((page) => {
          let status;
          if (page.selectorUsed === null) {
            const blocked = page.fetchError === 'bot_protection';
            status = el('span', {
              class: `pill ${blocked ? 'blocked' : 'bad'}`,
              text: `${blocked ? 'Blocked' : (page.fetchError || 'Failed').replace(/_/g, ' ')}${page.httpStatus ? ` ${page.httpStatus}` : ''}`,
            });
          } else {
            status = el('span', { class: 'pill ok', text: String(page.httpStatus || 'OK') });
          }
          const nBroken = brokenPerPage.get(page.url) || 0;
          return el('tr', null, [
            urlCell(page.url, null),
            el('td', null, status),
            el('td', null, page.selectorUsed ? el('code', { text: page.selectorUsed }) : el('span', { class: 'sub', text: '—' })),
            el('td', { class: 'num', text: String(linksPerPage.get(page.url) || 0) }),
            el('td', { class: 'num' }, nBroken > 0 ? el('span', { class: 'pill bad', text: String(nBroken) }) : '0'),
          ]);
        }),
      ),
    );
    summaryEl.appendChild(footer(Math.min(pages.length, MAX_TABLE_ROWS), pages.length));
  }

  // ---------- downloads -----------------------------------------------------

  function csvEscape(value) {
    const text = value === null || value === undefined ? '' : String(value);
    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  function downloadFile(content, fileName, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function stamp() {
    return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  }

  csvBtn.addEventListener('click', () => {
    if (!currentSnapshot) {
      return;
    }
    const lines = [CSV_COLUMNS.map(([column]) => column).join(',')];
    for (const link of currentSnapshot.links.values()) {
      lines.push(CSV_COLUMNS.map(([, key]) => csvEscape(link[key])).join(','));
    }
    downloadFile(`${lines.join('\n')}\n`, `screamingfreed-${stamp()}.csv`, 'text/csv');
  });

  jsonBtn.addEventListener('click', () => {
    if (!currentSnapshot) {
      return;
    }
    const payload = {
      pages: [...currentSnapshot.pages.values()],
      links: [...currentSnapshot.links.values()],
    };
    downloadFile(JSON.stringify(payload, null, 2), `screamingfreed-${stamp()}.json`, 'application/json');
  });

  updateCountHint();
})();
