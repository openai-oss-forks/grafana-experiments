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
  requestFormat: readRequestFormat(),
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
  hoverStageProfile: process.env.HOVER_STAGE_PROFILE === '1',
  verifyInteractions: process.env.VERIFY_INTERACTIONS === '1',
  verifyLegendInteractions: process.env.VERIFY_LEGEND_INTERACTIONS === '1',
  verifyTooltipDigest: process.env.VERIFY_TOOLTIP_DIGEST === '1',
  verifyTimeRange: process.env.VERIFY_TIME_RANGE === '1',
  hoverSteps: readPositiveInteger('HOVER_STEPS', 12),
  hoverPattern: readHoverPattern(),
  hoverYFraction: readOptionalUnitFraction('HOVER_Y_FRACTION'),
  headless: process.env.HEADLESS === '1',
  editPanel: process.env.EDIT_PANEL === '1',
  verifyPanelEditor: process.env.VERIFY_PANEL_EDITOR === '1',
  highlightSeriesOnHover: readOptionalBoolean('HIGHLIGHT_SERIES_ON_HOVER'),
  preservePanelGrid: process.env.PRESERVE_PANEL_GRID === '1',
  deviceScaleFactor: readPositiveNumber('DEVICE_SCALE_FACTOR', 1),
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
  REQUEST_FORMAT          auto or json; json strips the compact request header (default: auto)
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
  HOVER_STAGE_PROFILE     Set to 1 to collect compact cursor, tooltip, and redraw stage timings
  VERIFY_INTERACTIONS     Set to 1 to verify tooltip and legend interactions
  VERIFY_LEGEND_INTERACTIONS
                          Set to 1 to verify sorted legend isolation without tooltip interactions
  VERIFY_TOOLTIP_DIGEST   Set to 1 to hash every ordered tooltip row, including virtualized rows
  VERIFY_TIME_RANGE       Set to 1 to exercise zoom-out and move-back dashboard controls
  HOVER_STEPS             Cursor moves sampled during interaction verification (default: 12)
  HOVER_PATTERN           horizontal, vertical, or sweep (default: horizontal)
  HOVER_Y_FRACTION        Optional fixed cursor Y fraction from 0 through 1
  PRESERVE_PANEL_GRID     Set to 1 to keep the source panel width and height
  DEVICE_SCALE_FACTOR     Browser device scale factor (default: 1)
  HEADLESS                Set to 1 for headless Chromium
  EDIT_PANEL              Set to 1 to open the selected panel in edit mode
  VERIFY_PANEL_EDITOR     Set to 1 to require the time-series panel editor and hover control
                          toggle, including compact highlight removal/restoration
  HIGHLIGHT_SERIES_ON_HOVER
                          Override the selected panel's hover highlighting with true or false
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
if (options.highlightSeriesOnHover != null) {
  fixture.dashboard.panels[0].options ??= {};
  fixture.dashboard.panels[0].options.highlightSeriesOnHover = options.highlightSeriesOnHover;
}
const capturedResponse = options.responseJson ? await loadCapturedResponse(options.responseJson) : undefined;
await fs.mkdir(options.outputDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: options.chromiumPath ?? chromium.executablePath(),
  headless: options.headless,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const context = await browser.newContext({
  viewport: { width: 1800, height: 1100 },
  deviceScaleFactor: options.deviceScaleFactor,
});
await installPaintProbe(context, options.hoverStageProfile);
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
    from: requestBody.from,
    to: requestBody.to,
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
if (options.requestFormat === 'json') {
  await context.route('**/api/ds/query**', async (route) => {
    const headers = { ...route.request().headers() };
    delete headers[COMPACT_HEADER];
    await route.fallback({ headers });
  });
}

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
  const editPanelQuery = options.editPanel ? `&editPanel=panel-${fixture.dashboard.panels[0].id}` : '';
  const dashboardUrl = `${options.baseUrl}/d/${options.dashboardUid}/compact-high-cardinality-local?orgId=1&${dashboardRange}${editPanelQuery}`;
  if (options.cpuProfile) {
    await startCpuProfile(cdp);
  }
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await recordRender(page, cdp, report, 1, 'initial-render');
  if (options.verifyPanelEditor) {
    if (!options.editPanel) {
      throw new Error('VERIFY_PANEL_EDITOR requires EDIT_PANEL=1');
    }
    report.panelEditor = await verifyPanelEditor(page, queryRequests[0].responseFormat, queryRequests[0].seriesCount);
  }
  await captureChart(page, path.join(options.outputDir, 'chart.png'));
  if (options.cpuProfile) {
    await stopCpuProfile(cdp, path.join(options.outputDir, 'initial-render.cpuprofile'));
  }
  if (options.verifyInteractions) {
    report.interactions = await verifyPanelInteractions(
      page,
      queryRequests[0].responseFormat,
      queryRequests[0].seriesCount
    );
    report.hoverMemory = await collectBrowserSample(cdp, page, 'after-hover');
  }
  if (options.verifyLegendInteractions) {
    report.legendInteractions = await verifyLegendInteractions(page);
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

  if (options.verifyTimeRange) {
    report.timeRangeActions = [];
    for (const [action, testId] of [
      ['zoom-out', 'data-testid explore-toolbar-timepicker-zoom-out-button'],
      ['move-backward', 'data-testid explore-toolbar-timepicker-move-backward-button'],
    ]) {
      const previousRequest = queryRequests.at(-1);
      const expectedRequestCount = queryRequests.length + 1;
      await page.getByTestId(testId).click();
      await recordRender(page, cdp, report, expectedRequestCount, `time-range-${action}`);
      const currentRequest = queryRequests.at(-1);
      if (previousRequest?.from === currentRequest?.from && previousRequest?.to === currentRequest?.to) {
        throw new Error(`${action} did not change the query time range`);
      }
      report.timeRangeActions.push({
        action,
        requestedFormat: currentRequest.preferredFormat ?? 'json',
        responseFormat: currentRequest.responseFormat,
        from: currentRequest.from,
        to: currentRequest.to,
      });
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
  assertCompactBoundedLegendDom(
    sample,
    queryRequests[requestNumber - 1].seriesCount,
    queryRequests[requestNumber - 1].responseFormat
  );
  assertCanvasRendered(sample);
  report.samples.push(sample);
}

async function verifyPanelEditor(page, responseFormat, seriesCount) {
  const highlightControl = page.getByText('Highlight hovered series', { exact: true });
  await highlightControl.waitFor({ state: 'visible', timeout: 30_000 });
  const highlightSwitch = highlightControl
    .locator('xpath=ancestor::*[.//input[@role="switch"]][1]')
    .getByRole('switch');
  await highlightSwitch.waitFor({ state: 'visible', timeout: 30_000 });
  const highlightSwitchId = await highlightSwitch.getAttribute('id');
  if (!highlightSwitchId) {
    throw new Error('Highlight hovered series switch has no input ID');
  }
  const highlightSwitchLabel = highlightSwitch.locator('xpath=following-sibling::label[1]');
  if (!(await highlightSwitch.isChecked())) {
    throw new Error('Highlight hovered series is not enabled by default');
  }

  const requestCount = queryRequests.length;
  const plotOverlay = page.locator('.uplot .u-over').first();
  const bounds = await plotOverlay.boundingBox();
  if (!bounds) {
    throw new Error('Panel editor chart plot area has no visible bounds');
  }
  const expectHighlight = responseFormat === 'compact-v1' && seriesCount > 1;
  const enabledOverlayCount = await verifyFocusOverlay(page, bounds, responseFormat, expectHighlight);

  await highlightSwitchLabel.click();
  await page.waitForFunction(
    (id) => document.getElementById(id) instanceof HTMLInputElement && !document.getElementById(id).checked,
    highlightSwitchId
  );
  await page.locator('.u-compact-focus-overlay').waitFor({ state: 'detached', timeout: 10_000 });
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const disabledOverlayCount = await verifyFocusOverlay(page, bounds, responseFormat, false);

  await highlightSwitchLabel.click();
  await page.waitForFunction(
    (id) => document.getElementById(id) instanceof HTMLInputElement && document.getElementById(id).checked,
    highlightSwitchId
  );
  const restoredOverlayCount = await verifyFocusOverlay(page, bounds, responseFormat, expectHighlight);
  if (queryRequests.length !== requestCount) {
    throw new Error('Changing hover highlighting unexpectedly issued a datasource query');
  }

  return {
    url: page.url(),
    highlightControlVisible: true,
    initialChecked: true,
    enabledOverlayCount,
    disabledOverlayCount,
    restoredOverlayCount,
    datasourceQueriesIssued: 0,
  };
}

async function installPaintProbe(context, hoverStageProfile) {
  await context.addInitScript((hoverStageProfile) => {
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
    if (hoverStageProfile) {
      const hoverStages = new Map();
      window.__compactHoverStageProbe = {
        reset() {
          hoverStages.clear();
        },
        record(stage, sample) {
          const samples = hoverStages.get(stage) ?? [];
          samples.push(sample);
          hoverStages.set(stage, samples);
        },
        snapshot() {
          return Object.fromEntries(
            Array.from(hoverStages, ([stage, samples]) => [stage, samples.map((sample) => ({ ...sample }))])
          );
        },
      };
    }
    const longTasks = [];
    const longTaskObserver =
      PerformanceObserver.supportedEntryTypes?.includes('longtask') &&
      new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) {
          longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        }
      });
    longTaskObserver?.observe({ entryTypes: ['longtask'] });
    window.__compactLongTaskProbe = {
      reset() {
        longTasks.length = 0;
      },
      snapshot() {
        return longTasks.map((entry) => ({ ...entry }));
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
  }, hoverStageProfile);
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

async function verifyPanelInteractions(page, responseFormat, seriesCount) {
  const plotOverlay = page.locator('.uplot .u-over').first();
  const bounds = await plotOverlay.boundingBox();
  if (!bounds) {
    throw new Error('Chart plot area has no visible bounds');
  }

  await resetHoverStageProbe(page);
  const firstHover = await measureFirstHover(page, bounds);
  firstHover.stages = summarizeHoverStages(await collectHoverStageProbe(page));
  const hoverToTooltipMs = firstHover.inputToNextPaintMs;
  const tooltip = await page.evaluate((format) => {
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
    const focusedRow =
      format === 'compact-v1' ? element?.querySelector('[data-testid="compact-tooltip-focused-series"]') : undefined;
    const focusedText = focusedRow?.textContent?.trim().replace(/^Focused series\s*/, '') ?? '';
    const bounds = rows.map((row) => row.getBoundingClientRect());
    const declaredRowCount = Number(rows[0]?.getAttribute('aria-setsize'));
    const listTotalRows = Number.isFinite(declaredRowCount) && declaredRowCount > 0 ? declaredRowCount : rows.length;
    const focusedRows = focusedRow ? 1 : 0;
    const scrollContainer = element?.querySelector('[role="list"]');
    const scrollBounds = scrollContainer?.getBoundingClientRect();
    const virtualContent = scrollContainer?.firstElementChild;
    return {
      visible: Boolean(element),
      totalRows: listTotalRows + focusedRows,
      listTotalRows,
      focusedRows,
      mountedRows: rows.length + focusedRows,
      scrollViewportHeight: Math.round((scrollBounds?.height ?? 0) * 10) / 10,
      scrollHeight: scrollContainer?.scrollHeight ?? 0,
      virtualContentHeight: Math.round((virtualContent?.getBoundingClientRect().height ?? 0) * 10) / 10,
      virtualContentStyleHeight:
        virtualContent instanceof HTMLElement ? virtualContent.style.height : virtualContent?.getAttribute('style'),
      mountedIndexRange: rows.length
        ? [Number(rows[0].getAttribute('data-index')), Number(rows.at(-1)?.getAttribute('data-index'))]
        : null,
      sampleRows: [focusedText, ...rows.map((row) => row.textContent?.trim() ?? '')].filter(Boolean).slice(0, 3),
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
  if (responseFormat === 'compact-v1' && tooltip.listTotalRows > tooltip.mountedRows - tooltip.focusedRows) {
    const expectedScrollHeight = Number.parseFloat(tooltip.virtualContentStyleHeight);
    if (!Number.isFinite(expectedScrollHeight) || tooltip.scrollHeight + 1 < expectedScrollHeight) {
      throw new Error(
        `Compact tooltip scroll range ${tooltip.scrollHeight}px does not cover its ${expectedScrollHeight}px virtual content`
      );
    }
    if (tooltip.mountedRows > Math.ceil(tooltip.scrollViewportHeight / 20) + 30) {
      throw new Error(
        `Compact tooltip mounted ${tooltip.mountedRows} rows for a ${tooltip.scrollViewportHeight}px viewport`
      );
    }
  }
  const repeatedHover = await measureRepeatedHover(
    page,
    bounds,
    responseFormat,
    options.hoverSteps,
    tooltip.totalRows > 1,
    seriesCount > 1 && options.highlightSeriesOnHover !== false
  );
  if (options.verifyTooltipDigest) {
    await restoreTooltipDigestPosition(page, bounds);
  }
  const tooltipRowDigest = options.verifyTooltipDigest
    ? await collectTooltipRowDigests(page, responseFormat, tooltip.listTotalRows, tooltip.focusedRows)
    : undefined;
  const scrollReachedLastRow =
    responseFormat === 'compact-v1' && tooltip.listTotalRows > tooltip.mountedRows - tooltip.focusedRows
      ? await verifyVirtualTooltipScroll(page, tooltip.listTotalRows)
      : null;
  const pinning = await verifyCompactTooltipPinning(page, bounds, responseFormat);
  const interactionResult = {
    hoverToTooltipMs,
    firstHover,
    tooltip,
    tooltipRowDigest: tooltipRowDigest?.ordered,
    tooltipContentDigest: tooltipRowDigest?.content,
    tooltipRowHashes: tooltipRowDigest?.rows,
    tooltipFocusedHash: tooltipRowDigest?.focused,
    scrollReachedLastRow,
    repeatedHover,
    pinning,
  };

  const legendInteractions = await verifyLegendInteractions(page);
  return { ...interactionResult, ...legendInteractions };
}

async function verifyLegendInteractions(page) {
  const nameHeader = page.getByRole('columnheader', { name: /^Name/ });
  if ((await nameHeader.count()) > 0 && (await nameHeader.first().isVisible())) {
    await nameHeader.first().click();
    await page.waitForTimeout(0);
  }
  const legendButtons = page.locator(
    '[data-testid^="data-testid VizLegend series "] > button, table tbody tr button[title]'
  );
  if ((await legendButtons.count()) < 2) {
    return { legendToggleChangedState: null };
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
    return { legendToggleChangedState: null };
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

  return { legendToggleChangedState: initialClass !== isolatedClass };
}

async function collectTooltipRowDigests(page, responseFormat, listTotalRows, focusedRows) {
  return page.evaluate(
    async ({ responseFormat, listTotalRows, focusedRows }) => {
      const tooltip =
        document.querySelector('[data-testid="data-testid viz-tooltip-wrapper"]') ??
        Array.from(document.body.querySelectorAll('div')).find((candidate) => {
          const style = getComputedStyle(candidate);
          return style.position === 'fixed' && style.zIndex === '10000' && candidate.textContent?.trim();
        });
      if (!tooltip) {
        throw new Error('Tooltip disappeared before row digest collection');
      }

      const values = new Array(listTotalRows);
      let focusedValue = '';
      if (responseFormat === 'compact-v1') {
        const focused = tooltip.querySelector('[data-testid="compact-tooltip-focused-series"]');
        focusedValue = focused?.textContent?.trim().replace(/^Focused series\s*/, '') ?? '';
        const rows = tooltip.querySelector('[role="list"]');
        if (!(rows instanceof HTMLElement)) {
          throw new Error('Compact tooltip has no scroll container');
        }
        const capture = () => {
          for (const row of rows.querySelectorAll('[data-index]')) {
            const index = Number(row.getAttribute('data-index'));
            if (Number.isInteger(index) && index >= 0 && index < values.length) {
              values[index] = row.textContent?.trim() ?? '';
            }
          }
        };
        const maxOffset = Math.max(0, rows.scrollHeight - rows.clientHeight);
        const step = Math.max(1, Math.floor(rows.clientHeight * 0.8));
        for (let offset = 0; offset < maxOffset; offset += step) {
          rows.scrollTop = offset;
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          capture();
        }
        rows.scrollTop = maxOffset;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        capture();
        rows.scrollTop = 0;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      } else {
        const rows = Array.from(tooltip.querySelectorAll('[data-testid="series-icon"]')).flatMap((icon) => {
          const row = icon.closest('tr') ?? icon.parentElement?.parentElement;
          return row ? [row] : [];
        });
        rows.forEach((row, index) => {
          values[index] = row.textContent?.trim() ?? '';
        });
      }

      const missing = values.findIndex((value) => value == null);
      if (missing >= 0) {
        throw new Error(`Tooltip digest did not visit row ${missing} of ${listTotalRows}`);
      }
      if (focusedRows > 0 && !focusedValue) {
        throw new Error('Compact tooltip focused row disappeared before digest collection');
      }
      const orderedValues = focusedValue ? [focusedValue, ...values] : values;
      const hashText = (value) => {
        let hash = 0x811c9dc5;
        for (let index = 0; index < value.length; index++) {
          hash ^= value.charCodeAt(index);
          hash = Math.imul(hash, 0x01000193);
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
      };
      const digest = async (entries) => {
        const bytes = new TextEncoder().encode(entries.map((value, index) => `${index}\0${value}\n`).join(''));
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return Array.from(hash, (value) => value.toString(16).padStart(2, '0')).join('');
      };
      return {
        ordered: await digest(orderedValues),
        content: await digest([...orderedValues].sort()),
        rows: values.map(hashText),
        focused: focusedValue ? hashText(focusedValue) : null,
      };
    },
    { responseFormat, listTotalRows, focusedRows }
  );
}

async function verifyVirtualTooltipScroll(page, totalRows) {
  const lastMountedIndex = await page.evaluate(async () => {
    const tooltip = document.querySelector('[data-testid="data-testid viz-tooltip-wrapper"]');
    const rows = tooltip?.querySelector('[role="list"]');
    if (!(rows instanceof HTMLElement)) {
      return -1;
    }
    rows.scrollTop = rows.scrollHeight;
    const deadline = performance.now() + 2_000;
    let lastIndex = -1;
    while (performance.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const mounted = Array.from(rows.querySelectorAll('[data-index]'));
      lastIndex = Number(mounted.at(-1)?.getAttribute('data-index'));
      if (lastIndex === Number(mounted[0]?.getAttribute('aria-setsize')) - 1) {
        break;
      }
    }
    rows.scrollTop = 0;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return lastIndex;
  });
  if (lastMountedIndex !== totalRows - 1) {
    throw new Error(`Compact tooltip stopped at row ${lastMountedIndex}; expected ${totalRows - 1}`);
  }
  return true;
}

async function restoreTooltipDigestPosition(page, bounds) {
  await page.mouse.move(bounds.x + bounds.width * 0.55, bounds.y + bounds.height * (options.hoverYFraction ?? 0.45));
  await page.evaluate(
    () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  );
}

async function measureFirstHover(page, bounds) {
  const yFractions = options.hoverYFraction == null ? [0.45, 0.7, 0.3, 0.85, 0.15] : [options.hoverYFraction];
  let lastError;
  for (const yFraction of yFractions) {
    try {
      await resetHoverStageProbe(page);
      return await measureFirstHoverAt(page, bounds.x + bounds.width * 0.55, bounds.y + bounds.height * yFraction);
    } catch (error) {
      lastError = error;
      await page.evaluate(() => window.__compactFirstHoverCleanup?.());
    }
  }
  throw lastError;
}

async function measureFirstHoverAt(page, x, y) {
  await page.evaluate(() => {
    const findTooltip = () =>
      document.querySelector('[data-testid="data-testid viz-tooltip-wrapper"]') ??
      Array.from(document.body.querySelectorAll('div')).find((element) => {
        const style = getComputedStyle(element);
        return style.position === 'fixed' && style.zIndex === '10000' && element.textContent?.trim();
      });
    let eventStartedAt = 0;
    let firstCommitAt = 0;
    const cleanup = () => {
      observer.disconnect();
      document.removeEventListener('mousemove', onMouseMove, true);
      window.__compactFirstHoverCleanup = undefined;
    };
    const observer = new MutationObserver(() => {
      if (firstCommitAt !== 0 || eventStartedAt === 0 || !findTooltip()) {
        return;
      }
      firstCommitAt = performance.now();
      requestAnimationFrame(() => {
        cleanup();
        window.__compactFirstHoverProbe = {
          inputToCommitMs: firstCommitAt - eventStartedAt,
          inputToNextPaintMs: performance.now() - eventStartedAt,
        };
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const onMouseMove = () => {
      eventStartedAt = performance.now();
    };
    window.__compactFirstHoverProbe = null;
    window.__compactFirstHoverCleanup = cleanup;
    document.addEventListener('mousemove', onMouseMove, { capture: true, once: true });
  });
  await page.mouse.move(x, y);
  await page.waitForFunction(() => window.__compactFirstHoverProbe != null, undefined, { timeout: 1_500 });
  return page.evaluate(() => ({
    inputToCommitMs: Math.round(window.__compactFirstHoverProbe.inputToCommitMs * 100) / 100,
    inputToNextPaintMs: Math.round(window.__compactFirstHoverProbe.inputToNextPaintMs * 100) / 100,
  }));
}

async function measureRepeatedHover(page, bounds, responseFormat, stepCount, waitForTooltipCommit, expectFocusOverlay) {
  await resetHoverStageProbe(page);
  await resetLongTaskProbe(page);
  if (options.hoverPattern === 'sweep') {
    const result = await measureContinuousSweep(page, bounds, responseFormat, stepCount, expectFocusOverlay);
    result.longTasks = summarizeLongTasks(await collectLongTaskProbe(page));
    return result;
  }

  const samples = [];
  for (let step = 0; step < stepCount; step++) {
    const progress = step / Math.max(1, stepCount - 1);
    const xFraction = options.hoverPattern === 'vertical' ? 0.5 : 0.12 + 0.76 * progress;
    const yFraction =
      options.hoverPattern === 'horizontal'
        ? (options.hoverYFraction ?? (step % 2 === 0 ? 0.3 : 0.7))
        : 0.12 + 0.76 * progress;
    await page.evaluate(
      (waitForTooltipCommit) => {
        window.__compactHoverProbe = null;
        document.addEventListener(
          'mousemove',
          () => {
            const eventStartedAt = performance.now();
            const tooltip =
              document.querySelector('[data-testid="data-testid viz-tooltip-wrapper"]') ??
              Array.from(document.body.querySelectorAll('div')).find((element) => {
                const style = getComputedStyle(element);
                return style.position === 'fixed' && style.zIndex === '10000' && element.textContent?.trim();
              });
            let firstCommitAt = null;
            let addedNodes = 0;
            let removedNodes = 0;
            let attributeMutations = 0;
            let textMutations = 0;
            const observer = new MutationObserver((records) => {
              firstCommitAt ??= performance.now();
              for (const record of records) {
                if (record.type === 'childList') {
                  addedNodes += record.addedNodes.length;
                  removedNodes += record.removedNodes.length;
                } else if (record.type === 'attributes') {
                  attributeMutations++;
                } else {
                  textMutations++;
                }
              }
            });
            if (tooltip) {
              observer.observe(tooltip, {
                attributes: true,
                characterData: true,
                childList: true,
                subtree: true,
              });
            }
            let frames = 0;
            const waitForPaint = () => {
              frames++;
              if (firstCommitAt == null && waitForTooltipCommit && frames < 4) {
                requestAnimationFrame(waitForPaint);
                return;
              }
              observer.disconnect();
              const tooltipVisible = Boolean(
                document.querySelector('[data-testid="data-testid viz-tooltip-wrapper"]') ??
                  Array.from(document.body.querySelectorAll('div')).find((element) => {
                    const style = getComputedStyle(element);
                    return style.position === 'fixed' && style.zIndex === '10000' && element.textContent?.trim();
                  })
              );
              window.__compactHoverProbe = {
                inputToCommitMs: firstCommitAt == null ? null : firstCommitAt - eventStartedAt,
                inputToNextPaintMs: performance.now() - eventStartedAt,
                unchanged: firstCommitAt == null,
                tooltipVisible,
                focusOverlayVisible: document.querySelector('.u-compact-focus-overlay') != null,
                mutations: { addedNodes, removedNodes, attributeMutations, textMutations },
              };
            };
            requestAnimationFrame(waitForPaint);
          },
          { capture: true, once: true }
        );
      },
      options.hoverPattern === 'horizontal' && waitForTooltipCommit
    );
    await page.mouse.move(bounds.x + bounds.width * xFraction, bounds.y + bounds.height * yFraction);
    await page.waitForFunction(() => window.__compactHoverProbe != null, undefined, { timeout: 10_000 });
    const probe = await page.evaluate(() => window.__compactHoverProbe);
    samples.push({
      inputToCommitMs: probe.inputToCommitMs == null ? null : round(probe.inputToCommitMs),
      inputToNextPaintMs: round(probe.inputToNextPaintMs),
      tooltipVisible: probe.tooltipVisible,
      focusOverlayVisible: probe.focusOverlayVisible,
      unchanged: probe.unchanged,
      mutations: probe.mutations,
    });
  }

  const overlayCount = await verifyFocusOverlay(page, bounds, responseFormat, expectFocusOverlay);
  await page
    .locator('.uplot')
    .first()
    .screenshot({ path: path.join(options.outputDir, 'chart-hover.png') });

  return {
    samples,
    inputToCommitMedianMs: percentile(
      samples.flatMap((sample) => (sample.inputToCommitMs == null ? [] : [sample.inputToCommitMs])),
      0.5
    ),
    inputToCommitP95Ms: percentile(
      samples.flatMap((sample) => (sample.inputToCommitMs == null ? [] : [sample.inputToCommitMs])),
      0.95
    ),
    inputToNextPaintMedianMs: percentile(
      samples.map((sample) => sample.inputToNextPaintMs),
      0.5
    ),
    inputToNextPaintP95Ms: percentile(
      samples.map((sample) => sample.inputToNextPaintMs),
      0.95
    ),
    inputToNextPaintP99Ms: percentile(
      samples.map((sample) => sample.inputToNextPaintMs),
      0.99
    ),
    inputToNextPaintMaxMs: round(Math.max(...samples.map((sample) => sample.inputToNextPaintMs))),
    domMutations: samples.reduce(
      (total, sample) => ({
        addedNodes: total.addedNodes + sample.mutations.addedNodes,
        removedNodes: total.removedNodes + sample.mutations.removedNodes,
        attributeMutations: total.attributeMutations + sample.mutations.attributeMutations,
        textMutations: total.textMutations + sample.mutations.textMutations,
      }),
      { addedNodes: 0, removedNodes: 0, attributeMutations: 0, textMutations: 0 }
    ),
    focusOverlayCount: overlayCount,
    stages: summarizeHoverStages(await collectHoverStageProbe(page)),
    longTasks: summarizeLongTasks(await collectLongTaskProbe(page)),
  };
}

async function measureContinuousSweep(page, bounds, responseFormat, stepCount, expectFocusOverlay) {
  await page.evaluate(() => {
    const tooltip =
      document.querySelector('[data-testid="data-testid viz-tooltip-wrapper"]') ??
      Array.from(document.body.querySelectorAll('div')).find((element) => {
        const style = getComputedStyle(element);
        return style.position === 'fixed' && style.zIndex === '10000' && element.textContent?.trim();
      });
    if (!tooltip) {
      throw new Error('Tooltip is not mounted before the continuous sweep');
    }

    const state = {
      inputEvents: 0,
      commits: 0,
      committedInput: 0,
      maxBacklog: 0,
      maxCommitLagMs: 0,
      firstInputAt: 0,
      lastInputAt: 0,
      lastCommitAt: 0,
    };
    const onMouseMove = () => {
      const now = performance.now();
      state.inputEvents++;
      state.firstInputAt ||= now;
      state.lastInputAt = now;
      state.maxBacklog = Math.max(state.maxBacklog, state.inputEvents - state.committedInput);
    };
    const observer = new MutationObserver(() => {
      const now = performance.now();
      state.commits++;
      state.committedInput = state.inputEvents;
      state.lastCommitAt = now;
      state.maxCommitLagMs = Math.max(state.maxCommitLagMs, now - state.lastInputAt);
    });
    document.addEventListener('mousemove', onMouseMove, true);
    observer.observe(tooltip, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });

    window.__compactSweepProbe = {
      state,
      stop: () => {
        observer.disconnect();
        document.removeEventListener('mousemove', onMouseMove, true);
        return {
          ...state,
          finalBacklog: state.inputEvents - state.committedInput,
          sweepDurationMs: state.lastInputAt - state.firstInputAt,
          settleAfterLastInputMs: performance.now() - state.lastInputAt,
          tooltipText: tooltip.textContent?.trim() ?? '',
        };
      },
    };
  });

  const startX = bounds.x + bounds.width * 0.12;
  const endX = bounds.x + bounds.width * 0.88;
  await page.mouse.move(startX, bounds.y + bounds.height * 0.25);
  await page.mouse.move(endX, bounds.y + bounds.height * 0.75, { steps: stepCount });
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        let stableFrames = 0;
        let previousCommit = -1;
        const waitForStableCommit = () => {
          const state = window.__compactSweepProbe?.state;
          if (!state) {
            resolve();
            return;
          }
          if (state.committedInput === state.inputEvents && state.commits === previousCommit) {
            stableFrames++;
          } else {
            stableFrames = 0;
            previousCommit = state.commits;
          }
          if (stableFrames >= 2 || performance.now() - state.lastInputAt > 2_000) {
            resolve();
          } else {
            requestAnimationFrame(waitForStableCommit);
          }
        };
        requestAnimationFrame(waitForStableCommit);
      })
  );
  const sweep = await page.evaluate(() => {
    const probe = window.__compactSweepProbe;
    window.__compactSweepProbe = null;
    return probe?.stop();
  });
  if (!sweep || sweep.inputEvents < stepCount) {
    throw new Error(`Continuous sweep emitted ${sweep?.inputEvents ?? 0} events; expected at least ${stepCount}`);
  }
  if (sweep.finalBacklog !== 0) {
    throw new Error(`Continuous sweep left ${sweep.finalBacklog} stale tooltip events`);
  }

  const overlayCount = await verifyFocusOverlay(page, bounds, responseFormat, expectFocusOverlay);
  await page
    .locator('.uplot')
    .first()
    .screenshot({ path: path.join(options.outputDir, 'chart-hover-sweep.png') });

  return {
    samples: [],
    inputToCommitMedianMs: null,
    inputToCommitP95Ms: null,
    inputToNextPaintMedianMs: null,
    inputToNextPaintP95Ms: null,
    inputToNextPaintP99Ms: null,
    inputToNextPaintMaxMs: null,
    domMutations: null,
    focusOverlayCount: overlayCount,
    stages: summarizeHoverStages(await collectHoverStageProbe(page)),
    continuousSweep: {
      inputEvents: sweep.inputEvents,
      commits: sweep.commits,
      coalescedEvents: Math.max(0, sweep.inputEvents - sweep.commits),
      maxBacklog: sweep.maxBacklog,
      finalBacklog: sweep.finalBacklog,
      maxCommitLagMs: round(sweep.maxCommitLagMs),
      sweepDurationMs: round(sweep.sweepDurationMs),
      settleAfterLastInputMs: round(sweep.settleAfterLastInputMs),
      finalTooltipTextLength: sweep.tooltipText.length,
    },
  };
}

async function resetHoverStageProbe(page) {
  await page.evaluate(() => window.__compactHoverStageProbe?.reset());
}

async function collectHoverStageProbe(page) {
  return page.evaluate(() => window.__compactHoverStageProbe?.snapshot() ?? {});
}

async function resetLongTaskProbe(page) {
  await page.evaluate(() => window.__compactLongTaskProbe?.reset());
}

async function collectLongTaskProbe(page) {
  return page.evaluate(() => window.__compactLongTaskProbe?.snapshot() ?? []);
}

function summarizeLongTasks(tasks) {
  return {
    count: tasks.length,
    totalDurationMs: round(tasks.reduce((total, task) => total + task.duration, 0)),
    maxDurationMs: tasks.length === 0 ? 0 : round(Math.max(...tasks.map((task) => task.duration))),
  };
}

function summarizeHoverStages(stages) {
  return Object.fromEntries(
    Object.entries(stages).map(([stage, samples]) => {
      const durations = samples.map((sample) => sample.durationMs);
      return [
        stage,
        {
          count: samples.length,
          durationP50Ms: percentile(durations, 0.5),
          durationP95Ms: percentile(durations, 0.95),
          durationMaxMs: durations.length === 0 ? null : round(Math.max(...durations)),
          seriesVisits: samples.reduce((total, sample) => total + (sample.seriesVisits ?? 0), 0),
          valueReads: samples.reduce((total, sample) => total + (sample.valueReads ?? 0), 0),
          nearestReads: samples.reduce((total, sample) => total + (sample.nearestReads ?? 0), 0),
        },
      ];
    })
  );
}

async function verifyFocusOverlay(page, bounds, responseFormat, expectFocusOverlay) {
  let overlayCount = await page.locator('.u-compact-focus-overlay').count();
  if (responseFormat === 'compact-v1' && expectFocusOverlay && overlayCount === 0) {
    const cursorPoint = await page.locator('.u-cursor-pt').first().boundingBox();
    if (
      cursorPoint &&
      cursorPoint.x >= bounds.x &&
      cursorPoint.x <= bounds.x + bounds.width &&
      cursorPoint.y >= bounds.y &&
      cursorPoint.y <= bounds.y + bounds.height
    ) {
      await page.mouse.move(cursorPoint.x + cursorPoint.width / 2, cursorPoint.y + cursorPoint.height / 2);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      overlayCount = await page.locator('.u-compact-focus-overlay').count();
    }
    for (let xStep = 1; xStep < 10 && overlayCount === 0; xStep++) {
      for (let yStep = 1; yStep < 20 && overlayCount === 0; yStep++) {
        await page.mouse.move(bounds.x + (bounds.width * xStep) / 10, bounds.y + (bounds.height * yStep) / 20);
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        );
        overlayCount = await page.locator('.u-compact-focus-overlay').count();
      }
    }
  }
  if (responseFormat === 'compact-v1' && expectFocusOverlay && overlayCount !== 1) {
    throw new Error(`Compact hover expected one focus overlay, found ${overlayCount}`);
  }
  if (responseFormat === 'compact-v1' && !expectFocusOverlay && overlayCount !== 0) {
    throw new Error(`Compact hover unexpectedly created ${overlayCount} focus overlays`);
  }
  if (responseFormat === 'json' && overlayCount !== 0) {
    throw new Error('Legacy JSON hover unexpectedly created a compact focus overlay');
  }
  return overlayCount;
}

async function verifyCompactTooltipPinning(page, bounds, responseFormat) {
  if (responseFormat !== 'compact-v1') {
    return null;
  }

  const tooltip = page.locator('[data-testid="data-testid viz-tooltip-wrapper"]').first();
  const x = bounds.x + bounds.width * 0.55;
  const y = bounds.y + bounds.height * 0.45;
  await page.mouse.move(x, y);
  await tooltip.waitFor({ state: 'visible', timeout: 10_000 });
  const before = (await tooltip.textContent())?.trim() ?? '';
  await page.mouse.click(x, y);
  await page.locator('.uplot[data-compact-tooltip-pinned="true"]').waitFor({ state: 'attached', timeout: 10_000 });

  await page.mouse.move(bounds.x + bounds.width * 0.15, bounds.y + bounds.height * 0.8);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const after = (await tooltip.textContent())?.trim() ?? '';
  if (after !== before) {
    throw new Error('Pinned compact tooltip changed after pointer movement');
  }

  await page.keyboard.press('Escape');
  await page.locator('.uplot[data-compact-tooltip-pinned="true"]').waitFor({ state: 'detached', timeout: 10_000 });
  return { preservedContents: true, dismissedWithEscape: true };
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

function assertCompactBoundedLegendDom(sample, seriesCount, responseFormat) {
  if (responseFormat !== 'compact-v1' || seriesCount <= 200) {
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
      `interactions: tooltip=${report.interactions.hoverToTooltipMs}ms commitP50=${report.interactions.repeatedHover.inputToCommitMedianMs}ms paintP50=${report.interactions.repeatedHover.inputToNextPaintMedianMs}ms paintP95=${report.interactions.repeatedHover.inputToNextPaintP95Ms}ms rows=${report.interactions.tooltip.totalRows} mountedRows=${report.interactions.tooltip.mountedRows} legendToggle=${report.interactions.legendToggleChangedState}`
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
  if (values.length === 0) {
    return null;
  }
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

function readPositiveNumber(name, defaultValue) {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? defaultValue : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

function readOptionalUnitFraction(name) {
  const raw = process.env[name];
  if (raw == null || raw === '') {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number from 0 through 1`);
  }
  return value;
}

function readOptionalBoolean(name) {
  const value = process.env[name];
  if (value == null || value === '') {
    return undefined;
  }
  if (value === 'true' || value === '1') {
    return true;
  }
  if (value === 'false' || value === '0') {
    return false;
  }
  throw new Error(`${name} must be true, false, 1, or 0`);
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

function readRequestFormat() {
  const value = process.env.REQUEST_FORMAT ?? 'auto';
  if (value !== 'json' && value !== 'auto') {
    throw new Error('REQUEST_FORMAT must be json or auto');
  }
  return value;
}

function readHoverPattern() {
  const value = process.env.HOVER_PATTERN ?? 'horizontal';
  if (value !== 'horizontal' && value !== 'vertical' && value !== 'sweep') {
    throw new Error('HOVER_PATTERN must be horizontal, vertical, or sweep');
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
