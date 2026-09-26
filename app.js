/* ScreamingFreed web UI — parses the uploaded URL list in the browser,
 * chunks it into small batches and calls POST /api/audit for each batch
 * (a serverless function). All results are held in the browser and can be
 * downloaded as CSV or JSON. */
'use strict';

(function () {
  const byId = (id) => document.getElementById(id);

  const fileInput = byId('file');
  const urlsInput = byId('urls');
  const rpsInput = byId('rps');
  const concurrencyInput = byId('concurrency');
  const timeoutInput = byId('timeout');
  const batchInput = byId('batch');
  const scopeInput = byId('scope');
  const tokenInput = byId('token');
  const startBtn = byId('start');
  const stopBtn = byId('stop');
  const statusEl = byId('status');
  const barEl = byId('bar');
  const countersEl = byId('counters');
  const logEl = byId('log');
  const resultsCard = byId('resultsCard');
  const summaryEl = byId('summary');
  const csvBtn = byId('csv');
  const jsonBtn = byId('json');

  const CSV_COLUMNS = [
    'page_url', 'target_url', 'final_url', 'anchor_text', 'scope',
    'http_status', 'outcome', 'redirect_hops', 'method_used', 'checked_at',
  ];
  const MAX_LOG_LINES = 400;

  let state = null;
  let controller = null;
  let fileText = '';
  let fileIsCsv = false;

  // ---------- helpers ------------------------------------------------------

  function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(Math.max(parsed, min), max);
  }

  function setStatus(message, kind) {
    statusEl.textContent = message;
    statusEl.className = kind || '';
  }

  function firstCsvColumn(line) {
    const column = (line.split(',')[0] || '').trim();
    if (column.length >= 2 && column.startsWith('"') && column.endsWith('"')) {
      return column.slice(1, -1);
    }
    return column;
  }

  function addLogLine(text, cssClass) {
    while (logEl.children.length > 0 && logEl.children[0].classList.contains('muted')) {
      logEl.removeChild(logEl.children[0]);
    }
    const line = document.createElement('div');
    if (cssClass) {
      line.className = cssClass;
    }
    line.textContent = text;
    logEl.appendChild(line);
    while (logEl.children.length > MAX_LOG_LINES) {
      logEl.removeChild(logEl.children[0]);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  function statusClassFor(link) {
    if (link.httpStatus === null) {
      return 'se';
    }
    if (link.httpStatus < 300) {
      return 's2';
    }
    if (link.httpStatus < 400) {
      return 's3';
    }
    return 's4';
  }

  function statusLabelFor(link) {
    if (link.httpStatus === null) {
      return link.outcome;
    }
    return String(link.httpStatus);
  }

  // ---------- seed collection ---------------------------------------------

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      fileText = '';
      fileIsCsv = false;
      return;
    }
    fileText = await file.text();
    fileIsCsv = file.name.toLowerCase().endsWith('.csv');
    const count = parseSeedList().length;
    setStatus(`Loaded ${file.name} (${count} URL${count === 1 ? '' : 's'}).`, 'good');
  });

  function parseSeedList() {
    let entries;
    if (fileText !== '') {
      entries = [];
      for (const rawLine of fileText.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0) {
          continue;
        }
        entries.push(fileIsCsv ? firstCsvColumn(line) : line);
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
      seen.add(entry);
      seeds.push(entry);
    }
    return seeds;
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
    }
    for (const link of data.links) {
      const key = `${link.pageUrl}\u0000${link.targetUrl}`;
      if (!state.links.has(key)) {
        state.links.set(key, link);
        state.targets.add(link.targetUrl);
        let line = `${statusLabelFor(link).padEnd(14)} ${link.targetUrl}`;
        if (link.finalUrl !== null && link.finalUrl !== link.targetUrl) {
          line += ` -> ${link.finalUrl}`;
        }
        addLogLine(line, statusClassFor(link));
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

  function updateProgress() {
    const done = state.doneSeeds.size;
    const pct = state.totalSeeds === 0 ? 0 : Math.round((done / state.totalSeeds) * 100);
    barEl.style.width = `${pct}%`;
    renderCounters();
  }

  function renderCounters() {
    const buckets = { s2: 0, s3: 0, s4: 0, se: 0 };
    for (const link of state.links.values()) {
      buckets[statusClassFor(link)] += 1;
    }
    const badges = [
      ['Pages', `${state.doneSeeds.size}/${state.totalSeeds}`, ''],
      ['Links', String(state.links.size), ''],
      ['2xx', String(buckets.s2), 'ok'],
      ['3xx', String(buckets.s3), 'warn'],
      ['4xx/5xx', String(buckets.s4), 'bad'],
      ['network errors', String(buckets.se), 'err'],
    ];
    countersEl.textContent = '';
    for (const [label, value, cls] of badges) {
      const badge = document.createElement('span');
      badge.className = cls === '' ? 'badge' : `badge ${cls}`;
      badge.textContent = `${label}: ${value}`;
      countersEl.appendChild(badge);
    }
  }

  async function runAudit(seeds) {
    const settings = {
      requestsPerSecond: clampNumber(rpsInput.value, 2, 0.1, 20),
      concurrency: clampNumber(concurrencyInput.value, 10, 1, 10),
      timeoutSeconds: clampNumber(timeoutInput.value, 10, 1, 15),
      batchSize: clampNumber(batchInput.value, 3, 1, 12),
      scopeFilter: scopeInput.value === '' ? undefined : scopeInput.value,
    };

    const attempts = new Map();
    let queue = seeds.map((url) => ({ url }));
    let batchIndex = 0;

    while (queue.length > 0 && !state.aborted) {
      const batch = queue.splice(0, settings.batchSize);
      batchIndex += 1;
      setStatus(
        `Batch ${batchIndex}: auditing ${batch.length} page(s) — ${queue.length} page(s) queued`,
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
    }
  }

  async function startAudit() {
    if (state) {
      return;
    }
    const seeds = parseSeedList();
    if (seeds.length === 0) {
      setStatus('No URLs found — upload a file or paste URLs first.', 'warn');
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
      totalSeeds: seeds.length,
    };
    controller = new AbortController();

    startBtn.disabled = true;
    stopBtn.disabled = false;
    resultsCard.hidden = true;
    logEl.textContent = '';
    barEl.style.width = '0%';
    countersEl.textContent = '';

    let error = null;
    try {
      await runAudit(seeds);
    } catch (runError) {
      if (!state.aborted) {
        error = runError;
      }
    }
    finish(error);
  }

  function finish(error) {
    const snapshot = {
      pages: new Map(state.pages),
      links: new Map(state.links),
      doneSeeds: new Set(state.doneSeeds),
      failedSeeds: new Set(state.failedSeeds),
      invalidSeeds: state.invalidSeeds.slice(),
      totalSeeds: state.totalSeeds,
      aborted: state.aborted,
    };
    if (error) {
      setStatus(`Audit failed: ${error.message}`, 'error');
    } else if (snapshot.aborted) {
      setStatus('Audit stopped — results below are partial.', 'warn');
    } else {
      setStatus(
        `Audit complete — ${snapshot.doneSeeds.size}/${snapshot.totalSeeds} page(s) audited.`,
        'good',
      );
    }
    const failed = snapshot.failedSeeds.size;
    if (failed > 0) {
      addLogLine(`Gave up on ${failed} page(s) after repeated partial batches.`, 'se');
    }
    const invalid = snapshot.invalidSeeds.length;
    if (invalid > 0) {
      addLogLine(
        `Skipped ${invalid} invalid seed URL(s), e.g. ${snapshot.invalidSeeds[0]}`,
        'se',
      );
    }
    startBtn.disabled = false;
    stopBtn.disabled = true;
    controller = null;
    renderSummary(snapshot);
    resultsCard.hidden = false;
    state = null;
  }

  stopBtn.addEventListener('click', () => {
    if (state) {
      state.aborted = true;
    }
    if (controller) {
      controller.abort();
    }
  });

  startBtn.addEventListener('click', startAudit);

  // ---------- summary and downloads ---------------------------------------

  function makeTable(headers, rows) {
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const header of headers) {
      const th = document.createElement('th');
      th.textContent = header;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const cell of row) {
        const td = document.createElement('td');
        td.textContent = cell === null || cell === undefined ? '' : String(cell);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }

  function renderSummary(snapshot) {
    summaryEl.textContent = '';

    const totals = document.createElement('p');
    totals.textContent =
      `Pages audited: ${snapshot.pages.size} — Links checked: ${snapshot.links.size}`;
    summaryEl.appendChild(totals);

    const counts = new Map();
    for (const link of snapshot.links.values()) {
      counts.set(link.outcome, (counts.get(link.outcome) || 0) + 1);
    }
    const countRows = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([outcome, count]) => [outcome, String(count)]);
    if (countRows.length > 0) {
      const heading = document.createElement('p');
      heading.textContent = 'Outcome breakdown:';
      summaryEl.appendChild(heading);
      summaryEl.appendChild(makeTable(['outcome', 'count'], countRows));
    }

    const broken = new Map();
    for (const link of snapshot.links.values()) {
      if (link.httpStatus !== null && link.httpStatus < 400) {
        continue;
      }
      const existing = broken.get(link.targetUrl);
      if (existing === undefined) {
        broken.set(link.targetUrl, {
          targetUrl: link.targetUrl,
          httpStatus: link.httpStatus,
          outcome: link.outcome,
          occurrences: 1,
          examplePage: link.pageUrl,
        });
      } else {
        existing.occurrences += 1;
        if (link.pageUrl < existing.examplePage) {
          existing.examplePage = link.pageUrl;
        }
      }
    }
    const brokenRows = [...broken.values()]
      .sort((a, b) => b.occurrences - a.occurrences || a.targetUrl.localeCompare(b.targetUrl))
      .slice(0, 20)
      .map((item) => [
        item.targetUrl,
        item.httpStatus === null ? '' : String(item.httpStatus),
        item.outcome,
        String(item.occurrences),
        item.examplePage,
      ]);
    const brokenHeading = document.createElement('p');
    brokenHeading.textContent = brokenRows.length > 0
      ? 'Broken links (top 20):'
      : 'No broken links found.';
    summaryEl.appendChild(brokenHeading);
    if (brokenRows.length > 0) {
      summaryEl.appendChild(
        makeTable(
          ['target', 'status', 'outcome', 'occurrences', 'example page'],
          brokenRows,
        ),
      );
    }

    csvBtn.disabled = snapshot.links.size === 0;
    jsonBtn.disabled = snapshot.links.size === 0;
    currentSnapshot = snapshot;
  }

  let currentSnapshot = null;

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
    URL.revokeObjectURL(link.href);
  }

  csvBtn.addEventListener('click', () => {
    if (!currentSnapshot) {
      return;
    }
    const lines = [CSV_COLUMNS.join(',')];
    for (const link of currentSnapshot.links.values()) {
      lines.push(CSV_COLUMNS.map((column) => csvEscape(link[column])).join(','));
    }
    downloadFile(`${lines.join('\n')}\n`, 'screamingfreed-report.csv', 'text/csv');
  });

  jsonBtn.addEventListener('click', () => {
    if (!currentSnapshot) {
      return;
    }
    const payload = {
      pages: [...currentSnapshot.pages.values()],
      links: [...currentSnapshot.links.values()],
    };
    downloadFile(
      JSON.stringify(payload, null, 2),
      'screamingfreed-report.json',
      'application/json',
    );
  });
})();