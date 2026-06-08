import fs from 'node:fs/promises';
import path from 'node:path';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

import { chromium } from 'playwright';

import {
  buildCompactResponse,
  buildCompactResponseFromGrafanaJson,
  summarizeGrafanaJsonResponse,
} from './compact-v1.mjs';
import { createDashboardFixture, DASHBOARD_UID, DATASOURCE_UID } from './fixtures.mjs';
import { buildJsonResponse } from './json-response.mjs';

const COMPACT_HEADER = 'x-grafana-query-format';
const COMPACT_MEDIA_TYPE = 'application/vnd.grafana.querydata.compact;version=1';
const COMPACT_BASE_MEDIA_TYPE = 'application/vnd.grafana.querydata.compact';
const JSON_MEDIA_TYPE = 'application/json';

const options = {
  baseUrl: process.env.GRAFANA_URL ?? 'http://127.0.0.1:3000',
  username: process.env.GRAFANA_USER ?? 'admin',
  password: process.env.GRAFANA_PASSWORD ?? 'admin',
  scenario: process.env.SCENARIO ?? 'synthetic',
  dashboardJson: process.env.DASHBOARD_JSON,
  responseJson: process.env.RESPONSE_JSON,
  panelId: process.env.PANEL_ID,
  expectedFormat: readExpectedFormat(),
  responseFormat: readResponseFormat(),
  seriesPerQuery: readPositiveInteger('SERIES_PER_QUERY', 1500),
  pointCount: readPositiveInteger('POINT_COUNT', 360),
  refreshes: readNonNegativeInteger('REFRESHES', 2),
  gappedSeriesEvery: readNonNegativeInteger('GAPPED_SERIES_EVERY', 8),
  gapEvery: readPositiveInteger('GAP_EVERY', 17),
  seed: readNonNegativeInteger('SEED', 1),
  dashboardFrom: readOptionalTimestamp('DASHBOARD_FROM'),
  dashboardTo: readOptionalTimestamp('DASHBOARD_TO'),
  heapSnapshot: process.env.HEAP_SNAPSHOT === '1',
  cpuProfile: process.env.CPU_PROFILE === '1',
  verifyInteractions: process.env.VERIFY_INTERACTIONS === '1',
  hoverSteps: readPositiveInteger('HOVER_STEPS', 12),
  headless: process.env.HEADLESS === '1',
  outputDir: process.env.OUTPUT_DIR ?? '/tmp/grafana-compact-high-cardinality',
  chromiumPath: process.env.CHROMIUM_PATH,
  dashboardUid: process.env.DASHBOARD_UID ?? `${DASHBOARD_UID}-${process.pid}`,
};

if (process.argv.includes('--help')) {
  console.log(`Usage: node devenv/compact-high-cardinality/run.mjs

Environment:
  GRAFANA_URL             Local Grafana URL (default: http://127.0.0.1:3000)
  SCENARIO                Built-in panel: synthetic or single-query (default: synthetic)
  DASHBOARD_JSON          Grafana dashboard export to replay instead of a built-in panel
  RESPONSE_JSON           Captured Grafana JSON response replayed as JSON or encoded as compact-v1
  PANEL_ID                Panel ID selected from DASHBOARD_JSON (default: first timeseries)
  EXPECTED_FORMAT         compact-v1, json, or auto (default: compact-v1)
  RESPONSE_FORMAT         auto, compact-v1, or json (default: auto follows request)
  SERIES_PER_QUERY        Series returned per query refId (default: 1500)
  POINT_COUNT             Samples per series (default: 360)
  REFRESHES               In-place dashboard refreshes after first draw (default: 2)
  GAPPED_SERIES_EVERY     Every Nth series has gaps; 0 disables gaps (default: 8)
  GAP_EVERY               Every Nth sample is absent in gapped series (default: 17)
  SEED                    Deterministic sample seed (default: 1)
  DASHBOARD_FROM          Fixed dashboard start timestamp in milliseconds
  DASHBOARD_TO            Fixed dashboard end timestamp in milliseconds
  HEAP_SNAPSHOT           Set to 1 to capture the active dashboard heap
  CPU_PROFILE             Set to 1 to capture per-render Chrome CPU profiles
  VERIFY_INTERACTIONS     Set to 1 to verify tooltip and legend interactions
  HOVER_STEPS             Cursor moves sampled during interaction verification (default: 12)
  HEADLESS                Set to 1 for headless Chromium
  CHROMIUM_PATH           Optional Chromium executable
  OUTPUT_DIR              Metrics and screenshot directory

Examples:
  HEADLESS=1 SCENARIO=synthetic SERIES_PER_QUERY=2500 POINT_COUNT=863 node devenv/compact-high-cardinality/run.mjs
  HEADLESS=1 DASHBOARD_JSON=/tmp/dashboard.json PANEL_ID=42 node devenv/compact-high-cardinality/run.mjs
  HEADLESS=1 SCENARIO=single-query RESPONSE_JSON=/tmp/captured-response.json node devenv/compact-high-cardinality/run.mjs`);
  process.exit(0);
}

const fixture = await createDashboardFixture(options);
fixture.dashboard.uid = options.dashboardUid;
const capturedResponse = options.responseJson ? await loadCapturedResponse(options.responseJson) : undefined;
await fs.mkdir(options.outputDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: options.chromiumPath ?? chromium.executablePath(),
  headless: options.headless,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const context = await browser.newContext({ viewport: { width: 1800, height: 1100 } });
await installPaintProbe(context);
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');

const queryRequests = [];
const responseHeaders = [];
const pageErrors = [];
const requestWaiters = [];

page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
page.on('console', (message) => {
  if (message.type() === 'error') {
    pageErrors.push(`console: ${message.text()}`);
  }
});
page.on('response', (response) => {
  if (response.url().includes('/api/ds/query')) {
    responseHeaders.push(response.headers());
  }
});

await context.route('**/api/ds/query**', async (route) => {
  const request = route.request();
  const headers = request.headers();
  if (
    headers['x-dashboard-uid'] !== options.dashboardUid ||
    headers['x-panel-id'] !== '1' ||
    headers['x-panel-plugin-id'] !== 'timeseries'
  ) {
    await route.continue();
    return;
  }

  const requestNumber = queryRequests.length + 1;
  const requestBody = parseQueryRequest(request.postData());
  const refIds = requestBody.queries.map((query) => query.refId);
  const preferredFormat = headers[COMPACT_HEADER];
  const requestedFormat = preferredFormat ?? 'json';
  const startedAt = performance.now();

  if (options.expectedFormat !== 'auto' && requestedFormat !== options.expectedFormat) {
    queryRequests.push({
      requestNumber,
      preferredFormat,
      refIds,
      error: `Expected ${options.expectedFormat}, received ${requestedFormat}`,
    });
    notifyRequestWaiters();
    await route.fulfill({
      status: 412,
      contentType: JSON_MEDIA_TYPE,
      body: JSON.stringify({ message: `Expected ${options.expectedFormat}` }),
    });
    return;
  }

  const responseFormat = options.responseFormat === 'auto' ? requestedFormat : options.responseFormat;
  if (responseFormat === 'compact-v1' && requestedFormat !== 'compact-v1') {
    queryRequests.push({
      requestNumber,
      preferredFormat,
      refIds,
      error: 'Cannot return compact-v1 to a request that did not opt in',
    });
    notifyRequestWaiters();
    await route.fulfill({
      status: 412,
      contentType: JSON_MEDIA_TYPE,
      body: JSON.stringify({ message: 'compact-v1 response requires compact-v1 request preference' }),
    });
    return;
  }

  const compact = responseFormat === 'compact-v1';
  const responseOptions = capturedResponse
    ? undefined
    : {
        refIds,
        seriesPerQuery: options.seriesPerQuery,
        pointCount: options.pointCount,
        from: Number(requestBody.from),
        to: Number(requestBody.to),
        queries: requestBody.queries,
        gappedSeriesEvery: options.gappedSeriesEvery,
        gapEvery: options.gapEvery,
        seed: options.seed + requestNumber - 1,
      };
  const responseSummary = capturedResponse
    ? summarizeGrafanaJsonResponse(capturedResponse.parsed, refIds)
    : { seriesCount: refIds.length * options.seriesPerQuery, pointCount: options.pointCount };
  const response = capturedResponse
    ? buildCapturedResponse(capturedResponse, refIds, compact)
    : buildGeneratedResponse(responseOptions, compact);
  const generatedAt = performance.now();
  const responseBody = Buffer.from(response);
  const compressionStartedAt = performance.now();
  const rawResponseBytes = responseBody.byteLength;
  const gzipResponseBytes = gzipSync(responseBody).byteLength;
  const brotliResponseBytes = brotliCompressSync(responseBody, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
    },
  }).byteLength;
  const compressedAt = performance.now();
  await page.evaluate((id) => window.__compactPaintProbe?.arm(id), requestNumber);

  queryRequests.push({
    requestNumber,
    preferredFormat,
    refIds,
    seriesCount: responseSummary.seriesCount,
    pointCount: responseSummary.pointCount,
    rawResponseBytes,
    gzipResponseBytes,
    brotliResponseBytes,
    responseFormat,
    generationMs: round(generatedAt - startedAt),
    compressionMs: round(compressedAt - compressionStartedAt),
  });
  notifyRequestWaiters();

  await route.fulfill({
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': compact ? COMPACT_MEDIA_TYPE : JSON_MEDIA_TYPE,
      vary: 'X-Grafana-Query-Format, Accept-Encoding',
    },
    body: responseBody,
  });
});

const report = {
  config: { ...options, password: '<redacted>' },
  fixture: {
    ...fixture.source,
    responseFixture: capturedResponse?.summary,
  },
  executionMode: 'optimize',
  telemetryMode: 'degraded-cdp',
  browser: await browser.version(),
  queryRequests,
  samples: [],
  pageErrors,
};

try {
  await login(context, options);
  await ensureDatasource(context, options.baseUrl);
  await putDashboard(context, options.baseUrl, fixture.dashboard);
  report.baseline = await collectBrowserSample(cdp, page, 'pre-dashboard');

  const dashboardRange =
    capturedResponse?.summary.from != null && capturedResponse.summary.to != null
      ? `from=${capturedResponse.summary.from}&to=${capturedResponse.summary.to}`
      : options.dashboardFrom != null && options.dashboardTo != null
        ? `from=${options.dashboardFrom}&to=${options.dashboardTo}`
        : 'from=now-1h&to=now';
  const dashboardUrl = `${options.baseUrl}/d/${options.dashboardUid}/compact-high-cardinality-local?orgId=1&${dashboardRange}`;
  if (options.cpuProfile) {
    await startCpuProfile(cdp);
  }
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await recordRender(page, cdp, report, 1, 'initial-render');
  await captureChart(page, path.join(options.outputDir, 'chart.png'));
  if (options.cpuProfile) {
    await stopCpuProfile(cdp, path.join(options.outputDir, 'initial-render.cpuprofile'));
  }
  if (options.verifyInteractions) {
    report.interactions = await verifyPanelInteractions(page, queryRequests[0].responseFormat);
  }

  for (let refreshIndex = 0; refreshIndex < options.refreshes; refreshIndex++) {
    const expectedRequestCount = queryRequests.length + 1;
    if (options.cpuProfile) {
      await startCpuProfile(cdp);
    }
    await page.getByTestId('data-testid RefreshPicker run button').click();
    const label = `refresh-${refreshIndex + 1}`;
    await recordRender(page, cdp, report, expectedRequestCount, label);
    if (options.cpuProfile) {
      await stopCpuProfile(cdp, path.join(options.outputDir, `${label}.cpuprofile`));
    }
  }

  const responseMediaTypes = responseHeaders.map((headers) => headers['content-type']?.split(';', 1)[0]);
  const expectedMediaTypes = queryRequests.map((request) =>
    request.responseFormat === 'compact-v1' ? COMPACT_BASE_MEDIA_TYPE : JSON_MEDIA_TYPE
  );
  if (responseMediaTypes.some((contentType, index) => contentType !== expectedMediaTypes[index])) {
    throw new Error(
      `Unexpected query response content type: received ${responseMediaTypes.join(', ')}, expected ${expectedMediaTypes.join(', ')}`
    );
  }
  if (pageErrors.length > 0) {
    throw new Error(`Browser reported errors:\n${pageErrors.join('\n')}`);
  }

  if (options.heapSnapshot) {
    report.heapSnapshot = path.join(options.outputDir, 'dashboard.heapsnapshot');
    await takeHeapSnapshot(cdp, report.heapSnapshot);
  }
  await page.screenshot({ path: path.join(options.outputDir, 'dashboard.png'), fullPage: true });
  await page.goto('about:blank');
  await page.waitForTimeout(500);
  report.samples.push(await collectBrowserSample(cdp, page, 'after-dashboard-unmount'));
  report.responseMediaTypes = responseMediaTypes;
  report.dashboardUrl = dashboardUrl;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  try {
    await page.screenshot({ path: path.join(options.outputDir, 'dashboard-failure.png'), fullPage: true });
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

function buildCapturedResponse(capturedResponse, refIds, compact) {
  return compact
    ? buildCompactResponseFromGrafanaJson(capturedResponse.parsed, refIds)
    : capturedResponse.forRefIds(refIds);
}

function buildGeneratedResponse(responseOptions, compact) {
  if (!compact) {
    return buildJsonResponse(responseOptions);
  }
  if (options.dashboardJson) {
    const json = JSON.parse(buildJsonResponse(responseOptions));
    return buildCompactResponseFromGrafanaJson(json, responseOptions.refIds);
  }
  return buildCompactResponse(responseOptions);
}

async function loadCapturedResponse(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const summary = summarizeGrafanaJsonResponse(parsed);
  return {
    parsed,
    summary: { kind: 'captured-grafana-json', filePath, ...summary },
    forRefIds(refIds) {
      if (refIds.length === summary.refIds.length && refIds.every((refId, index) => refId === summary.refIds[index])) {
        return raw;
      }
      const results = {};
      for (const refId of refIds) {
        if (!parsed.results[refId]) {
          throw new Error(`Captured response does not contain query result ${refId}`);
        }
        results[refId] = parsed.results[refId];
      }
      return JSON.stringify({ results });
    },
  };
}

async function recordRender(page, cdp, report, requestNumber, label) {
  await waitForQueryRequest(requestNumber, 120_000);
  assertRequestFormat(requestNumber);
  await waitForPaint(page, requestNumber, 120_000);
  const paint = await waitForCanvasIdle(page, requestNumber, 120_000);
  await waitForChart(page);
  const sample = await collectBrowserSample(cdp, page, label);
  sample.paint = paint;
  assertBoundedLegendDom(sample, queryRequests[requestNumber - 1].seriesCount);
  assertCanvasRendered(sample);
  report.samples.push(sample);
}

async function installPaintProbe(context) {
  await context.addInitScript(() => {
    const originalClearRect = CanvasRenderingContext2D.prototype.clearRect;
    const originalStroke = CanvasRenderingContext2D.prototype.stroke;
    const originalFill = CanvasRenderingContext2D.prototype.fill;
    const originalLineTo = CanvasRenderingContext2D.prototype.lineTo;
    const originalArc = CanvasRenderingContext2D.prototype.arc;
    const state = {
      requestId: 0,
      armedAt: 0,
      firstClearAt: null,
      firstDrawAt: null,
      paintedAt: null,
      lastCanvasOperationAt: null,
      strokeCalls: 0,
      fillCalls: 0,
      lineToCalls: 0,
      arcCalls: 0,
      strokeStyles: new Map(),
    };
    window.__compactPaintProbe = {
      arm(requestId) {
        state.requestId = requestId;
        state.armedAt = performance.now();
        state.firstClearAt = null;
        state.firstDrawAt = null;
        state.paintedAt = null;
        state.lastCanvasOperationAt = null;
        state.strokeCalls = 0;
        state.fillCalls = 0;
        state.lineToCalls = 0;
        state.arcCalls = 0;
        state.strokeStyles.clear();
      },
      snapshot() {
        return {
          ...state,
          strokeStyles: Array.from(state.strokeStyles.entries())
            .sort((left, right) => right[1] - left[1])
            .slice(0, 32),
        };
      },
    };
    const recordDraw = () => {
      if (state.requestId <= 0) {
        return;
      }
      state.lastCanvasOperationAt = performance.now();
      if (state.firstDrawAt == null) {
        const requestId = state.requestId;
        state.firstDrawAt = state.lastCanvasOperationAt;
        requestAnimationFrame(() => {
          if (state.requestId === requestId) {
            state.paintedAt = performance.now();
          }
        });
      }
    };
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (state.requestId > 0 && state.firstClearAt == null) {
        state.firstClearAt = performance.now();
        state.lastCanvasOperationAt = state.firstClearAt;
      }
      return originalClearRect.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.stroke = function (...args) {
      if (state.requestId > 0) {
        recordDraw();
        state.strokeCalls++;
        const key = `${String(this.strokeStyle)}|${this.lineWidth}|${this.globalAlpha}|${this.getLineDash().join(',')}`;
        state.strokeStyles.set(key, (state.strokeStyles.get(key) ?? 0) + 1);
      }
      return originalStroke.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.fill = function (...args) {
      if (state.requestId > 0) {
        recordDraw();
        state.fillCalls++;
      }
      return originalFill.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.lineTo = function (...args) {
      if (state.requestId > 0) {
        state.lastCanvasOperationAt = performance.now();
        state.lineToCalls++;
      }
      return originalLineTo.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.arc = function (...args) {
      if (state.requestId > 0) {
        state.lastCanvasOperationAt = performance.now();
        state.arcCalls++;
      }
      return originalArc.apply(this, args);
    };
  });
}

async function waitForPaint(page, requestNumber, timeoutMs) {
  await page.waitForFunction(
    (id) => {
      const snapshot = window.__compactPaintProbe?.snapshot();
      return snapshot?.requestId === id && snapshot.paintedAt != null;
    },
    requestNumber,
    { timeout: timeoutMs }
  );
}

async function waitForCanvasIdle(page, requestNumber, timeoutMs) {
  await page.waitForFunction(
    (id) => {
      const snapshot = window.__compactPaintProbe?.snapshot();
      return (
        snapshot?.requestId === id &&
        snapshot.paintedAt != null &&
        snapshot.lastCanvasOperationAt != null &&
        performance.now() - snapshot.lastCanvasOperationAt >= 250
      );
    },
    requestNumber,
    { timeout: timeoutMs, polling: 50 }
  );
  const paint = await page.evaluate(() => window.__compactPaintProbe?.snapshot());
  return {
    responseToDrawStartMs: round(paint.firstDrawAt - paint.armedAt),
    responseToPaintMs: round(paint.paintedAt - paint.armedAt),
    drawFrameMs: round(paint.paintedAt - paint.firstDrawAt),
    responseToCompleteMs: round(paint.lastCanvasOperationAt - paint.armedAt),
    progressiveAfterFirstPaintMs: round(Math.max(0, paint.lastCanvasOperationAt - paint.paintedAt)),
    canvas: {
      strokes: paint.strokeCalls,
      fills: paint.fillCalls,
      lineSegments: paint.lineToCalls,
      arcs: paint.arcCalls,
      strokeStyles: paint.strokeStyles,
    },
  };
}

async function login(context, { baseUrl, username, password }) {
  const response = await context.request.post(`${baseUrl}/login`, { data: { user: username, password } });
  if (!response.ok()) {
    throw new Error(`Grafana login failed: ${response.status()} ${await response.text()}`);
  }
}

async function ensureDatasource(context, baseUrl) {
  const current = await context.request.get(`${baseUrl}/api/datasources/uid/${DATASOURCE_UID}`);
  if (current.ok()) {
    return;
  }
  if (current.status() !== 404) {
    throw new Error(`Datasource lookup failed: ${current.status()} ${await current.text()}`);
  }
  const created = await context.request.post(`${baseUrl}/api/datasources`, {
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

async function putDashboard(context, baseUrl, dashboard) {
  const response = await context.request.post(`${baseUrl}/api/dashboards/db`, {
    data: { overwrite: true, dashboard },
  });
  if (!response.ok()) {
    throw new Error(`Dashboard creation failed: ${response.status()} ${await response.text()}`);
  }
}

function parseQueryRequest(postData) {
  if (!postData) {
    throw new Error('Compact fixture query has no request body');
  }
  const request = JSON.parse(postData);
  if (!Array.isArray(request.queries)) {
    throw new Error('Compact fixture query is missing queries');
  }
  return request;
}

async function waitForChart(page) {
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 120_000 });
  await page.waitForTimeout(250);
  const alert = page.locator('[role="alert"]');
  if ((await alert.count()) > 0) {
    const text = (await alert.allTextContents()).join(' | ');
    if (/error|failed|invalid compact/i.test(text)) {
      throw new Error(`Dashboard rendered an error: ${text}`);
    }
  }
}

async function captureChart(page, filePath) {
  const chart = page.locator('.uplot').first();
  await chart.waitFor({ state: 'visible', timeout: 120_000 });
  await chart.screenshot({ path: filePath });
}

async function collectBrowserSample(cdp, page, label) {
  await cdp.send('HeapProfiler.collectGarbage');
  const [heapUsage, performanceMetrics, dom] = await Promise.all([
    cdp.send('Runtime.getHeapUsage'),
    cdp.send('Performance.getMetrics'),
    collectDomDiagnostics(page),
  ]);
  const metrics = Object.fromEntries(performanceMetrics.metrics.map(({ name, value }) => [name, value]));
  return {
    label,
    usedHeapMB: bytesToMB(heapUsage.usedSize),
    totalHeapMB: bytesToMB(heapUsage.totalSize),
    embedderHeapMB: bytesToMB(heapUsage.embedderHeapUsedSize),
    backingStorageMB: bytesToMB(heapUsage.backingStorageSize),
    documents: metrics.Documents,
    performanceNodes: metrics.Nodes,
    taskDurationSeconds: round(metrics.TaskDuration),
    scriptDurationSeconds: round(metrics.ScriptDuration),
    layoutDurationSeconds: round(metrics.LayoutDuration),
    dom,
    chart: await collectChartDiagnostics(page),
  };
}

async function collectChartDiagnostics(page) {
  const canvas = page.locator('canvas').first();
  if ((await canvas.count()) === 0) {
    return null;
  }
  return canvas.evaluate((canvas) => {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return { width: canvas.width, height: canvas.height, distinctSampledColors: 0, opaqueSamples: 0 };
    }
    const colors = new Set();
    let opaqueSamples = 0;
    const columns = 40;
    const rows = 20;
    for (let row = 0; row < rows; row++) {
      const y = Math.min(canvas.height - 1, Math.floor(((row + 0.5) * canvas.height) / rows));
      for (let column = 0; column < columns; column++) {
        const x = Math.min(canvas.width - 1, Math.floor(((column + 0.5) * canvas.width) / columns));
        const [red, green, blue, alpha] = context.getImageData(x, y, 1, 1).data;
        if (alpha > 0) {
          opaqueSamples++;
          colors.add(`${red},${green},${blue},${alpha}`);
        }
      }
    }
    const bounds = canvas.getBoundingClientRect();
    return {
      width: canvas.width,
      height: canvas.height,
      cssWidth: Math.round(bounds.width),
      cssHeight: Math.round(bounds.height),
      distinctSampledColors: colors.size,
      opaqueSamples,
    };
  });
}

async function verifyPanelInteractions(page, responseFormat) {
  const canvas = page.locator('canvas').first();
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('Compact chart canvas has no visible bounds');
  }

  const hoverStartedAt = performance.now();
  await page.mouse.move(bounds.x + bounds.width * 0.55, bounds.y + bounds.height * 0.45);
  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector('[data-testid="data-testid viz-tooltip-wrapper"]') ??
          Array.from(document.body.querySelectorAll('div')).find((element) => {
            const style = getComputedStyle(element);
            return style.position === 'fixed' && style.zIndex === '10000' && element.textContent?.trim();
          })
      ),
    undefined,
    { timeout: 10_000 }
  );
  const hoverToTooltipMs = round(performance.now() - hoverStartedAt);
  const tooltip = await page.evaluate(async (format) => {
    const element =
      document.querySelector('[data-testid="data-testid viz-tooltip-wrapper"]') ??
      Array.from(document.body.querySelectorAll('div')).find((candidate) => {
        const style = getComputedStyle(candidate);
        return style.position === 'fixed' && style.zIndex === '10000' && candidate.textContent?.trim();
      });
    const rows =
      format === 'compact-v1'
        ? Array.from(element?.querySelectorAll('[data-index]') ?? [])
        : Array.from(element?.querySelectorAll('[data-testid="series-icon"]') ?? []).flatMap((icon) => {
            const row = icon.closest('tr') ?? icon.parentElement?.parentElement;
            return row ? [row] : [];
          });
    const bounds = rows.map((row) => row.getBoundingClientRect());
    let totalRows = rows.length;
    if (format === 'compact-v1') {
      const scrollContainer = Array.from(element?.querySelectorAll('div') ?? []).find(
        (candidate) => getComputedStyle(candidate).overflowY === 'auto'
      );
      if (scrollContainer) {
        const previous = scrollContainer.scrollTop;
        for (let attempt = 0; attempt < 5; attempt++) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const indexes = Array.from(element?.querySelectorAll('[data-index]') ?? [], (row) =>
          Number(row.getAttribute('data-index'))
        );
        totalRows = indexes.length === 0 ? 0 : Math.max(...indexes) + 1;
        scrollContainer.scrollTop = previous;
      }
    }
    return {
      visible: Boolean(element),
      totalRows,
      mountedRows: rows.length,
      sampleRows: rows.slice(0, 3).map((row) => row.textContent?.trim() ?? ''),
      textLength: element?.textContent?.length ?? 0,
      overlappingRows: bounds.some((rowBounds, index) => index > 0 && rowBounds.top < bounds[index - 1].bottom - 1),
    };
  }, responseFormat);
  if (tooltip.totalRows === 0) {
    throw new Error(`${responseFormat} tooltip is visible but has no series rows`);
  }
  if (responseFormat === 'compact-v1' && tooltip.overlappingRows) {
    throw new Error('Compact tooltip rows overlap');
  }
  const repeatedHover = await measureRepeatedHover(page, bounds, responseFormat, options.hoverSteps);

  const legendButtons = page.locator(
    '[data-testid^="data-testid VizLegend series "] > button, table tbody tr button[title]'
  );
  if ((await legendButtons.count()) < 2) {
    return {
      hoverToTooltipMs,
      tooltip,
      repeatedHover,
      legendToggleChangedState: null,
    };
  }
  const firstLegendButton = legendButtons.nth(0);
  await firstLegendButton.waitFor({ state: 'visible', timeout: 10_000 });
  const firstLegendLabel = await firstLegendButton.getAttribute('title');
  let secondLegendButton;
  for (let index = 1; index < (await legendButtons.count()); index++) {
    const candidate = legendButtons.nth(index);
    if ((await candidate.getAttribute('title')) !== firstLegendLabel) {
      secondLegendButton = candidate;
      break;
    }
  }
  if (!secondLegendButton) {
    return {
      hoverToTooltipMs,
      tooltip,
      repeatedHover,
      legendToggleChangedState: null,
    };
  }
  await secondLegendButton.waitFor({ state: 'visible', timeout: 10_000 });
  const initialClass = await legendButtonState(secondLegendButton);
  await firstLegendButton.click();
  await expectLegendStateChange(page, secondLegendButton, initialClass);
  const isolatedClass = await legendButtonState(secondLegendButton);
  const beforeRestore = await page.evaluate(() => window.__compactPaintProbe?.snapshot().lastCanvasOperationAt);
  await firstLegendButton.click();
  await expectLegendStateChange(page, secondLegendButton, isolatedClass);
  await waitForCanvasRedraw(page, beforeRestore, 120_000);
  const restoredClass = await legendButtonState(secondLegendButton);
  if (restoredClass !== initialClass) {
    throw new Error('Legend isolation did not restore the original series visibility state');
  }

  return {
    hoverToTooltipMs,
    tooltip,
    repeatedHover,
    legendToggleChangedState: initialClass !== isolatedClass,
  };
}

async function measureRepeatedHover(page, bounds, responseFormat, stepCount) {
  const samples = [];
  for (let step = 0; step < stepCount; step++) {
    const xFraction = 0.12 + (0.76 * step) / Math.max(1, stepCount - 1);
    const yFraction = step % 2 === 0 ? 0.3 : 0.7;
    await page.evaluate(() => {
      window.__compactHoverProbe = null;
      document.addEventListener(
        'mousemove',
        () => {
          const eventStartedAt = performance.now();
          let frames = 0;
          const waitForSettledFrame = () => {
            frames++;
            if (frames >= 2) {
              const tooltipVisible = Boolean(
                document.querySelector('[data-testid="data-testid viz-tooltip-wrapper"]') ??
                  Array.from(document.body.querySelectorAll('div')).find((element) => {
                    const style = getComputedStyle(element);
                    return style.position === 'fixed' && style.zIndex === '10000' && element.textContent?.trim();
                  })
              );
              window.__compactHoverProbe = {
                eventToSettledFrameMs: performance.now() - eventStartedAt,
                tooltipVisible,
                focusOverlayVisible: document.querySelector('.u-compact-focus-overlay') != null,
              };
              return;
            }
            requestAnimationFrame(waitForSettledFrame);
          };
          requestAnimationFrame(waitForSettledFrame);
        },
        { capture: true, once: true }
      );
    });
    await page.mouse.move(bounds.x + bounds.width * xFraction, bounds.y + bounds.height * yFraction);
    await page.waitForFunction(() => window.__compactHoverProbe != null, undefined, { timeout: 10_000 });
    const probe = await page.evaluate(() => window.__compactHoverProbe);
    samples.push({
      durationMs: round(probe.eventToSettledFrameMs),
      tooltipVisible: probe.tooltipVisible,
      focusOverlayVisible: probe.focusOverlayVisible,
    });
  }

  let overlayCount = await page.locator('.u-compact-focus-overlay').count();
  if (responseFormat === 'compact-v1' && overlayCount === 0) {
    for (let step = 1; step < 10 && overlayCount === 0; step++) {
      await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + (bounds.height * step) / 10);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      overlayCount = await page.locator('.u-compact-focus-overlay').count();
    }
  }
  if (responseFormat === 'compact-v1' && overlayCount !== 1) {
    throw new Error(`Compact hover expected one focus overlay, found ${overlayCount}`);
  }
  if (responseFormat === 'json' && overlayCount !== 0) {
    throw new Error('Legacy JSON hover unexpectedly created a compact focus overlay');
  }
  await page
    .locator('.uplot')
    .first()
    .screenshot({ path: path.join(options.outputDir, 'chart-hover.png') });

  return {
    samples,
    eventToSettledFrameMedianMs: percentile(
      samples.map((sample) => sample.durationMs),
      0.5
    ),
    eventToSettledFrameP95Ms: percentile(
      samples.map((sample) => sample.durationMs),
      0.95
    ),
    eventToSettledFrameMaxMs: round(Math.max(...samples.map((sample) => sample.durationMs))),
    focusOverlayCount: overlayCount,
  };
}

async function waitForCanvasRedraw(page, previousOperationAt, timeoutMs) {
  await page.waitForFunction(
    (previous) => {
      const snapshot = window.__compactPaintProbe?.snapshot();
      return (
        snapshot?.lastCanvasOperationAt != null &&
        snapshot.lastCanvasOperationAt !== previous &&
        performance.now() - snapshot.lastCanvasOperationAt >= 250
      );
    },
    previousOperationAt,
    { timeout: timeoutMs, polling: 50 }
  );
}

async function legendButtonState(button) {
  return button.evaluate((element) => {
    const item = element.closest('tr') ?? element.closest('[data-testid^="data-testid VizLegend series "]');
    return `${item?.className ?? ''}|${element.className}`;
  });
}

async function expectLegendStateChange(page, button, previousState) {
  await page.waitForFunction(
    ({ element, previous }) => {
      const item = element.closest('tr') ?? element.closest('[data-testid^="data-testid VizLegend series "]');
      return `${item?.className ?? ''}|${element.className}` !== previous;
    },
    { element: await button.elementHandle(), previous: previousState },
    { timeout: 10_000 }
  );
}

async function collectDomDiagnostics(page) {
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const groups = new Map();
    for (const button of buttons) {
      const toolbar = button.closest('[role="toolbar"]');
      const uplot = button.closest('.uplot');
      const testId = button.closest('[data-testid]')?.getAttribute('data-testid');
      const key = uplot
        ? 'uplot'
        : toolbar
          ? `toolbar:${toolbar.getAttribute('aria-orientation') ?? 'unknown'}`
          : testId
            ? `testid:${testId.replace(/\d+/g, '#').slice(0, 100)}`
            : `parent:${button.parentElement?.tagName.toLowerCase()}.${String(button.parentElement?.className).slice(0, 80)}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    const toolbars = Array.from(document.querySelectorAll('[role="toolbar"]')).map((element) => ({
      orientation: element.getAttribute('aria-orientation'),
      buttons: element.querySelectorAll('button').length,
      children: element.children.length,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    return {
      nodes: document.getElementsByTagName('*').length,
      listItems: document.querySelectorAll('li').length,
      buttons: buttons.length,
      legendItems: document.querySelectorAll('[data-testid^="data-testid VizLegend series "]').length,
      legendTableRows: document.querySelectorAll('table tbody tr').length,
      canvases: document.querySelectorAll('canvas').length,
      viewportWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      buttonGroups: Array.from(groups.entries())
        .sort((left, right) => right[1] - left[1])
        .slice(0, 15)
        .map(([name, count]) => ({ name, count })),
      toolbars,
    };
  });
}

async function takeHeapSnapshot(cdp, filePath) {
  const chunks = [];
  const onChunk = ({ chunk }) => chunks.push(chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  try {
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  } finally {
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  }
  await fs.writeFile(filePath, chunks.join(''));
}

async function startCpuProfile(cdp) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
}

async function stopCpuProfile(cdp, filePath) {
  const { profile } = await cdp.send('Profiler.stop');
  await fs.writeFile(filePath, `${JSON.stringify(profile)}\n`);
}

function assertBoundedLegendDom(sample, seriesCount) {
  if (seriesCount <= 200) {
    return;
  }
  const renderedLegendRows = Math.max(sample.dom.legendItems, sample.dom.legendTableRows);
  if (renderedLegendRows > 200) {
    throw new Error(
      `Legend virtualization mounted ${renderedLegendRows} rows for ${seriesCount} series during ${sample.label}`
    );
  }
}

function assertCanvasRendered(sample) {
  if (
    !sample.chart ||
    sample.chart.width <= 0 ||
    sample.chart.height <= 0 ||
    sample.chart.opaqueSamples === 0 ||
    sample.chart.distinctSampledColors < 2
  ) {
    throw new Error(`Compact chart did not produce visible canvas output during ${sample.label}`);
  }
}

function waitForQueryRequest(expectedCount, timeoutMs) {
  if (queryRequests.length >= expectedCount) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      expectedCount,
      resolve: () => {
        clearTimeout(timeout);
        resolve();
      },
    };
    const timeout = setTimeout(() => {
      const index = requestWaiters.indexOf(waiter);
      if (index >= 0) {
        requestWaiters.splice(index, 1);
      }
      reject(new Error(`Timed out waiting for compact query request ${expectedCount}`));
    }, timeoutMs);
    requestWaiters.push(waiter);
  });
}

function notifyRequestWaiters() {
  for (let index = requestWaiters.length - 1; index >= 0; index--) {
    const waiter = requestWaiters[index];
    if (queryRequests.length >= waiter.expectedCount) {
      requestWaiters.splice(index, 1);
      waiter.resolve();
    }
  }
}

function assertRequestFormat(requestNumber) {
  const request = queryRequests[requestNumber - 1];
  if (!request || request.error) {
    throw new Error(request?.error ?? `No dashboard request ${requestNumber} was captured`);
  }
}

function printReport(report, reportPath) {
  const firstRequest = report.queryRequests[0];
  console.log(`\nCompact high-cardinality local test: ${report.status}`);
  console.log(
    `Fixture: ${report.fixture.kind === 'built-in' ? report.fixture.scenario : `${report.fixture.originalDashboardUid}/${report.fixture.originalPanelId}`}`
  );
  console.log(`Workload: ${firstRequest?.seriesCount ?? 0} series, ${firstRequest?.pointCount ?? 0} points`);
  for (const request of report.queryRequests) {
    console.log(
      `request ${request.requestNumber}: requested=${request.preferredFormat ?? 'json'} response=${request.responseFormat ?? '-'} raw=${formatBytes(request.rawResponseBytes)} gzip=${formatBytes(request.gzipResponseBytes)} br=${formatBytes(request.brotliResponseBytes)} generation=${request.generationMs ?? '-'}ms compression=${request.compressionMs ?? '-'}ms`
    );
  }
  for (const sample of report.samples) {
    const paint = sample.paint ? ` paint=${sample.paint.responseToPaintMs}ms` : '';
    const heapDelta =
      report.baseline && sample.usedHeapMB != null && report.baseline.usedHeapMB != null
        ? ` heapDelta=${round(sample.usedHeapMB - report.baseline.usedHeapMB)}MB`
        : '';
    console.log(
      `${sample.label}: JS=${sample.usedHeapMB}MB${heapDelta} embedder=${sample.embedderHeapMB}MB backing=${sample.backingStorageMB}MB DOM=${sample.dom.nodes} buttons=${sample.dom.buttons}${paint}`
    );
  }
  if (report.interactions) {
    console.log(
      `interactions: tooltip=${report.interactions.hoverToTooltipMs}ms hoverP50=${report.interactions.repeatedHover.eventToSettledFrameMedianMs}ms hoverP95=${report.interactions.repeatedHover.eventToSettledFrameP95Ms}ms rows=${report.interactions.tooltip.totalRows} mountedRows=${report.interactions.tooltip.mountedRows} legendToggle=${report.interactions.legendToggleChangedState}`
    );
  }
  if (report.error) {
    console.error(report.error);
  }
  console.log(`Metrics: ${reportPath}`);
  console.log(
    `Screenshot: ${path.join(options.outputDir, report.status === 'passed' ? 'dashboard.png' : 'dashboard-failure.png')}`
  );
}

function readPositiveInteger(name, defaultValue) {
  const value = readInteger(name, defaultValue);
  if (value < 1) {
    throw new Error(`${name} must be at least 1`);
  }
  return value;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return round(sorted[index]);
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

function readExpectedFormat() {
  const value = process.env.EXPECTED_FORMAT ?? 'compact-v1';
  if (value !== 'compact-v1' && value !== 'json' && value !== 'auto') {
    throw new Error('EXPECTED_FORMAT must be compact-v1, json, or auto');
  }
  return value;
}

function readOptionalTimestamp(name) {
  const raw = process.env[name];
  if (raw == null || raw === '') {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer timestamp`);
  }
  return value;
}

function readResponseFormat() {
  const value = process.env.RESPONSE_FORMAT ?? 'auto';
  if (value !== 'compact-v1' && value !== 'json' && value !== 'auto') {
    throw new Error('RESPONSE_FORMAT must be compact-v1, json, or auto');
  }
  return value;
}

function bytesToMB(value) {
  return value == null ? undefined : round(value / (1024 * 1024));
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function formatBytes(value) {
  if (value == null) {
    return '-';
  }
  if (value < 1024) {
    return `${value}B`;
  }
  if (value < 1024 * 1024) {
    return `${round(value / 1024)}KB`;
  }
  return `${round(value / (1024 * 1024))}MB`;
}
