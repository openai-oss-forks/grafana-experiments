import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';

import { buildCompactResponseFromGrafanaJson } from './compact-v1.mjs';
import { createFullDashboardFixture, DASHBOARD_UID, DATASOURCE_UID } from './fixtures.mjs';
import { buildJsonResponse } from './json-response.mjs';

const COMPACT_HEADER = 'x-grafana-query-format';
const COMPACT_MEDIA_TYPE = 'application/vnd.grafana.querydata.compact;version=1';
const JSON_MEDIA_TYPE = 'application/json';

const dashboardJson = process.env.DASHBOARD_JSON;
if (!dashboardJson || process.argv.includes('--help')) {
  console.log(`Usage: DASHBOARD_JSON=/path/to/dashboard.json node devenv/compact-high-cardinality/full-dashboard-run.mjs

Environment:
  GRAFANA_URL             Compact Grafana URL (default: http://127.0.0.1:3000)
  LEGACY_GRAFANA_URL      Optional JSON control URL (default: GRAFANA_URL)
  RESPONSE_FORMAT         auto or legacy-json (default: auto)
  SERIES_PER_QUERY        Generated series for each query (default: 20)
  POINT_COUNT             Samples generated for each series (default: 120)
  DASHBOARD_FROM          Fixed start timestamp in milliseconds (default: now-1h)
  DASHBOARD_TO            Fixed end timestamp in milliseconds (default: now)
  SCROLL_STEP_VIEWPORTS   Scroll distance in viewport heights (default: 0.8)
  SCROLL_SETTLE_MS        Delay after layout before checking query idleness (default: 250)
  MAX_SCROLL_STEPS        Stop after this many steps; 0 reaches the bottom (default: 0)
  SAMPLE_EVERY            Retain a full sample every N steps (default: 5)
  SCROLL_CYCLES           Full refresh-and-scroll cycles in one browser session (default: 1)
  BIDIRECTIONAL_SCROLL    Scroll back to the top within each cycle when set to 1
  PRESERVE_DASHBOARD_REFRESH
                           Keep the exported dashboard refresh interval when set to 1
  AUTO_REFRESHES          Automatic refresh batches to observe before scrolling (default: 0)
  AUTO_REFRESH_PANEL_ID   Panel kept visible while observing automatic refreshes
  AUTO_REFRESH_TIMEOUT_MS Maximum wait for each automatic refresh batch (default: 120000)
  VERIFY_INTERACTIONS     Set to 0 to skip tooltip checks in refresh-only stress runs
  VERIFY_SYNCED_CURSOR_MARKERS
                           Require every visible synchronized receiver to render a cursor marker
  REQUIRE_ALL_TIMESERIES_COMPACT
                           Fail when any queried time-series panel omits compact-v1
  GC_MODE                 none, settled, or retained (default: none)
  OFFSCREEN_SETTLE_MS     Wait at the bottom before the final sample (default: 0)
  HEAP_SNAPSHOT           Set to 1 to capture the active dashboard heap
  HEADLESS                Set to 1 for headless Chromium
  CHROMIUM_PATH           Optional Chromium executable
  OUTPUT_DIR              Artifact directory (default: /tmp/grafana-compact-full-dashboard)`);
  process.exit(dashboardJson ? 0 : 1);
}

const responseFormat = readResponseFormat();
const compactGrafanaUrl = process.env.GRAFANA_URL ?? 'http://127.0.0.1:3000';
const legacyGrafanaUrl = process.env.LEGACY_GRAFANA_URL ?? compactGrafanaUrl;
const options = {
  baseUrl: responseFormat === 'legacy-json' ? legacyGrafanaUrl : compactGrafanaUrl,
  username: process.env.GRAFANA_USER ?? 'admin',
  password: process.env.GRAFANA_PASSWORD ?? 'admin',
  responseFormat,
  seriesPerQuery: readPositiveInteger('SERIES_PER_QUERY', 20),
  pointCount: readPositiveInteger('POINT_COUNT', 120),
  dashboardFrom: readOptionalTimestamp('DASHBOARD_FROM'),
  dashboardTo: readOptionalTimestamp('DASHBOARD_TO'),
  scrollStepViewports: readPositiveNumber('SCROLL_STEP_VIEWPORTS', 0.8),
  scrollSettleMs: readNonNegativeInteger('SCROLL_SETTLE_MS', 250),
  maxScrollSteps: readNonNegativeInteger('MAX_SCROLL_STEPS', 0),
  sampleEvery: readPositiveInteger('SAMPLE_EVERY', 5),
  scrollCycles: readPositiveInteger('SCROLL_CYCLES', 1),
  bidirectionalScroll: process.env.BIDIRECTIONAL_SCROLL === '1',
  preserveDashboardRefresh: process.env.PRESERVE_DASHBOARD_REFRESH === '1',
  autoRefreshes: readNonNegativeInteger('AUTO_REFRESHES', 0),
  autoRefreshPanelId: process.env.AUTO_REFRESH_PANEL_ID,
  autoRefreshTimeoutMs: readPositiveInteger('AUTO_REFRESH_TIMEOUT_MS', 120_000),
  verifyInteractions: process.env.VERIFY_INTERACTIONS !== '0',
  verifySyncedCursorMarkers: process.env.VERIFY_SYNCED_CURSOR_MARKERS === '1',
  requireAllTimeSeriesCompact: process.env.REQUIRE_ALL_TIMESERIES_COMPACT === '1',
  gcMode: readGcMode(),
  offscreenSettleMs: readNonNegativeInteger('OFFSCREEN_SETTLE_MS', 0),
  heapSnapshot: process.env.HEAP_SNAPSHOT === '1',
  headless: process.env.HEADLESS === '1',
  chromiumPath: process.env.CHROMIUM_PATH,
  outputDir: process.env.OUTPUT_DIR ?? '/tmp/grafana-compact-full-dashboard',
  dashboardUid: process.env.DASHBOARD_UID ?? `${DASHBOARD_UID}-${process.pid}`,
};
if ((options.dashboardFrom == null) !== (options.dashboardTo == null)) {
  throw new Error('DASHBOARD_FROM and DASHBOARD_TO must be provided together');
}
if (options.dashboardFrom != null && options.dashboardTo <= options.dashboardFrom) {
  throw new Error('DASHBOARD_TO must be greater than DASHBOARD_FROM');
}
if (options.autoRefreshes > 0 && !options.preserveDashboardRefresh) {
  throw new Error('AUTO_REFRESHES requires PRESERVE_DASHBOARD_REFRESH=1');
}

const fixture = await createFullDashboardFixture(dashboardJson, options.pointCount, {
  preserveRefresh: options.preserveDashboardRefresh,
});
fixture.dashboard.uid = options.dashboardUid;
await fs.mkdir(options.outputDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: options.chromiumPath ?? chromium.executablePath(),
  headless: options.headless,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const context = await browser.newContext({ viewport: { width: 1800, height: 1100 } });
await installCanvasActivityProbe(context);
await installDashboardScrollProbe(context);
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
  if (headers['x-dashboard-uid'] !== options.dashboardUid) {
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
      queries: requestBody.queries,
      seriesPerQuery: options.seriesPerQuery,
      pointCount: options.pointCount,
      from: Number(requestBody.from),
      to: Number(requestBody.to),
      gappedSeriesEvery: 8,
      gapEvery: 17,
      seed: stableSeed(headers['x-panel-id'], refIds, requestBody.from, requestBody.to),
    };
    const jsonResponse = buildJsonResponse(responseOptions);
    const response = compact ? buildCompactResponseFromGrafanaJson(JSON.parse(jsonResponse), refIds) : jsonResponse;
    const generatedAt = performance.now();
    const responseBody = Buffer.from(response);
    const rawResponseBytes = responseBody.byteLength;

    queryRequests.push({
      requestNumber,
      panelId: headers['x-panel-id'],
      panelTitle: headers['x-panel-title'],
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
if (options.responseFormat === 'legacy-json') {
  await context.route('**/api/ds/query**', async (route) => {
    const headers = { ...route.request().headers() };
    delete headers[COMPACT_HEADER];
    await route.fallback({ headers });
  });
}
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

  const dashboardFrom = options.dashboardFrom ?? 'now-1h';
  const dashboardTo = options.dashboardTo ?? 'now';
  const dashboardUrl =
    `${options.baseUrl}/d/${options.dashboardUid}/full-dashboard-local?orgId=1` +
    `&from=${encodeURIComponent(dashboardFrom)}&to=${encodeURIComponent(dashboardTo)}`;
  const navigationStartedAt = performance.now();
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitForQueryIdle(120_000);
  await waitForCanvasIdle(page, 120_000);
  await waitForVisibleCharts(page);
  report.navigationMs = round(performance.now() - navigationStartedAt);
  report.initialPanelRenders = await collectPanelRenderDiagnostics(page);
  report.samples.push(await collectBrowserSample(cdp, page, 'scroll-0', options.gcMode === 'retained'));
  report.interactions = options.verifyInteractions
    ? {
        initial: await verifyVisibleChartInteraction(page),
      }
    : {};
  if (options.verifySyncedCursorMarkers) {
    report.synchronizedCursorMarkers = await verifySynchronizedCursorMarkers(page);
  }
  if (options.autoRefreshPanelId != null) {
    report.autoRefreshTarget = await focusAutoRefreshPanel(page, options.autoRefreshPanelId);
  }
  report.autoRefreshes = [];
  for (let refreshIndex = 0; refreshIndex < options.autoRefreshes; refreshIndex++) {
    report.autoRefreshes.push(await observeAutomaticRefresh(page, cdp, refreshIndex + 1));
  }
  report.scrollCycles = [];

  for (let cycle = 1; cycle <= options.scrollCycles; cycle++) {
    if (cycle > 1) {
      await scrollDashboardTo(page, 0);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
      await waitForQueryIdle(120_000);
      await waitForCanvasIdle(page, 120_000);
      await waitForVisibleCharts(page);
      report.samples.push(
        await collectBrowserSample(cdp, page, `cycle-${cycle}-refresh`, options.gcMode === 'retained')
      );
    }

    const scroll = await scrollDashboard(page, cdp, report, cycle);
    report.scrollCycles.push(scroll);
    report.scroll ??= scroll;
    if (scroll.reachedBottom) {
      if (options.verifyInteractions) {
        const bottomInteraction = await verifyVisibleChartInteraction(page, false);
        report.interactions[`cycle-${cycle}-bottom`] = bottomInteraction;
        report.interactions.bottom = bottomInteraction;
      }
    }
    if (options.bidirectionalScroll && scroll.reachedBottom) {
      const reverse = await scrollDashboard(page, cdp, report, cycle, true);
      report.scrollCycles.push(reverse);
      if (options.verifyInteractions) {
        report.interactions[`cycle-${cycle}-top`] = await verifyVisibleChartInteraction(page);
      }
    }
  }

  if (options.offscreenSettleMs > 0) {
    await page.waitForTimeout(options.offscreenSettleMs);
    await waitForQueryIdle(120_000);
    await waitForCanvasIdle(page, 120_000);
    report.samples.push(await collectBrowserSample(cdp, page, 'offscreen-settled', options.gcMode !== 'none'));
  }

  await page.screenshot({ path: path.join(options.outputDir, 'dashboard-bottom.png') });
  const requestsBeforeReentry = queryRequests.length;
  const reentryStartedAt = performance.now();
  await scrollDashboardTo(page, 0);
  await waitForQueryIdle(120_000);
  await waitForCanvasIdle(page, 120_000);
  await waitForVisibleCharts(page);
  report.reentry = {
    durationMs: round(performance.now() - reentryStartedAt),
    additionalRequests: queryRequests.length - requestsBeforeReentry,
  };
  if (!options.preserveDashboardRefresh && report.reentry.additionalRequests !== 0) {
    throw new Error(`Dashboard reentry issued ${report.reentry.additionalRequests} unexpected queries`);
  }
  if (options.verifyInteractions) {
    report.interactions.reentry = await verifyVisibleChartInteraction(page);
  }
  if (options.verifySyncedCursorMarkers) {
    report.synchronizedCursorMarkersReentry = await verifySynchronizedCursorMarkers(page);
  }
  report.samples.push(await collectBrowserSample(cdp, page, 'reentry-top', options.gcMode !== 'none'));
  await page.screenshot({ path: path.join(options.outputDir, 'dashboard-top.png') });

  if (pageErrors.length > 0) {
    throw new Error(`Browser reported errors:\n${pageErrors.join('\n')}`);
  }
  const failedRequests = queryRequests.filter((request) => request.error);
  if (failedRequests.length > 0) {
    throw new Error(`${failedRequests.length} local query responses failed`);
  }
  report.summary = summarize(report);
  if (options.responseFormat === 'auto' && report.summary.compactRequestCount === 0) {
    throw new Error('Compact dashboard run did not issue any compact-v1 requests');
  }
  if (
    options.responseFormat === 'auto' &&
    options.requireAllTimeSeriesCompact &&
    (report.summary.timeSeriesFormatAudit.jsonPanelCount > 0 ||
      report.summary.timeSeriesFormatAudit.mixedPanelCount > 0 ||
      report.summary.timeSeriesFormatAudit.missingPanelCount > 0)
  ) {
    throw new Error(
      `Strict compact audit failed: ${report.summary.timeSeriesFormatAudit.jsonPanelCount} JSON, ` +
        `${report.summary.timeSeriesFormatAudit.mixedPanelCount} mixed, ` +
        `${report.summary.timeSeriesFormatAudit.missingPanelCount} missing time-series panels`
    );
  }
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

async function scrollDashboard(page, cdp, report, cycle, reverse = false) {
  const dimensions = await page.evaluate(() => window.__dashboardScrollHarness.metrics());
  const stepPixels = Math.max(1, Math.floor(dimensions.viewportHeight * options.scrollStepViewports));
  const bottom = Math.max(0, dimensions.documentHeight - dimensions.viewportHeight);
  const allPositions = [];
  for (let position = stepPixels; position < bottom; position += stepPixels) {
    allPositions.push(position);
  }
  allPositions.push(bottom);
  let positions = options.maxScrollSteps > 0 ? allPositions.slice(0, options.maxScrollSteps) : allPositions;
  if (reverse) {
    positions = [0, ...positions.slice(0, -1)].reverse();
  }

  const steps = [];
  for (let index = 0; index < positions.length; index++) {
    await page.evaluate(() => window.__dashboardCanvasActivity.arm());
    const startedAt = performance.now();
    await scrollDashboardTo(page, positions[index]);
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
    const direction = reverse ? 'up' : 'down';
    const label = cycle === 1 ? `scroll-${direction}-${index + 1}` : `cycle-${cycle}-scroll-${direction}-${index + 1}`;
    const light = await collectBrowserSample(cdp, page, label, false);
    if (Math.abs(light.dom.scrollY - positions[index]) > 2) {
      throw new Error(`Dashboard stopped at scroll position ${light.dom.scrollY}, expected ${positions[index]}`);
    }
    const step = {
      index: index + 1,
      y: positions[index],
      durationMs: round(performance.now() - startedAt),
      requests: queryRequests.length,
      usedHeapMB: light.usedHeapMB,
      embedderHeapMB: light.embedderHeapMB,
      backingStorageMB: light.backingStorageMB,
      dom: light.dom,
      panelRenders: await collectPanelRenderDiagnostics(page),
    };
    steps.push(step);
    if ((index + 1) % options.sampleEvery === 0 || index === positions.length - 1) {
      report.samples.push(
        await collectBrowserSample(
          cdp,
          page,
          `${label}${options.gcMode === 'retained' ? '-gc' : ''}`,
          options.gcMode === 'retained'
        )
      );
    }
  }
  return {
    viewportHeight: dimensions.viewportHeight,
    documentHeight: dimensions.documentHeight,
    stepPixels,
    direction: reverse ? 'up' : 'down',
    reachedBottom: !reverse && positions.at(-1) === bottom,
    reachedTop: reverse && positions.at(-1) === 0,
    steps,
  };
}

async function waitForQueryIdle(timeoutMs, quietMs = 500) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (activeRequests === 0 && performance.now() - lastRequestActivityAt >= quietMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for dashboard queries to become idle (${activeRequests} active)`);
}

async function observeAutomaticRefresh(page, cdp, index) {
  const requestStartIndex = queryRequests.length;
  const waitStartedAt = performance.now();
  await page.evaluate(() => window.__dashboardCanvasActivity.arm());
  while (queryRequests.length === requestStartIndex) {
    if (performance.now() - waitStartedAt >= options.autoRefreshTimeoutMs) {
      throw new Error(`Timed out waiting for automatic dashboard refresh ${index}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const firstRequestObservedAt = performance.now();
  await waitForQueryIdle(options.autoRefreshTimeoutMs);
  await waitForCanvasIdle(page, options.autoRefreshTimeoutMs);
  await assertNoVisiblePanelErrors(page);
  const completedAt = performance.now();
  const requests = queryRequests.slice(requestStartIndex);
  if (
    options.autoRefreshPanelId != null &&
    !requests.some((request) => String(request.panelId) === options.autoRefreshPanelId)
  ) {
    throw new Error(`Automatic refresh ${index} did not query panel ${options.autoRefreshPanelId}`);
  }
  const label = `auto-refresh-${index}`;
  report.samples.push(await collectBrowserSample(cdp, page, label, false));

  return {
    index,
    waitForStartMs: round(firstRequestObservedAt - waitStartedAt),
    requestToCanvasIdleMs: round(completedAt - firstRequestObservedAt),
    requestCount: requests.length,
    compactRequestCount: requests.filter((request) => request.responseFormat === 'compact-v1').length,
    jsonRequestCount: requests.filter((request) => request.responseFormat === 'json').length,
    rawResponseMB: round(requests.reduce((total, request) => total + (request.rawResponseBytes ?? 0), 0) / 1024 / 1024),
    panelRenders: await collectPanelRenderDiagnostics(page),
  };
}

async function focusAutoRefreshPanel(page, panelId) {
  const panels = fixture.source.replayTimeSeriesPanels.filter((candidate) => candidate.id === panelId);
  const panel = panels[0];
  if (!panel) {
    throw new Error(`AUTO_REFRESH_PANEL_ID ${panelId} is not a replayed time-series panel`);
  }
  if (panels.length > 1) {
    throw new Error(`AUTO_REFRESH_PANEL_ID ${panelId} is ambiguous in the replayed dashboard`);
  }

  const requestsBeforeFocus = queryRequests.length;
  const dimensions = await page.evaluate(() => window.__dashboardScrollHarness.metrics());
  const bottom = Math.max(0, dimensions.documentHeight - dimensions.viewportHeight);
  const step = Math.max(1, Math.floor(dimensions.viewportHeight / 2));
  let found = false;
  for (let top = 0; top <= bottom; top = Math.min(top + step, bottom)) {
    await scrollDashboardTo(page, top);
    await page.waitForTimeout(100);
    found = await page.evaluate((title) => {
      const expected = `data-testid Panel header ${title}`;
      const header = Array.from(document.querySelectorAll('[data-testid^="data-testid Panel header "]')).find(
        (candidate) => candidate.getAttribute('data-testid') === expected
      );
      header?.scrollIntoView({ block: 'center' });
      return header != null;
    }, panel.title);
    if (found || top === bottom) {
      break;
    }
  }
  if (!found) {
    throw new Error(`Could not find dashboard panel ${panelId} (${panel.title})`);
  }

  await waitForQueryIdle(120_000, 5_000);
  await waitForCanvasIdle(page, 120_000);
  await assertNoVisiblePanelErrors(page);
  const targetWasQueried = queryRequests
    .slice(requestsBeforeFocus)
    .some((request) => String(request.panelId) === panelId);
  if (!targetWasQueried && !queryRequests.some((request) => String(request.panelId) === panelId)) {
    throw new Error(`Panel ${panelId} did not query after being scrolled into view`);
  }

  return {
    panelId,
    panelTitle: panel.title,
    additionalRequests: queryRequests.length - requestsBeforeFocus,
  };
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
      return lastOperationAt > 0 && performance.now() - lastOperationAt >= 250;
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

async function verifyVisibleChartInteraction(page, requireTooltip = true) {
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
  if (requireTooltip) {
    throw new Error('Visible chart canvases did not produce a tooltip');
  }
  return {
    hoverToTooltipMs: null,
    tooltipVisible: false,
  };
}

async function verifySynchronizedCursorMarkers(page) {
  const overlays = page.locator('.uplot .u-over:visible');
  const count = await overlays.count();
  if (count < 2) {
    throw new Error('Synchronized cursor verification requires at least two visible plots');
  }

  const attempts = [];
  for (let index = 0; index < count; index++) {
    const overlay = overlays.nth(index);
    const bounds = await overlay.boundingBox();
    if (!bounds) {
      continue;
    }
    const activePlotIndex = await overlay.evaluate((element) => {
      const activePlot = element.closest('.uplot');
      const visiblePlots = Array.from(document.querySelectorAll('.uplot')).filter((plot) => {
        const bounds = plot.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < window.innerHeight;
      });
      return visiblePlots.indexOf(activePlot);
    });

    await page.mouse.move(1, 1);
    await page.mouse.move(bounds.x + bounds.width * 0.55, bounds.y + bounds.height * 0.45);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForTimeout(50);
    const cursorMarkers = await collectVisibleCursorMarkers(page, activePlotIndex);
    try {
      assertSynchronizedCursorMarkers(cursorMarkers, activePlotIndex);
      return { activePlotIndex, cursorMarkers, attempts };
    } catch (error) {
      attempts.push({
        activePlotIndex,
        cursorMarkers,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw new Error(`No visible plot produced synchronized cursor markers: ${JSON.stringify(attempts)}`);
}

async function collectVisibleCursorMarkers(page, activePlotIndex) {
  return page.evaluate((sourceIndex) => {
    const visiblePlots = Array.from(document.querySelectorAll('.uplot')).filter((plot) => {
      const bounds = plot.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < window.innerHeight;
    });
    return visiblePlots.map((plot, plotIndex) => {
      const marker = plot.querySelector('.u-cursor-pt');
      const cursorLine = plot.querySelector('.u-cursor-x');
      const markerStyle = marker ? getComputedStyle(marker) : null;
      const cursorLineStyle = cursorLine ? getComputedStyle(cursorLine) : null;
      const markerBounds = marker?.getBoundingClientRect();
      return {
        plotIndex,
        source: plotIndex === sourceIndex,
        cursorLineVisible:
          cursorLine != null && !cursorLine.classList.contains('u-off') && cursorLineStyle?.display !== 'none',
        markerVisible: marker != null && !marker.classList.contains('u-off') && markerStyle?.display !== 'none',
        width: markerBounds?.width ?? 0,
        height: markerBounds?.height ?? 0,
        backgroundColor: markerStyle?.backgroundColor ?? '',
        borderColor: markerStyle?.borderColor ?? '',
        borderWidth: Number.parseFloat(markerStyle?.borderTopWidth ?? '0'),
        transform: markerStyle?.transform ?? '',
      };
    });
  }, activePlotIndex);
}

function assertSynchronizedCursorMarkers(cursorMarkers, activePlotIndex) {
  if (activePlotIndex < 0 || cursorMarkers.length < 2) {
    throw new Error('Synchronized cursor verification requires a visible source plot and at least one receiver');
  }
  const receivers = cursorMarkers.filter((marker) => !marker.source);
  const invalid = receivers.filter(
    (marker) =>
      !marker.cursorLineVisible ||
      !marker.markerVisible ||
      marker.width <= 0 ||
      marker.width !== marker.height ||
      marker.borderWidth <= 0 ||
      marker.backgroundColor === '' ||
      marker.backgroundColor === 'rgba(0, 0, 0, 0)' ||
      !hasTranslucentBorder(marker.borderColor)
  );
  if (invalid.length > 0) {
    throw new Error(`Synchronized cursor receivers did not render valid markers: ${JSON.stringify(invalid)}`);
  }
}

function hasTranslucentBorder(color) {
  const match = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(color);
  if (!match) {
    return false;
  }
  const alpha = Number(match[1]);
  return alpha > 0 && alpha < 1;
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
    const scroll = window.__dashboardScrollHarness.metrics();
    return {
      nodes: document.getElementsByTagName('*').length,
      canvases: document.querySelectorAll('canvas').length,
      uplots: document.querySelectorAll('.uplot').length,
      legendItems: document.querySelectorAll('[data-testid^="data-testid VizLegend series "]').length,
      legendTableRows: document.querySelectorAll('table tbody tr').length,
      panels: panels.length,
      visiblePanels: visiblePanels.length,
      scrollY: scroll.scrollY,
      documentHeight: scroll.documentHeight,
    };
  });
}

async function collectPanelRenderDiagnostics(page) {
  return page.evaluate(() => window.__dashboardCanvasActivity.snapshot());
}

async function scrollDashboardTo(page, top) {
  await page.evaluate((scrollTop) => window.__dashboardScrollHarness.scrollTo(scrollTop), top);
}

function summarize(report) {
  const compactRequests = queryRequests.filter((request) => request.responseFormat === 'compact-v1');
  const jsonRequests = queryRequests.filter((request) => request.responseFormat === 'json');
  const samples = report.samples;
  const measurements = [
    ...samples,
    ...report.scrollCycles
      .flatMap((scroll) => scroll.steps)
      .map((step) => ({
        usedHeapMB: step.usedHeapMB,
        backingStorageMB: step.backingStorageMB,
        dom: step.dom,
      })),
  ];
  const retainedSamples = samples.filter((sample) => sample.collectedAfterGC);
  const panelRenders = [
    ...(report.initialPanelRenders ?? []),
    ...report.scrollCycles.flatMap((scroll) => scroll.steps.flatMap((step) => step.panelRenders ?? [])),
  ];
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
    timeSeriesFormatAudit: summarizeTimeSeriesFormats(report.fixture.replayTimeSeriesPanels ?? [], queryRequests),
    requestManifest: queryRequests
      .map((request) => ({
        panelId: request.panelId,
        refIds: request.refIds,
        from: request.from,
        to: request.to,
      }))
      .sort((left, right) => String(left.panelId).localeCompare(String(right.panelId))),
    maxScrollStepMs: Math.max(...report.scrollCycles.flatMap((scroll) => scroll.steps.map((step) => step.durationMs))),
    medianScrollStepMs: median(report.scrollCycles.flatMap((scroll) => scroll.steps.map((step) => step.durationMs))),
    panelRenderCount: panelRenders.length,
    panelFirstDrawP75Ms: percentile(
      panelRenders.map((render) => render.firstDrawLatencyMs),
      0.75
    ),
    panelFirstDrawP95Ms: percentile(
      panelRenders.map((render) => render.firstDrawLatencyMs),
      0.95
    ),
    panelCompleteP75Ms: percentile(
      panelRenders.map((render) => render.completeLatencyMs),
      0.75
    ),
    panelCompleteP95Ms: percentile(
      panelRenders.map((render) => render.completeLatencyMs),
      0.95
    ),
    autoRefreshCount: report.autoRefreshes?.length ?? 0,
    autoRefreshRequestToCanvasIdleP75Ms: percentile(
      (report.autoRefreshes ?? []).map((refresh) => refresh.requestToCanvasIdleMs),
      0.75
    ),
    autoRefreshRequestToCanvasIdleP95Ms: percentile(
      (report.autoRefreshes ?? []).map((refresh) => refresh.requestToCanvasIdleMs),
      0.95
    ),
  };
}

function summarizeTimeSeriesFormats(panels, requests) {
  const requestsByPanel = new Map();
  for (const request of requests) {
    if (request.panelPluginId !== 'timeseries' || request.error) {
      continue;
    }
    const panelId = String(request.panelId);
    const formats = requestsByPanel.get(panelId) ?? new Set();
    formats.add(request.requestedFormat);
    requestsByPanel.set(panelId, formats);
  }

  const excludedPanels = panels.filter((panel) => !panel.compactTransportEligible);
  const panelResults = panels
    .filter((panel) => panel.compactTransportEligible)
    .map((panel) => {
      const formats = [...(requestsByPanel.get(panel.id) ?? [])].sort();
      const status =
        formats.length === 0
          ? 'missing'
          : formats.length === 1 && formats[0] === 'compact-v1'
            ? 'compact'
            : formats.length === 1 && formats[0] === 'json'
              ? 'json'
              : 'mixed';
      return { ...panel, status, formats };
    });

  return {
    expectedPanelCount: panelResults.length,
    compactPanelCount: panelResults.filter((panel) => panel.status === 'compact').length,
    jsonPanelCount: panelResults.filter((panel) => panel.status === 'json').length,
    mixedPanelCount: panelResults.filter((panel) => panel.status === 'mixed').length,
    missingPanelCount: panelResults.filter((panel) => panel.status === 'missing').length,
    nonCompactPanels: panelResults.filter((panel) => panel.status !== 'compact'),
    excludedPanelCount: excludedPanels.length,
    excludedPanels,
  };
}

async function installCanvasActivityProbe(context) {
  await context.addInitScript(() => {
    const canvasRecords = new WeakMap();
    const activity = {
      epoch: 1,
      armedAt: 0,
      lastOperationAt: 0,
      arm() {
        this.epoch++;
        this.armedAt = performance.now();
        this.lastOperationAt = this.armedAt;
      },
      snapshot() {
        const headers = Array.from(document.querySelectorAll('[data-testid^="data-testid Panel header "]'));
        const renders = new Map();
        for (const canvas of document.querySelectorAll('.uplot canvas')) {
          const bounds = canvas.getBoundingClientRect();
          if (bounds.width <= 0 || bounds.height <= 0 || bounds.bottom <= 0 || bounds.top >= window.innerHeight) {
            continue;
          }
          const record = canvasRecords.get(canvas);
          if (!record || record.epoch !== this.epoch) {
            continue;
          }
          let container = canvas.parentElement;
          let header;
          while (container && container !== document.body) {
            header = container.querySelector('[data-testid^="data-testid Panel header "]');
            if (header) {
              break;
            }
            container = container.parentElement;
          }
          const headerIndex = header ? headers.indexOf(header) : -1;
          const headerTestId = header?.getAttribute('data-testid') ?? 'unknown-panel';
          const key = `${headerIndex}:${headerTestId}`;
          const existing = renders.get(key);
          const firstOperationAt = Math.min(existing?.firstOperationAt ?? Infinity, record.firstOperationAt);
          const lastOperationAt = Math.max(existing?.lastOperationAt ?? -Infinity, record.lastOperationAt);
          renders.set(key, {
            panelKey: key,
            panelTitle: headerTestId.replace('data-testid Panel header ', ''),
            firstOperationAt,
            lastOperationAt,
            canvasCount: (existing?.canvasCount ?? 0) + 1,
          });
        }
        return Array.from(renders.values(), (render) => ({
          panelKey: render.panelKey,
          panelTitle: render.panelTitle,
          canvasCount: render.canvasCount,
          firstDrawLatencyMs: Math.round((render.firstOperationAt - this.armedAt) * 100) / 100,
          completeLatencyMs: Math.round((render.lastOperationAt - this.armedAt) * 100) / 100,
        }));
      },
    };
    window.__dashboardCanvasActivity = activity;
    for (const method of ['clearRect', 'stroke', 'fill', 'fillRect', 'strokeRect', 'lineTo', 'arc']) {
      const original = CanvasRenderingContext2D.prototype[method];
      CanvasRenderingContext2D.prototype[method] = function (...args) {
        const now = performance.now();
        activity.lastOperationAt = now;
        const current = canvasRecords.get(this.canvas);
        if (!current || current.epoch !== activity.epoch) {
          canvasRecords.set(this.canvas, { epoch: activity.epoch, firstOperationAt: now, lastOperationAt: now });
        } else {
          current.lastOperationAt = now;
        }
        return original.apply(this, args);
      };
    }
  });
}

async function installDashboardScrollProbe(context) {
  await context.addInitScript(() => {
    let scrollContainer;
    const getScrollContainer = () => {
      if (scrollContainer?.isConnected) {
        return scrollContainer;
      }

      scrollContainer =
        document.querySelector('[data-testid="data-testid DashboardEditPaneSplitter body container"]') ??
        document.scrollingElement ??
        document.documentElement;
      return scrollContainer;
    };

    window.__dashboardScrollHarness = {
      metrics() {
        const container = getScrollContainer();
        return {
          viewportHeight: container.clientHeight,
          documentHeight: container.scrollHeight,
          scrollY: Math.round(container.scrollTop),
        };
      },
      scrollTo(top) {
        getScrollContainer().scrollTo({ top, behavior: 'instant' });
      },
    };
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
    const audit = report.summary.timeSeriesFormatAudit;
    console.log(
      `Time-series panels: ${audit.compactPanelCount}/${audit.expectedPanelCount} compact, ` +
        `${audit.jsonPanelCount} JSON, ${audit.mixedPanelCount} mixed, ${audit.missingPanelCount} missing, ` +
        `${audit.excludedPanelCount} transport-ineligible`
    );
    console.log(`Uncompressed response bytes: ${report.summary.rawResponseMB}MB`);
    console.log(
      `Peak: JS=${report.summary.peakUsedHeapMB}MB embedder=${report.summary.peakEmbedderHeapMB}MB backing=${report.summary.peakBackingStorageMB}MB DOM=${report.summary.peakDomNodes} uPlot=${report.summary.peakUPlots}`
    );
    console.log(
      `Scroll: median=${report.summary.medianScrollStepMs}ms max=${report.summary.maxScrollStepMs}ms reentry=${report.reentry.durationMs}ms requests=${report.reentry.additionalRequests}`
    );
    if (report.summary.autoRefreshCount > 0) {
      console.log(
        `Auto refresh: count=${report.summary.autoRefreshCount} request-to-canvas-idle p75=${report.summary.autoRefreshRequestToCanvasIdleP75Ms}ms p95=${report.summary.autoRefreshRequestToCanvasIdleP95Ms}ms`
      );
    }
  }
  if (report.interactions?.initial) {
    const bottom = report.interactions.bottom?.tooltipVisible
      ? ` bottom=${report.interactions.bottom.hoverToTooltipMs}ms`
      : report.interactions.bottom
        ? ' bottom=tooltip-disabled'
        : '';
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
  if (value !== 'none' && value !== 'settled' && value !== 'retained') {
    throw new Error('GC_MODE must be none, settled, or retained');
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

function percentile(values, quantile) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return round(sorted[index]);
}

function bytesToMB(value) {
  return round(value / (1024 * 1024));
}

function round(value) {
  return Math.round(value * 100) / 100;
}
