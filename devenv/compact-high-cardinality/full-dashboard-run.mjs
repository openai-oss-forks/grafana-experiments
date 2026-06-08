import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';

import { buildCompactResponse } from './compact-v1.mjs';
import { createFullDashboardFixture, DASHBOARD_UID, DATASOURCE_UID } from './fixtures.mjs';
import { buildJsonResponse } from './json-response.mjs';

const COMPACT_HEADER = 'x-grafana-query-format';
const COMPACT_MEDIA_TYPE = 'application/vnd.grafana.querydata.compact;version=1';
const JSON_MEDIA_TYPE = 'application/json';

const dashboardJson = process.env.DASHBOARD_JSON;
if (!dashboardJson || process.argv.includes('--help')) {
  console.log(`Usage: DASHBOARD_JSON=/path/to/dashboard.json node devenv/compact-high-cardinality/full-dashboard-run.mjs

Environment:
  GRAFANA_URL             Local Grafana URL (default: http://127.0.0.1:3000)
  RESPONSE_FORMAT         auto or legacy-json (default: auto)
  SERIES_PER_QUERY        Generated series for each query (default: 20)
  POINT_COUNT             Samples generated for each series (default: 120)
  SCROLL_STEP_VIEWPORTS   Scroll distance in viewport heights (default: 0.8)
  SCROLL_SETTLE_MS        Delay after layout before checking query idleness (default: 250)
  MAX_SCROLL_STEPS        Stop after this many steps; 0 reaches the bottom (default: 0)
  SAMPLE_EVERY            Retain a full sample every N steps (default: 5)
  GC_MODE                 none or retained (default: none)
  OFFSCREEN_SETTLE_MS     Wait at the bottom before the final sample (default: 0)
  HEAP_SNAPSHOT           Set to 1 to capture the active dashboard heap
  HEADLESS                Set to 1 for headless Chromium
  CHROMIUM_PATH           Optional Chromium executable
  OUTPUT_DIR              Artifact directory (default: /tmp/grafana-compact-full-dashboard)`);
  process.exit(dashboardJson ? 0 : 1);
}

const options = {
  baseUrl: process.env.GRAFANA_URL ?? 'http://127.0.0.1:3000',
  username: process.env.GRAFANA_USER ?? 'admin',
  password: process.env.GRAFANA_PASSWORD ?? 'admin',
  responseFormat: readResponseFormat(),
  seriesPerQuery: readPositiveInteger('SERIES_PER_QUERY', 20),
  pointCount: readPositiveInteger('POINT_COUNT', 120),
  scrollStepViewports: readPositiveNumber('SCROLL_STEP_VIEWPORTS', 0.8),
  scrollSettleMs: readNonNegativeInteger('SCROLL_SETTLE_MS', 250),
  maxScrollSteps: readNonNegativeInteger('MAX_SCROLL_STEPS', 0),
  sampleEvery: readPositiveInteger('SAMPLE_EVERY', 5),
  gcMode: readGcMode(),
  offscreenSettleMs: readNonNegativeInteger('OFFSCREEN_SETTLE_MS', 0),
  heapSnapshot: process.env.HEAP_SNAPSHOT === '1',
  headless: process.env.HEADLESS === '1',
  chromiumPath: process.env.CHROMIUM_PATH,
  outputDir: process.env.OUTPUT_DIR ?? '/tmp/grafana-compact-full-dashboard',
};

const fixture = await createFullDashboardFixture(dashboardJson, options.pointCount);
await fs.mkdir(options.outputDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: options.chromiumPath ?? chromium.executablePath(),
  headless: options.headless,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const context = await browser.newContext({ viewport: { width: 1800, height: 1100 } });
await installCanvasActivityProbe(context);
await installResponseMode(context);
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');

const queryRequests = [];
const pageErrors = [];
let activeRequests = 0;
let lastRequestActivityAt = performance.now();

page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
page.on('console', (message) => {
  if (message.type() === 'error') {
    pageErrors.push(`console: ${message.text()}`);
  }
});

await context.route('**/api/ds/query**', async (route) => {
  const request = route.request();
  const headers = request.headers();
  if (headers['x-dashboard-uid'] !== DASHBOARD_UID) {
    await route.continue();
    return;
  }

  activeRequests++;
  lastRequestActivityAt = performance.now();
  const requestNumber = queryRequests.length + 1;
  try {
    const requestBody = parseQueryRequest(request.postData());
    const refIds = requestBody.queries.map((query) => query.refId);
    const preferredFormat = headers[COMPACT_HEADER];
    const requestedFormat = preferredFormat ?? 'json';
    if (options.responseFormat === 'legacy-json' && preferredFormat != null) {
      throw new Error('Legacy JSON benchmark unexpectedly requested compact-v1');
    }
    const responseFormat = requestedFormat;
    const compact = responseFormat === 'compact-v1';
    const startedAt = performance.now();
    const responseOptions = {
      refIds,
      seriesPerQuery: options.seriesPerQuery,
      pointCount: options.pointCount,
      from: Number(requestBody.from),
      to: Number(requestBody.to),
      gappedSeriesEvery: 8,
      gapEvery: 17,
      seed: stableSeed(headers['x-panel-id'], refIds, requestBody.from, requestBody.to),
    };
    const response = compact ? buildCompactResponse(responseOptions) : buildJsonResponse(responseOptions);
    const generatedAt = performance.now();
    const responseBody = Buffer.from(response);
    const rawResponseBytes = responseBody.byteLength;

    queryRequests.push({
      requestNumber,
      panelId: headers['x-panel-id'],
      panelPluginId: headers['x-panel-plugin-id'],
      requestedFormat,
      responseFormat,
      refIds,
      from: requestBody.from,
      to: requestBody.to,
      queryCount: refIds.length,
      seriesCount: refIds.length * options.seriesPerQuery,
      pointCount: options.pointCount,
      rawResponseBytes,
      generationMs: round(generatedAt - startedAt),
    });

    await route.fulfill({
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-type': compact ? COMPACT_MEDIA_TYPE : JSON_MEDIA_TYPE,
        vary: 'X-Grafana-Query-Format, Accept-Encoding',
      },
      body: responseBody,
    });
  } catch (error) {
    queryRequests.push({
      requestNumber,
      panelId: headers['x-panel-id'],
      panelPluginId: headers['x-panel-plugin-id'],
      error: error instanceof Error ? error.message : String(error),
    });
    await route.fulfill({
      status: 500,
      contentType: JSON_MEDIA_TYPE,
      body: JSON.stringify({ message: 'Local dashboard fixture failed to generate a response' }),
    });
  } finally {
    activeRequests--;
    lastRequestActivityAt = performance.now();
  }
});

const report = {
  config: { ...options, password: '<redacted>' },
  fixture: fixture.source,
  executionMode: 'optimize',
  telemetryMode: 'degraded-cdp',
  browser: await browser.version(),
  queryRequests,
  samples: [],
  pageErrors,
};

try {
  await login(context);
  await ensureDatasource(context);
  await putDashboard(context, fixture.dashboard);
  report.baseline = await collectBrowserSample(cdp, page, 'pre-dashboard', true);

  const dashboardUrl = `${options.baseUrl}/d/${DASHBOARD_UID}/full-dashboard-local?orgId=1&from=now-1h&to=now`;
  const navigationStartedAt = performance.now();
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitForQueryIdle(120_000);
  await waitForCanvasIdle(page, 120_000);
  await waitForVisibleCharts(page);
  report.navigationMs = round(performance.now() - navigationStartedAt);
  report.samples.push(await collectBrowserSample(cdp, page, 'scroll-0', options.gcMode === 'retained'));
  report.interactions = {
    initial: await verifyVisibleChartInteraction(page),
  };

  const scroll = await scrollDashboard(page, cdp, report);
  report.scroll = scroll;
  if (scroll.reachedBottom) {
    report.interactions.bottom = await verifyVisibleChartInteraction(page);
  }

  if (options.offscreenSettleMs > 0) {
    await page.waitForTimeout(options.offscreenSettleMs);
    await waitForQueryIdle(120_000);
    await waitForCanvasIdle(page, 120_000);
    report.samples.push(await collectBrowserSample(cdp, page, 'offscreen-settled', options.gcMode === 'retained'));
  }

  await page.screenshot({ path: path.join(options.outputDir, 'dashboard-bottom.png') });
  const requestsBeforeReentry = queryRequests.length;
  const reentryStartedAt = performance.now();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await waitForQueryIdle(120_000);
  await waitForCanvasIdle(page, 120_000);
  await waitForVisibleCharts(page);
  report.reentry = {
    durationMs: round(performance.now() - reentryStartedAt),
    additionalRequests: queryRequests.length - requestsBeforeReentry,
  };
  if (report.reentry.additionalRequests !== 0) {
    throw new Error(`Dashboard reentry issued ${report.reentry.additionalRequests} unexpected queries`);
  }
  report.interactions.reentry = await verifyVisibleChartInteraction(page);
  report.samples.push(await collectBrowserSample(cdp, page, 'reentry-top', options.gcMode === 'retained'));
  await page.screenshot({ path: path.join(options.outputDir, 'dashboard-top.png') });

  if (pageErrors.length > 0) {
    throw new Error(`Browser reported errors:\n${pageErrors.join('\n')}`);
  }
  const failedRequests = queryRequests.filter((request) => request.error);
  if (failedRequests.length > 0) {
    throw new Error(`${failedRequests.length} local query responses failed`);
  }
  report.summary = summarize(report);
  if (options.heapSnapshot) {
    report.heapSnapshot = path.join(options.outputDir, 'dashboard.heapsnapshot');
    await takeHeapSnapshot(cdp, report.heapSnapshot);
  }

  report.dashboardUrl = dashboardUrl;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  try {
    await page.screenshot({ path: path.join(options.outputDir, 'dashboard-failure.png') });
  } catch {
    // Preserve the original failure when the browser already exited.
  }
  process.exitCode = 1;
} finally {
  const reportPath = path.join(options.outputDir, 'metrics.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  printReport(report, reportPath);
  await browser.close();
}

async function scrollDashboard(page, cdp, report) {
  const dimensions = await page.evaluate(() => ({
    viewportHeight: window.innerHeight,
    documentHeight: document.documentElement.scrollHeight,
  }));
  const stepPixels = Math.max(1, Math.floor(dimensions.viewportHeight * options.scrollStepViewports));
  const bottom = Math.max(0, dimensions.documentHeight - dimensions.viewportHeight);
  const allPositions = [];
  for (let position = stepPixels; position < bottom; position += stepPixels) {
    allPositions.push(position);
  }
  allPositions.push(bottom);
  const positions = options.maxScrollSteps > 0 ? allPositions.slice(0, options.maxScrollSteps) : allPositions;

  const steps = [];
  for (let index = 0; index < positions.length; index++) {
    const startedAt = performance.now();
    await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), positions[index]);
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        })
    );
    await page.waitForTimeout(options.scrollSettleMs);
    await waitForQueryIdle(120_000);
    await waitForCanvasIdle(page, 120_000);
    await assertNoVisiblePanelErrors(page);
    const light = await collectBrowserSample(cdp, page, `scroll-${index + 1}`, false);
    if (Math.abs(light.dom.scrollY - positions[index]) > 2) {
      throw new Error(`Dashboard stopped at scroll position ${light.dom.scrollY}, expected ${positions[index]}`);
    }
    const step = {
      index: index + 1,
      y: positions[index],
      durationMs: round(performance.now() - startedAt),
      requests: queryRequests.length,
      usedHeapMB: light.usedHeapMB,
      backingStorageMB: light.backingStorageMB,
      dom: light.dom,
    };
    steps.push(step);
    if ((index + 1) % options.sampleEvery === 0 || index === positions.length - 1) {
      report.samples.push(
        await collectBrowserSample(
          cdp,
          page,
          `scroll-${index + 1}${options.gcMode === 'retained' ? '-gc' : ''}`,
          options.gcMode === 'retained'
        )
      );
    }
  }
  return {
    viewportHeight: dimensions.viewportHeight,
    documentHeight: dimensions.documentHeight,
    stepPixels,
    reachedBottom: positions.at(-1) === bottom,
    steps,
  };
}

async function waitForQueryIdle(timeoutMs) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (activeRequests === 0 && performance.now() - lastRequestActivityAt >= 500) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for dashboard queries to become idle (${activeRequests} active)`);
}

async function waitForVisibleCharts(page) {
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.uplot canvas')).some((canvas) => {
        const bounds = canvas.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < window.innerHeight;
      }),
    undefined,
    { timeout: 120_000 }
  );
}

async function waitForCanvasIdle(page, timeoutMs) {
  await page.waitForFunction(
    () => {
      const lastOperationAt = window.__dashboardCanvasActivity?.lastOperationAt ?? 0;
      return performance.now() - lastOperationAt >= 250;
    },
    undefined,
    { timeout: timeoutMs, polling: 50 }
  );
}

async function assertNoVisiblePanelErrors(page) {
  const errors = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="alert"]'))
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.bottom > 0 && bounds.top < window.innerHeight;
      })
      .map((element) => element.textContent?.trim())
      .filter((text) => text && /error|failed|invalid compact/i.test(text))
  );
  if (errors.length > 0) {
    throw new Error(`Visible dashboard panels reported errors: ${errors.join(' | ')}`);
  }
}

async function verifyVisibleChartInteraction(page) {
  const canvases = page.locator('.uplot canvas:visible');
  const count = Math.min(await canvases.count(), 12);
  if (count === 0) {
    throw new Error('No visible chart canvas was available for interaction verification');
  }

  for (let index = 0; index < count; index++) {
    const bounds = await canvases.nth(index).boundingBox();
    if (!bounds) {
      continue;
    }
    await page.mouse.move(1, 1);
    const startedAt = performance.now();
    await page.mouse.move(bounds.x + bounds.width * 0.55, bounds.y + bounds.height * 0.45);
    try {
      await page.waitForFunction(hasVisibleTooltip, undefined, { timeout: 1_000 });
      return {
        hoverToTooltipMs: round(performance.now() - startedAt),
        tooltipVisible: true,
      };
    } catch {
      // Try the next visible chart; some panels intentionally disable tooltips.
    }
  }
  throw new Error('Visible chart canvases did not produce a tooltip');
}

async function collectBrowserSample(cdp, page, label, collectGarbage) {
  if (collectGarbage) {
    await cdp.send('HeapProfiler.collectGarbage');
  }
  const [heapUsage, performanceMetrics, dom] = await Promise.all([
    cdp.send('Runtime.getHeapUsage'),
    cdp.send('Performance.getMetrics'),
    collectDomDiagnostics(page),
  ]);
  const metrics = Object.fromEntries(performanceMetrics.metrics.map(({ name, value }) => [name, value]));
  return {
    label,
    collectedAfterGC: collectGarbage,
    usedHeapMB: bytesToMB(heapUsage.usedSize),
    totalHeapMB: bytesToMB(heapUsage.totalSize),
    embedderHeapMB: bytesToMB(heapUsage.embedderHeapUsedSize),
    backingStorageMB: bytesToMB(heapUsage.backingStorageSize),
    taskDurationSeconds: round(metrics.TaskDuration),
    scriptDurationSeconds: round(metrics.ScriptDuration),
    layoutDurationSeconds: round(metrics.LayoutDuration),
    requestCount: queryRequests.length,
    dom,
  };
}

async function collectDomDiagnostics(page) {
  return page.evaluate(() => {
    const panels = Array.from(document.querySelectorAll('[data-testid^="data-testid Panel header "]'));
    const visiblePanels = panels.filter((panel) => {
      const bounds = panel.getBoundingClientRect();
      return bounds.bottom > 0 && bounds.top < window.innerHeight;
    });
    return {
      nodes: document.getElementsByTagName('*').length,
      canvases: document.querySelectorAll('canvas').length,
      uplots: document.querySelectorAll('.uplot').length,
      legendItems: document.querySelectorAll('[data-testid^="data-testid VizLegend series "]').length,
      legendTableRows: document.querySelectorAll('table tbody tr').length,
      panels: panels.length,
      visiblePanels: visiblePanels.length,
      scrollY: Math.round(window.scrollY),
      documentHeight: document.documentElement.scrollHeight,
    };
  });
}

function summarize(report) {
  const compactRequests = queryRequests.filter((request) => request.responseFormat === 'compact-v1');
  const jsonRequests = queryRequests.filter((request) => request.responseFormat === 'json');
  const samples = report.samples;
  const measurements = [
    ...samples,
    ...report.scroll.steps.map((step) => ({
      usedHeapMB: step.usedHeapMB,
      backingStorageMB: step.backingStorageMB,
      dom: step.dom,
    })),
  ];
  const retainedSamples = samples.filter((sample) => sample.collectedAfterGC);
  return {
    requestCount: queryRequests.length,
    compactRequestCount: compactRequests.length,
    jsonRequestCount: jsonRequests.length,
    totalSeries: queryRequests.reduce((total, request) => total + (request.seriesCount ?? 0), 0),
    rawResponseMB: bytesToMB(queryRequests.reduce((total, request) => total + (request.rawResponseBytes ?? 0), 0)),
    peakUsedHeapMB: Math.max(...measurements.map((sample) => sample.usedHeapMB)),
    peakEmbedderHeapMB: Math.max(...samples.map((sample) => sample.embedderHeapMB)),
    peakBackingStorageMB: Math.max(...measurements.map((sample) => sample.backingStorageMB)),
    peakDomNodes: Math.max(...measurements.map((sample) => sample.dom.nodes)),
    peakUPlots: Math.max(...measurements.map((sample) => sample.dom.uplots)),
    retainedPeak:
      retainedSamples.length > 0
        ? {
            usedHeapMB: Math.max(...retainedSamples.map((sample) => sample.usedHeapMB)),
            backingStorageMB: Math.max(...retainedSamples.map((sample) => sample.backingStorageMB)),
          }
        : undefined,
    requestManifest: queryRequests
      .map((request) => ({
        panelId: request.panelId,
        refIds: request.refIds,
        from: request.from,
        to: request.to,
      }))
      .sort((left, right) => String(left.panelId).localeCompare(String(right.panelId))),
    maxScrollStepMs: Math.max(...report.scroll.steps.map((step) => step.durationMs)),
    medianScrollStepMs: median(report.scroll.steps.map((step) => step.durationMs)),
  };
}

async function installCanvasActivityProbe(context) {
  await context.addInitScript(() => {
    const activity = { lastOperationAt: 0 };
    window.__dashboardCanvasActivity = activity;
    for (const method of ['clearRect', 'stroke', 'fill', 'fillRect', 'strokeRect', 'lineTo', 'arc']) {
      const original = CanvasRenderingContext2D.prototype[method];
      CanvasRenderingContext2D.prototype[method] = function (...args) {
        activity.lastOperationAt = performance.now();
        return original.apply(this, args);
      };
    }
  });
}

async function installResponseMode(context) {
  if (options.responseFormat !== 'legacy-json') {
    return;
  }

  await context.addInitScript(() => {
    window.localStorage.setItem('grafana.featureToggles', 'queryServiceRewrite=1');
  });
}

function hasVisibleTooltip() {
  return Boolean(
    document.querySelector('[data-testid="data-testid viz-tooltip-wrapper"]') ??
      Array.from(document.body.querySelectorAll('div')).find((element) => {
        const style = getComputedStyle(element);
        return style.position === 'fixed' && style.zIndex === '10000' && element.textContent?.trim();
      })
  );
}

async function login(context) {
  const response = await context.request.post(`${options.baseUrl}/login`, {
    data: { user: options.username, password: options.password },
  });
  if (!response.ok()) {
    throw new Error(`Grafana login failed: ${response.status()} ${await response.text()}`);
  }
}

async function ensureDatasource(context) {
  const current = await context.request.get(`${options.baseUrl}/api/datasources/uid/${DATASOURCE_UID}`);
  if (current.ok()) {
    return;
  }
  if (current.status() !== 404) {
    throw new Error(`Datasource lookup failed: ${current.status()} ${await current.text()}`);
  }
  const created = await context.request.post(`${options.baseUrl}/api/datasources`, {
    data: {
      name: 'Compact fixture Prometheus',
      uid: DATASOURCE_UID,
      type: 'prometheus',
      access: 'proxy',
      url: 'http://127.0.0.1:9090',
      isDefault: false,
      jsonData: {
        manageAlerts: false,
        prometheusType: 'Prometheus',
        prometheusVersion: '2.40.0',
      },
    },
  });
  if (!created.ok()) {
    throw new Error(`Datasource creation failed: ${created.status()} ${await created.text()}`);
  }
}

async function putDashboard(context, dashboard) {
  const response = await context.request.post(`${options.baseUrl}/api/dashboards/db`, {
    data: { overwrite: true, dashboard },
  });
  if (!response.ok()) {
    throw new Error(`Dashboard creation failed: ${response.status()} ${await response.text()}`);
  }
}

function parseQueryRequest(postData) {
  if (!postData) {
    throw new Error('Dashboard fixture query has no request body');
  }
  const request = JSON.parse(postData);
  if (!Array.isArray(request.queries) || request.queries.length === 0) {
    throw new Error('Dashboard fixture query is missing queries');
  }
  return request;
}

async function takeHeapSnapshot(cdp, filePath) {
  const output = createWriteStream(filePath, { encoding: 'utf8' });
  const outputError = new Promise((_, reject) => output.once('error', reject));
  const onChunk = ({ chunk }) => output.write(chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  try {
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  } finally {
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  }
  output.end();
  await Promise.race([once(output, 'finish'), outputError]);
}

function printReport(report, reportPath) {
  console.log(`\nFull dashboard local test: ${report.status}`);
  console.log(
    `Panels: ${report.fixture.replayPanelCount}/${report.fixture.originalPanelCount} (${report.fixture.replayTimeSeriesPanelCount} time series)`
  );
  if (report.summary) {
    console.log(
      `Requests: ${report.summary.requestCount} (${report.summary.compactRequestCount} compact, ${report.summary.jsonRequestCount} JSON), series=${report.summary.totalSeries}`
    );
    console.log(`Uncompressed response bytes: ${report.summary.rawResponseMB}MB`);
    console.log(
      `Peak: JS=${report.summary.peakUsedHeapMB}MB embedder=${report.summary.peakEmbedderHeapMB}MB backing=${report.summary.peakBackingStorageMB}MB DOM=${report.summary.peakDomNodes} uPlot=${report.summary.peakUPlots}`
    );
    console.log(
      `Scroll: median=${report.summary.medianScrollStepMs}ms max=${report.summary.maxScrollStepMs}ms reentry=${report.reentry.durationMs}ms requests=${report.reentry.additionalRequests}`
    );
  }
  if (report.interactions) {
    const bottom = report.interactions.bottom ? ` bottom=${report.interactions.bottom.hoverToTooltipMs}ms` : '';
    const reentry = report.interactions.reentry ? ` reentry=${report.interactions.reentry.hoverToTooltipMs}ms` : '';
    console.log(`Interactions: initial=${report.interactions.initial.hoverToTooltipMs}ms${bottom}${reentry}`);
  }
  if (report.error) {
    console.error(report.error);
  }
  console.log(`Metrics: ${reportPath}`);
}

function stableSeed(panelId, refIds, from, to) {
  const value = `${panelId ?? ''}|${refIds.join(',')}|${from ?? ''}|${to ?? ''}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash | 0);
}

function readResponseFormat() {
  const value = process.env.RESPONSE_FORMAT ?? 'auto';
  if (value !== 'auto' && value !== 'legacy-json') {
    throw new Error('RESPONSE_FORMAT must be auto or legacy-json');
  }
  return value;
}

function readGcMode() {
  const value = process.env.GC_MODE ?? 'none';
  if (value !== 'none' && value !== 'retained') {
    throw new Error('GC_MODE must be none or retained');
  }
  return value;
}

function readPositiveInteger(name, defaultValue) {
  const value = readInteger(name, defaultValue);
  if (value < 1) {
    throw new Error(`${name} must be at least 1`);
  }
  return value;
}

function readNonNegativeInteger(name, defaultValue) {
  const value = readInteger(name, defaultValue);
  if (value < 0) {
    throw new Error(`${name} must be non-negative`);
  }
  return value;
}

function readInteger(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return value;
}

function readPositiveNumber(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}

function bytesToMB(value) {
  return round(value / (1024 * 1024));
}

function round(value) {
  return Math.round(value * 100) / 100;
}
