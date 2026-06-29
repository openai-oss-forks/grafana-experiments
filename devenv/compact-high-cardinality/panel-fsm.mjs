import { createHash } from 'node:crypto';
import path from 'node:path';

const PLUGINS = {
  timeseries: 'Time series',
  barchart: 'Bar chart',
  table: 'Table',
};

const TRANSITIONS = [
  { name: 'time-series-lines', plugin: 'timeseries', style: 'Lines', format: 'compact-v1', screenshot: true },
  {
    name: 'time-series-bars',
    plugin: 'timeseries',
    style: 'Bars',
    format: 'compact-v1',
    hover: 'focus',
    screenshot: true,
  },
  {
    name: 'time-series-points',
    plugin: 'timeseries',
    style: 'Points',
    format: 'compact-v1',
    screenshot: true,
  },
  { name: 'standalone-bar-chart', plugin: 'barchart', format: 'compact-v1', hover: 'tooltip', screenshot: true },
  { name: 'table-fallback', plugin: 'table', format: 'json', screenshot: true },
  { name: 'time-series-restored', plugin: 'timeseries', format: 'compact-v1' },
  { name: 'time-series-final-lines', plugin: 'timeseries', style: 'Lines', format: 'compact-v1', screenshot: true },
];

export async function runPanelFsm({
  page,
  queryRequests,
  waitForRequestCount,
  outputDir,
  baseUrl,
  dashboardUid,
  pageErrors,
  fixture,
}) {
  const report = { transitions: [], screenshots: [], hoverOptionQueryCount: 0 };
  await assertStableDashboard(page, pageErrors, 'initial-dashboard');
  await screenshot(page, outputDir, report, 'fsm-00-dashboard');
  report.exactOverride = await verifyExactOverridePanel(
    page,
    queryRequests,
    outputDir,
    report,
    baseUrl,
    dashboardUid,
    fixture
  );
  await openPanelEditor(page, fixture.transitionPanelTitle);

  for (const transition of TRANSITIONS) {
    const beforeCount = queryRequests.length;
    const pluginChanged = await selectPlugin(page, transition.plugin);
    let previousStyleHash;
    if (transition.style) {
      const beforeStyle = await chartScreenshotHash(page);
      const styleChanged = await selectTimeSeriesStyle(page, transition.style);
      previousStyleHash = styleChanged ? beforeStyle : undefined;
    }
    await settleUi(page);
    let naturalRequestCount = 0;
    let refreshRequestNumber;
    if (pluginChanged) {
      if (
        requestFormat(latestPanelRequest(queryRequests.slice(0, beforeCount), fixture.transitionPanelId)) !==
        transition.format
      ) {
        await waitForExpectedRequest(
          queryRequests,
          waitForRequestCount,
          transition.format,
          transition.plugin,
          beforeCount,
          fixture.transitionPanelId,
          true
        );
      } else {
        await page.waitForTimeout(250);
        await settleUi(page);
        assertRequestsMatch(
          panelRequests(queryRequests.slice(beforeCount), fixture.transitionPanelId),
          transition.format,
          transition.plugin
        );
      }
      naturalRequestCount = panelRequests(queryRequests.slice(beforeCount), fixture.transitionPanelId).length;
      const refreshStart = queryRequests.length;
      await page.getByTestId('data-testid RefreshPicker run button').click();
      await waitForExpectedRequest(
        queryRequests,
        waitForRequestCount,
        transition.format,
        transition.plugin,
        refreshStart,
        fixture.transitionPanelId,
        true
      );
      refreshRequestNumber = latestPanelRequest(queryRequests, fixture.transitionPanelId)?.requestNumber;
    } else {
      await page.waitForTimeout(250);
      assertRequestsMatch(
        panelRequests(queryRequests.slice(beforeCount), fixture.transitionPanelId),
        transition.format,
        transition.plugin
      );
      naturalRequestCount = panelRequests(queryRequests.slice(beforeCount), fixture.transitionPanelId).length;
      const refreshStart = queryRequests.length;
      await page.getByTestId('data-testid RefreshPicker run button').click();
      await waitForExpectedRequest(
        queryRequests,
        waitForRequestCount,
        transition.format,
        transition.plugin,
        refreshStart,
        fixture.transitionPanelId,
        true
      );
      refreshRequestNumber = latestPanelRequest(queryRequests, fixture.transitionPanelId)?.requestNumber;
    }
    const observation = await assertStableEditor(
      page,
      queryRequests,
      pageErrors,
      transition,
      previousStyleHash,
      fixture.transitionPanelId
    );
    observation.naturalRequestCount = naturalRequestCount;
    observation.refreshRequestNumber = refreshRequestNumber;
    if (transition.hover) {
      observation.hover = await verifyHover(page, transition.hover === 'focus');
    }
    report.transitions.push(observation);
    if (transition.screenshot) {
      await screenshot(
        page,
        outputDir,
        report,
        `fsm-${String(report.transitions.length).padStart(2, '0')}-${transition.name}`
      );
    }
  }
  assertDistinctStyleRendering(report.transitions);

  const queryCountBeforeHoverOption = queryRequests.length;
  report.highlightEnabled = await verifyHover(page, true);
  await toggleHoverHighlight(page);
  report.highlightDisabled = await verifyHover(page, false);
  await toggleHoverHighlight(page);
  report.highlightRestored = await verifyHover(page, true);
  await settleUi(page);
  report.hoverOptionQueryCount = queryRequests.length - queryCountBeforeHoverOption;
  if (report.hoverOptionQueryCount !== 0) {
    throw new Error(`Hover highlighting issued ${report.hoverOptionQueryCount} datasource queries`);
  }
  await assertStableEditor(page, queryRequests, pageErrors, TRANSITIONS.at(-1), undefined, fixture.transitionPanelId);

  await saveDashboard(page);
  report.saved = await readAndAssertSavedPanel(
    page,
    baseUrl,
    dashboardUid,
    fixture.transitionPanelId,
    'timeseries',
    'line',
    0
  );
  report.savedExactOverride = await readAndAssertSavedPanel(
    page,
    baseUrl,
    dashboardUid,
    fixture.exactPanelId,
    'timeseries',
    report.exactOverride.style,
    fixture.removedDrawStyleOverrides
  );

  await page.getByRole('button', { name: 'Back to dashboard' }).click();
  await assertStableDashboard(page, pageErrors, 'saved-dashboard');
  report.savedDashboardHover = await verifyHover(page, true);
  await screenshot(page, outputDir, report, 'fsm-08-saved-dashboard');

  const refreshStart = queryRequests.length;
  await page.getByTestId('data-testid RefreshPicker run button').click();
  await waitForExpectedRequest(
    queryRequests,
    waitForRequestCount,
    'compact-v1',
    'timeseries',
    refreshStart,
    fixture.transitionPanelId,
    true
  );
  await waitForExpectedRequest(
    queryRequests,
    waitForRequestCount,
    'compact-v1',
    'timeseries',
    refreshStart,
    fixture.exactPanelId,
    true
  );
  await assertStableDashboard(page, pageErrors, 'refreshed-dashboard');
  assertLatestRequest(queryRequests, 'compact-v1', 'timeseries', fixture.transitionPanelId);
  assertLatestRequest(queryRequests, 'compact-v1', 'timeseries', fixture.exactPanelId);
  report.refreshed = await readAndAssertSavedPanel(
    page,
    baseUrl,
    dashboardUid,
    fixture.transitionPanelId,
    'timeseries',
    'line',
    0
  );
  report.refreshedDashboardHover = await verifyHover(page, true);
  report.refreshedExactVisual = await assertVisualization(page, 'timeseries', 1);
  report.refreshedExactHover = await verifyHover(page, true, 1);
  await screenshot(page, outputDir, report, 'fsm-09-refreshed-dashboard');

  return report;
}

async function verifyExactOverridePanel(page, queryRequests, outputDir, report, baseUrl, dashboardUid, fixture) {
  const saved = await readAndAssertSavedPanel(
    page,
    baseUrl,
    dashboardUid,
    fixture.exactPanelId,
    'timeseries',
    undefined,
    fixture.removedDrawStyleOverrides
  );
  if (!fixture.exhaustiveBarOverrides) {
    return saved;
  }
  await openPanelEditor(page, fixture.exactPanelTitle);
  await selectTimeSeriesStyle(page, 'Lines');
  await settleUi(page);
  await page.mouse.move(1, 1);
  const linesHash = await chartScreenshotHash(page);
  await selectTimeSeriesStyle(page, 'Bars');
  await settleUi(page);
  await page.mouse.move(1, 1);
  const barsHash = await chartScreenshotHash(page);
  if (linesHash !== barsHash) {
    throw new Error('Per-query bar overrides did not preserve the rendered bars across global style changes');
  }
  const hover = await verifyHover(page, true);
  await screenshot(page, outputDir, report, 'fsm-01-exact-overrides');
  const discard = page.getByRole('button', { name: 'Discard panel changes' });
  if (await discard.isEnabled()) {
    await discard.click();
  } else {
    await page.getByRole('button', { name: 'Back to dashboard' }).click();
  }
  await page.getByTestId(`data-testid Panel header ${fixture.transitionPanelTitle}`).waitFor({
    state: 'visible',
    timeout: 30_000,
  });
  const discarded = await readAndAssertSavedPanel(
    page,
    baseUrl,
    dashboardUid,
    fixture.exactPanelId,
    'timeseries',
    saved.style,
    fixture.removedDrawStyleOverrides
  );
  assertLatestRequest(queryRequests, 'compact-v1', 'timeseries', fixture.exactPanelId);
  return { ...discarded, linesHash, barsHash, hover };
}

async function openPanelEditor(page, panelTitle) {
  const header = page.getByTestId(`data-testid Panel header ${panelTitle}`);
  await header.scrollIntoViewIfNeeded();
  await header.hover();
  const menu = page.getByLabel(`Menu for panel ${panelTitle}`, { exact: true });
  await menu.click();
  await page.getByRole('menuitem', { name: /^Edit\b/ }).click();
  await page.getByRole('button', { name: 'Change visualization' }).waitFor({ state: 'visible', timeout: 30_000 });
}

async function selectPlugin(page, pluginId) {
  const expectedName = PLUGINS[pluginId];
  const currentName = (await optionsHeader(page).textContent())?.trim();
  if (currentName === expectedName) {
    return false;
  }

  await page.getByRole('button', { name: 'Change visualization' }).click();
  const allVisualizations = page.getByRole('tab', { name: 'All visualizations' });
  if ((await allVisualizations.count()) > 0) {
    const selected = await allVisualizations.getAttribute('aria-selected');
    if (selected !== 'true') {
      await allVisualizations.click();
    }
  }
  const card = page.locator(`[data-testid$="Plugin visualization item ${expectedName}"]`);
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  await card.click();
  await optionsHeader(page).getByText(expectedName, { exact: true }).waitFor({ timeout: 30_000 });
  return true;
}

function optionsHeader(page) {
  return page.locator('[data-testid$="Panel editor OptionsPane header"]');
}

async function selectTimeSeriesStyle(page, style) {
  const field = page.getByLabel(/Graph styles Style field property editor/);
  if (!(await field.isVisible().catch(() => false))) {
    const expand = page.getByRole('button', { name: /Expand Graph styles category/ });
    if ((await expand.count()) > 0) {
      await expand.click();
    }
  }
  await field.waitFor({ state: 'visible', timeout: 30_000 });
  const option = field.getByRole('radio', { name: style, exact: true });
  if (!(await option.isChecked())) {
    await option.click();
    return true;
  }
  return false;
}

async function toggleHoverHighlight(page) {
  const label = page.getByText('Highlight hovered series', { exact: true });
  if (!(await label.isVisible().catch(() => false))) {
    const expand = page.getByRole('button', { name: /Expand Tooltip category/ });
    if ((await expand.count()) > 0) {
      await expand.click();
    }
  }
  await label.waitFor({ state: 'visible', timeout: 30_000 });
  await label.scrollIntoViewIfNeeded();
  const toggle = page.getByLabel(/Tooltip Highlight hovered series field property editor/).getByRole('switch');
  const previous = await toggle.isChecked();
  await label.click();
  if ((await toggle.isChecked()) === previous) {
    throw new Error('Highlight hovered series did not toggle');
  }
  await settleUi(page);
}

async function verifyHover(page, expectFocusOverlay, panelIndex = 0) {
  await page.mouse.move(1, 1);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const panel = page
    .locator('[data-testid="data-testid panel content"]')
    .filter({ has: page.locator('.uplot') })
    .nth(panelIndex);
  await panel.scrollIntoViewIfNeeded();
  const bounds = await panel.locator('.u-over').boundingBox();
  if (!bounds) {
    throw new Error('Hover verification found no plot bounds');
  }
  const tooltip = page.locator('[data-testid="data-testid viz-tooltip-wrapper"]').first();
  const positions = [
    [0.5, 0.5],
    [0.25, 0.25],
    [0.5, 0.25],
    [0.75, 0.5],
    [0.75, 0.75],
  ];
  const startedAt = Date.now();
  let overlayCount = 0;
  let tooltipVisible = false;
  for (const [x, y] of positions) {
    await page.mouse.move(bounds.x + bounds.width * x, bounds.y + bounds.height * y);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    tooltipVisible = await tooltip.isVisible().catch(() => false);
    overlayCount = await panel.locator('.u-compact-focus-overlay').count();
    if (tooltipVisible && overlayCount === (expectFocusOverlay ? 1 : 0)) {
      break;
    }
  }
  const elapsedMs = Date.now() - startedAt;
  if (!tooltipVisible) {
    throw new Error('Hover verification did not render a tooltip');
  }
  if (overlayCount !== (expectFocusOverlay ? 1 : 0)) {
    throw new Error(`Hover expected ${expectFocusOverlay ? 1 : 0} focus overlays, found ${overlayCount}`);
  }
  if (elapsedMs > 1_000) {
    throw new Error(`Hover verification took ${elapsedMs}ms`);
  }
  const tooltipTextLength = ((await tooltip.textContent()) ?? '').trim().length;
  if (tooltipTextLength === 0) {
    throw new Error('Hover tooltip rendered no text');
  }
  let focusCanvasPainted = false;
  let focusColorCount = 0;
  let focusGeometryPixels = 0;
  if (expectFocusOverlay) {
    const focusEvidence = await panel.locator('.u-compact-focus-overlay').evaluate((canvas) => {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context || canvas.width <= 0 || canvas.height <= 0) {
        return { paintedPixels: 0, colorCount: 0, geometryPixels: 0 };
      }
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const colorCounts = new Map();
      let paintedPixels = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const alpha = pixels[offset + 3];
        if (alpha === 0) {
          continue;
        }
        paintedPixels++;
        const color = `${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]},${alpha}`;
        colorCounts.set(color, (colorCounts.get(color) ?? 0) + 1);
      }
      let backdropPixels = 0;
      for (const count of colorCounts.values()) {
        backdropPixels = Math.max(backdropPixels, count);
      }
      return {
        paintedPixels,
        colorCount: colorCounts.size,
        geometryPixels: paintedPixels - backdropPixels,
      };
    });
    focusCanvasPainted = focusEvidence.paintedPixels > 0;
    focusColorCount = focusEvidence.colorCount;
    focusGeometryPixels = focusEvidence.geometryPixels;
    if (!focusCanvasPainted || focusColorCount < 2 || focusGeometryPixels === 0) {
      throw new Error('Hover focus overlay contained only its dimming backdrop');
    }
  }
  await page.mouse.move(1, 1);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return {
    elapsedMs,
    tooltipTextLength,
    overlayCount,
    focusCanvasPainted,
    focusColorCount,
    focusGeometryPixels,
  };
}

async function waitForExpectedRequest(
  queryRequests,
  waitForRequestCount,
  expectedFormat,
  expectedPlugin,
  previousCount,
  panelId,
  requireNewRequest = false
) {
  if (!requireNewRequest && latestRequestMatches(queryRequests, expectedFormat, expectedPlugin, panelId)) {
    return;
  }
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const transitionRequests = panelRequests(queryRequests.slice(previousCount), panelId);
    assertRequestsMatch(transitionRequests, expectedFormat, expectedPlugin);
    if (transitionRequests.length > 0 && latestRequestMatches(queryRequests, expectedFormat, expectedPlugin, panelId)) {
      return;
    }
    await waitForRequestCount(queryRequests.length + 1, Math.max(1, deadline - Date.now()));
  }
  assertLatestRequest(queryRequests, expectedFormat, expectedPlugin, panelId);
}

function assertRequestsMatch(requests, expectedFormat, expectedPlugin) {
  const invalidRequest = requests.find(
    (request) => request.error || requestFormat(request) !== expectedFormat || request.responseFormat !== expectedFormat
  );
  if (invalidRequest) {
    throw new Error(
      invalidRequest.error ??
        `${expectedPlugin} transition requested ${requestFormat(invalidRequest)}/${invalidRequest.responseFormat}, expected ${expectedFormat}/${expectedFormat}`
    );
  }
}

function requestFormat(request) {
  return request?.preferredFormat ?? 'json';
}

async function assertStableEditor(page, queryRequests, pageErrors, expected, previousStyleHash, panelId) {
  await optionsHeader(page).getByText(PLUGINS[expected.plugin], { exact: true }).waitFor({ timeout: 30_000 });
  if (expected.style) {
    const style = page.getByLabel(/Graph styles Style field property editor/).getByRole('radio', {
      name: expected.style,
      exact: true,
    });
    if (!(await style.isChecked())) {
      throw new Error(`Expected ${expected.style} to be selected`);
    }
  }
  const visual = await assertVisualization(page, expected.plugin);
  if (visual.kind === 'chart') {
    visual.screenshotHash = previousStyleHash
      ? await waitForChartHashChange(page, previousStyleHash)
      : await chartScreenshotHash(page);
  }
  assertLatestRequest(queryRequests, expected.format, expected.plugin, panelId);
  assertNoBrowserErrors(pageErrors, expected.name);
  return {
    name: expected.name,
    plugin: expected.plugin,
    style: expected.style,
    expectedFormat: expected.format,
    requestNumber: latestPanelRequest(queryRequests, panelId)?.requestNumber,
    visual,
  };
}

async function assertStableDashboard(page, pageErrors, state) {
  const visual = await assertVisualization(page, 'timeseries');
  if (new URL(page.url()).searchParams.has('editPanel')) {
    throw new Error(`${state} remained in panel edit mode`);
  }
  assertNoBrowserErrors(pageErrors, state);
  return visual;
}

async function assertVisualization(page, plugin, panelIndex = 0) {
  await page.locator('[data-testid="data-testid panel content"]').nth(panelIndex).scrollIntoViewIfNeeded();
  await settleUi(page);
  const result = await page.waitForFunction(
    ({ plugin, panelIndex }) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return bounds.width > 0 && bounds.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const malformed = (text) => /Invalid date|\bNaN\b|\bundefined\b/i.test(text);
      const panel = Array.from(document.querySelectorAll('[data-testid="data-testid panel content"]'))[panelIndex];
      if (!panel || !visible(panel) || malformed(panel.textContent ?? '')) {
        return false;
      }
      if (plugin === 'table') {
        const table = Array.from(panel.querySelectorAll('table,[role="table"],[role="grid"]')).find(visible);
        if (!table || !(table.textContent ?? '').trim()) {
          return false;
        }
        return { kind: 'table', textLength: (table.textContent ?? '').trim().length };
      }

      const plot = Array.from(panel.querySelectorAll('.uplot')).find(visible);
      if (!plot || panel.querySelector('canvas[data-compact-frame-snapshot="true"]')) {
        return false;
      }
      const plotBounds = plot.getBoundingClientRect();
      const canvases = Array.from(plot.querySelectorAll('canvas')).filter(visible);
      let opaqueSamples = 0;
      let paintedCanvases = 0;
      for (const canvas of canvases) {
        const bounds = canvas.getBoundingClientRect();
        if (
          canvas.width <= 0 ||
          canvas.height <= 0 ||
          bounds.left < plotBounds.left - 1 ||
          bounds.top < plotBounds.top - 1 ||
          bounds.right > plotBounds.right + 1 ||
          bounds.bottom > plotBounds.bottom + 1
        ) {
          return false;
        }
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
          continue;
        }
        let canvasOpaque = 0;
        for (let row = 0; row < 10; row++) {
          const y = Math.min(canvas.height - 1, Math.floor(((row + 0.5) * canvas.height) / 10));
          for (let column = 0; column < 20; column++) {
            const x = Math.min(canvas.width - 1, Math.floor(((column + 0.5) * canvas.width) / 20));
            const pixel = context.getImageData(x, y, 1, 1).data;
            if (pixel[3] > 0) {
              canvasOpaque++;
            }
          }
        }
        if (canvasOpaque > 0) {
          paintedCanvases++;
          opaqueSamples += canvasOpaque;
        }
      }
      return paintedCanvases > 0
        ? { kind: 'chart', canvasCount: canvases.length, paintedCanvases, opaqueSamples }
        : false;
    },
    { plugin, panelIndex },
    { timeout: 120_000, polling: 100 }
  );
  const alerts = await page.locator('[role="alert"]:visible').allTextContents();
  const errors = alerts.filter((text) => /error|failed|invalid compact/i.test(text));
  if (errors.length > 0) {
    throw new Error(`Panel rendered an error: ${errors.join(' | ')}`);
  }
  return result.jsonValue();
}

async function waitForChartHashChange(page, previousHash) {
  const deadline = Date.now() + 10_000;
  let hash = await chartScreenshotHash(page);
  while (hash === previousHash && Date.now() < deadline) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    hash = await chartScreenshotHash(page);
  }
  if (hash === previousHash) {
    throw new Error('Selected style did not change the rendered chart screenshot');
  }
  return hash;
}

async function chartScreenshotHash(page) {
  const image = await page.locator('[data-testid="data-testid panel content"] .uplot').first().screenshot({
    animations: 'disabled',
  });
  return createHash('sha256').update(image).digest('hex');
}

function assertDistinctStyleRendering(transitions) {
  const styles = ['Lines', 'Bars', 'Points'].map((style) =>
    transitions.find((transition) => transition.style === style)
  );
  if (styles.some((transition) => transition?.visual.kind !== 'chart')) {
    throw new Error('Time series style transitions did not all produce chart evidence');
  }
  const hashes = new Set(styles.map((transition) => transition.visual.screenshotHash));
  if (hashes.size !== styles.length) {
    throw new Error(
      `Lines, Bars, and Points produced indistinguishable screenshots: ${styles.map((transition) => `${transition.style}=${transition.visual.screenshotHash}`).join(', ')}`
    );
  }
}

function assertLatestRequest(queryRequests, expectedFormat, expectedPlugin, panelId) {
  const request = latestPanelRequest(queryRequests, panelId);
  if (!request || request.error) {
    throw new Error(request?.error ?? 'No datasource request was captured');
  }
  const actual = requestFormat(request);
  if (
    actual !== expectedFormat ||
    request.responseFormat !== expectedFormat ||
    request.panelPluginId !== expectedPlugin
  ) {
    throw new Error(
      `Expected latest ${expectedPlugin} request/response to be ${expectedFormat}, received ${request.panelPluginId} ${actual}/${request.responseFormat}`
    );
  }
}

function latestRequestMatches(queryRequests, expectedFormat, expectedPlugin, panelId) {
  const request = latestPanelRequest(queryRequests, panelId);
  return (
    request?.panelPluginId === expectedPlugin &&
    requestFormat(request) === expectedFormat &&
    request.responseFormat === expectedFormat
  );
}

function panelRequests(requests, panelId) {
  return requests.filter((request) => String(request.panelId) === String(panelId));
}

function latestPanelRequest(requests, panelId) {
  return panelRequests(requests, panelId).at(-1);
}

async function saveDashboard(page) {
  await page.getByRole('button', { name: 'Save dashboard', exact: true }).click();
  const save = page.getByTestId('data-testid Save dashboard drawer button');
  await save.waitFor({ state: 'visible', timeout: 30_000 });
  await save.click();
  await save.waitFor({ state: 'detached', timeout: 30_000 });
}

async function readAndAssertSavedPanel(page, baseUrl, dashboardUid, panelId, plugin, style, drawStyleOverrideCount) {
  const response = await page.request.get(`${baseUrl}/api/dashboards/uid/${dashboardUid}`);
  if (!response.ok()) {
    throw new Error(`Dashboard readback failed: ${response.status()} ${await response.text()}`);
  }
  const body = await response.json();
  const panel = flattenPanels(body.dashboard?.panels ?? []).find(
    (candidate) => String(candidate.id) === String(panelId)
  );
  if (!panel) {
    throw new Error(`Saved dashboard no longer contains panel ${panelId}`);
  }
  const drawStyleOverrides = (panel.fieldConfig?.overrides ?? []).flatMap((override) =>
    (override.properties ?? []).filter((property) => property.id === 'custom.drawStyle')
  );
  const saved = {
    plugin: panel.type,
    style: panel.fieldConfig?.defaults?.custom?.drawStyle,
    drawStyleOverrideCount: drawStyleOverrides.length,
    highlightSeriesOnHover: panel.options?.highlightSeriesOnHover !== false,
  };
  if (saved.plugin !== plugin || (style !== undefined && saved.style !== style)) {
    throw new Error(`Saved panel is ${saved.plugin}/${saved.style}, expected ${plugin}/${style}`);
  }
  if (saved.drawStyleOverrideCount !== drawStyleOverrideCount) {
    throw new Error(
      `Saved panel has ${saved.drawStyleOverrideCount} draw-style overrides, expected ${drawStyleOverrideCount}`
    );
  }
  if (!saved.highlightSeriesOnHover) {
    throw new Error('Saved panel disabled hover highlighting');
  }
  return saved;
}

function assertNoBrowserErrors(pageErrors, state) {
  if (pageErrors.length > 0) {
    throw new Error(`Browser reported errors during ${state}:\n${pageErrors.join('\n')}`);
  }
}

function flattenPanels(panels) {
  return panels.flatMap((panel) => [panel, ...flattenPanels(panel.panels ?? [])]);
}

async function settleUi(page) {
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('[aria-busy="true"]')).some((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      }),
    undefined,
    { timeout: 120_000 }
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function screenshot(page, outputDir, report, name) {
  const filePath = path.join(outputDir, `${name}.png`);
  await page.screenshot({ path: filePath });
  report.screenshots.push(filePath);
}
