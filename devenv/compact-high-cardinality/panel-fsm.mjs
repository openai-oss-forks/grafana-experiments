import { createHash } from 'node:crypto';
import path from 'node:path';

import { seekCompactFocusOverlay } from './focus-overlay.mjs';

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
  { name: 'time-series-final-bars', plugin: 'timeseries', style: 'Bars', format: 'compact-v1', screenshot: true },
];

const FSM_COVERAGE = {
  axes: {
    surface: ['dashboard', 'panel-editor', 'visualization-picker'],
    persistence: ['clean', 'dirty', 'saved', 'discarded'],
    transport: ['compact-v1', 'json'],
    visualization: ['time-series-lines', 'time-series-bars', 'time-series-points', 'bar-chart', 'table'],
    interaction: ['idle', 'hover-highlighted', 'hover-unhighlighted', 'refresh'],
    lifecycle: ['existing', 'new-discarded', 'duplicated', 'deleted'],
  },
  invariants: [
    'eligible final panel configuration has compact-v1 as the latest network request and response format',
    'ineligible final panel configuration has JSON as the latest network request and response format',
    'local style and hover-option changes do not issue datasource requests',
    'save and discard outcomes match dashboard API readback',
    'rendered charts have painted, bounded canvases and no malformed or busy UI',
    'deleted panels do not issue requests after a subsequent dashboard refresh',
  ],
};

export async function runPanelFsm({
  page,
  queryRequests,
  waitForRequestCount,
  outputDir,
  baseUrl,
  dashboardUid,
  pageErrors,
  fixture,
  phase = 'all',
  captureScreenshots = true,
}) {
  const report = {
    coverage: { planned: FSM_COVERAGE, executedPhase: phase },
    transitions: [],
    screenshots: [],
    screenshotsEnabled: captureScreenshots,
    hoverOptionQueryCount: 0,
  };
  await assertStableDashboard(page, pageErrors, 'initial-dashboard');
  await screenshot(page, outputDir, report, 'fsm-00-dashboard');
  if (phase === 'crud') {
    report.crud = await verifyCrudLifecycle({
      page,
      queryRequests,
      waitForRequestCount,
      outputDir,
      report,
      baseUrl,
      dashboardUid,
      pageErrors,
      fixture,
    });
    return report;
  }
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
    const beforePluginHash = await chartScreenshotHash(page).catch(() => undefined);
    const pluginChanged = await selectPlugin(page, transition.plugin);
    let previousStyleHash;
    let styleChanged = false;
    if (transition.style) {
      const beforeStyle = await chartScreenshotHash(page);
      styleChanged = await selectTimeSeriesStyle(page, transition.style);
      previousStyleHash = styleChanged ? beforeStyle : undefined;
    }
    await settleUi(page);
    let naturalRequestCount = 0;
    let refreshRequestNumber;
    let preRefreshVisual;
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
      await waitForRequestIdle(page, queryRequests);
      naturalRequestCount = panelRequests(queryRequests.slice(beforeCount), fixture.transitionPanelId).length;
      preRefreshVisual = await assertEditorVisual(page, pageErrors, transition, previousStyleHash ?? beforePluginHash);
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
      await waitForRequestIdle(page, queryRequests);
      assertRequestsMatch(
        panelRequests(queryRequests.slice(beforeCount), fixture.transitionPanelId),
        transition.format,
        transition.plugin
      );
      naturalRequestCount = panelRequests(queryRequests.slice(beforeCount), fixture.transitionPanelId).length;
      preRefreshVisual = await assertEditorVisual(page, pageErrors, transition, previousStyleHash);
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
    if (!pluginChanged && styleChanged && naturalRequestCount !== 0) {
      throw new Error(`${transition.name} issued ${naturalRequestCount} datasource requests for a local style change`);
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
    observation.preRefreshVisual = preRefreshVisual;
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
    'bars',
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

  await returnToDashboard(page);
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
    'bars',
    0
  );
  report.refreshedDashboardHover = await verifyHover(page, true);
  report.persistedBarsRendering = await verifyPersistedBarsRendering(page, queryRequests, pageErrors, fixture);
  report.refreshedExactVisual = await assertVisualization(page, 'timeseries', 1);
  report.refreshedExactHover = await verifyHover(page, true, 1);
  await screenshot(page, outputDir, report, 'fsm-09-refreshed-dashboard');

  if (phase === 'all') {
    report.crud = await verifyCrudLifecycle({
      page,
      queryRequests,
      waitForRequestCount,
      outputDir,
      report,
      baseUrl,
      dashboardUid,
      pageErrors,
      fixture,
    });
  }

  return report;
}

async function verifyCrudLifecycle({
  page,
  queryRequests,
  waitForRequestCount,
  outputDir,
  report,
  baseUrl,
  dashboardUid,
  pageErrors,
  fixture,
}) {
  const initial = await readPanelInventory(page, baseUrl, dashboardUid);
  const disposablePanelTitle = uniquePanelTitle(initial, 'Disposable FSM panel');
  const savedPanelTitle = uniquePanelTitle(initial, 'Saved FSM panel');
  await ensureDashboardEditMode(page);
  const initialRenderedPanelCount = await page.locator('[data-testid^="data-testid Panel header "]').count();

  await addTimeSeriesPanel(page, disposablePanelTitle);
  await page.getByRole('button', { name: /^Discard panel(?: changes)?$/ }).click();
  await page.getByTestId(`data-testid Panel header ${fixture.transitionPanelTitle}`).waitFor({
    state: 'visible',
    timeout: 30_000,
  });
  const afterAddDiscard = await readPanelInventory(page, baseUrl, dashboardUid);
  assertSameInventory(initial, afterAddDiscard, 'add then discard');
  const afterDiscardRenderedPanelCount = await page.locator('[data-testid^="data-testid Panel header "]').count();
  if (afterDiscardRenderedPanelCount !== initialRenderedPanelCount) {
    throw new Error(
      `Add then discard left ${afterDiscardRenderedPanelCount} rendered panels, expected ${initialRenderedPanelCount}`
    );
  }
  if ((await page.getByTestId(`data-testid Panel header ${disposablePanelTitle}`).count()) !== 0) {
    throw new Error('Discarded panel remained in the dashboard DOM');
  }
  await screenshot(page, outputDir, report, 'fsm-10-add-discarded');

  await duplicatePanel(page, fixture.transitionPanelTitle);
  const transitionHeaders = page.getByTestId(`data-testid Panel header ${fixture.transitionPanelTitle}`);
  await transitionHeaders.nth(1).waitFor({ state: 'visible', timeout: 30_000 });
  const duplicateBeforeSaveRef = { title: fixture.transitionPanelTitle, index: 1 };
  const duplicateBeforeSaveVisual = await assertVisualization(page, 'timeseries', duplicateBeforeSaveRef);
  const duplicateBeforeSaveHover = await verifyHover(page, true, duplicateBeforeSaveRef);

  const duplicateTitle = `${fixture.transitionPanelTitle} — duplicate FSM`;
  await openPanelEditor(page, fixture.transitionPanelTitle, 1, true);
  const duplicateTitleInput = page.getByTestId('data-testid Panel editor option pane field input Title');
  await duplicateTitleInput.fill(duplicateTitle);
  await duplicateTitleInput.press('Tab');
  await returnToDashboard(page);
  const duplicateHeader = page.getByTestId(`data-testid Panel header ${duplicateTitle}`);
  await duplicateHeader.waitFor({ state: 'visible', timeout: 30_000 });
  await saveDashboard(page);
  const afterDuplicate = await readPanelInventory(page, baseUrl, dashboardUid);
  const addedPanels = afterDuplicate.panels.filter((panel) => !initial.ids.includes(panel.id));
  if (addedPanels.length !== 1 || afterDuplicate.panels.length !== initial.panels.length + 1) {
    throw new Error(`Duplicate expected one new panel, found IDs ${addedPanels.map((panel) => panel.id).join(', ')}`);
  }
  const duplicate = addedPanels[0];
  if (duplicate.type !== 'timeseries' || duplicate.title !== duplicateTitle) {
    throw new Error(`Duplicated panel is ${duplicate.type}/${duplicate.title}, expected timeseries/${duplicateTitle}`);
  }
  const persistedBaseline = createPanelInventory(
    afterDuplicate.panels.filter((panel) => String(panel.id) !== String(duplicate.id))
  );
  const source = persistedBaseline.panels.find((panel) => String(panel.id) === String(fixture.transitionPanelId));
  if (!source || cloneConfigurationFingerprint(duplicate) !== cloneConfigurationFingerprint(source)) {
    throw new Error('Duplicated panel did not preserve its datasource, queries, field configuration, and options');
  }

  const duplicateRefreshStart = queryRequests.length;
  await page.getByTestId('data-testid RefreshPicker run button').click();
  await waitForExpectedRequest(
    queryRequests,
    waitForRequestCount,
    'compact-v1',
    'timeseries',
    duplicateRefreshStart,
    duplicate.id,
    true
  );
  await waitForExpectedRequest(
    queryRequests,
    waitForRequestCount,
    'compact-v1',
    'timeseries',
    duplicateRefreshStart,
    fixture.transitionPanelId,
    false
  );
  await waitForExpectedRequest(
    queryRequests,
    waitForRequestCount,
    'compact-v1',
    'timeseries',
    duplicateRefreshStart,
    fixture.exactPanelId,
    false
  );
  await waitForRequestIdle(page, queryRequests);
  assertRequestsMatch(queryRequests.slice(duplicateRefreshStart), 'compact-v1', 'timeseries');
  assertLatestRequest(queryRequests, 'compact-v1', 'timeseries', fixture.transitionPanelId);
  assertLatestRequest(queryRequests, 'compact-v1', 'timeseries', fixture.exactPanelId);
  assertLatestRequest(queryRequests, 'compact-v1', 'timeseries', duplicate.id);
  const duplicateRef = { title: duplicateTitle, index: 0 };
  const duplicateVisual = await assertVisualization(page, 'timeseries', duplicateRef);
  const duplicateHover = await verifyHover(page, true, duplicateRef);
  assertNoBrowserErrors(pageErrors, 'duplicated-panel');
  await screenshot(page, outputDir, report, 'fsm-11-duplicated-saved-refreshed');

  await removePanel(page, duplicateTitle, 0);
  await duplicateHeader.waitFor({ state: 'detached', timeout: 30_000 });
  await saveDashboard(page);
  const afterDelete = await readPanelInventory(page, baseUrl, dashboardUid);
  assertSameInventory(persistedBaseline, afterDelete, 'duplicate deletion', true);

  const deleteReloadStart = queryRequests.length;
  const transitionPanelRef = { title: fixture.transitionPanelTitle, index: 0 };
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId(`data-testid Panel header ${fixture.transitionPanelTitle}`).waitFor({
    state: 'visible',
    timeout: 30_000,
  });
  const restoredVisual = await assertVisualization(page, 'timeseries', transitionPanelRef);
  await waitForExpectedRequest(
    queryRequests,
    waitForRequestCount,
    'compact-v1',
    'timeseries',
    deleteReloadStart,
    fixture.transitionPanelId,
    true
  );
  await assertVisualization(page, 'timeseries', { title: fixture.exactPanelTitle, index: 0 });
  await waitForExpectedRequest(
    queryRequests,
    waitForRequestCount,
    'compact-v1',
    'timeseries',
    deleteReloadStart,
    fixture.exactPanelId,
    true
  );
  await waitForRequestIdle(page, queryRequests);
  const reloadRequests = queryRequests.slice(deleteReloadStart);
  const deletedRequests = panelRequests(reloadRequests, duplicate.id);
  if (deletedRequests.length > 0) {
    throw new Error(`Deleted panel ${duplicate.id} issued ${deletedRequests.length} requests after reload`);
  }
  assertRequestsMatch(reloadRequests, 'compact-v1', 'timeseries');
  assertLatestRequest(queryRequests, 'compact-v1', 'timeseries', fixture.transitionPanelId);
  assertLatestRequest(queryRequests, 'compact-v1', 'timeseries', fixture.exactPanelId);
  if ((await duplicateHeader.count()) !== 0) {
    throw new Error(`Deleted panel ${duplicate.id} reappeared in the dashboard DOM after reload`);
  }
  await assertVisualization(page, 'timeseries', transitionPanelRef);

  const deleteRefreshStart = queryRequests.length;
  await page.getByTestId('data-testid RefreshPicker run button').click();
  await waitForExpectedRequest(
    queryRequests,
    waitForRequestCount,
    'compact-v1',
    'timeseries',
    deleteRefreshStart,
    fixture.transitionPanelId,
    true
  );
  await waitForRequestIdle(page, queryRequests);
  const refreshRequests = queryRequests.slice(deleteRefreshStart);
  assertRequestsMatch(refreshRequests, 'compact-v1', 'timeseries');
  const deletedPanelRefreshRequests = panelRequests(refreshRequests, duplicate.id).length;
  if (deletedPanelRefreshRequests > 0) {
    throw new Error(`Deleted panel ${duplicate.id} issued ${deletedPanelRefreshRequests} requests after refresh`);
  }
  assertNoBrowserErrors(pageErrors, 'deleted-panel-reload');
  await screenshot(page, outputDir, report, 'fsm-12-duplicate-deleted-reloaded');

  await addTimeSeriesPanel(page, savedPanelTitle);
  await returnToDashboard(page);
  await saveDashboard(page);
  const afterAddSave = await readPanelInventory(page, baseUrl, dashboardUid);
  const createdPanels = afterAddSave.panels.filter((panel) => !persistedBaseline.ids.includes(panel.id));
  if (
    createdPanels.length !== 1 ||
    createdPanels[0].type !== 'timeseries' ||
    createdPanels[0].title !== savedPanelTitle
  ) {
    throw new Error(
      `Saved new panel mismatch: ${createdPanels.map((panel) => `${panel.id}:${panel.type}/${panel.title}`).join(', ')}`
    );
  }
  await removePanel(page, savedPanelTitle, 0);
  await saveDashboard(page);
  const afterAddedPanelDelete = await readPanelInventory(page, baseUrl, dashboardUid);
  assertSameInventory(persistedBaseline, afterAddedPanelDelete, 'new panel deletion', true);
  if ((await page.getByTestId(`data-testid Panel header ${savedPanelTitle}`).count()) !== 0) {
    throw new Error('Deleted newly created panel remained in the dashboard DOM');
  }

  return {
    initialPanelIds: initial.ids,
    addDiscardPreservedPanelIds: afterAddDiscard.ids,
    addDiscardPreservedRenderedPanelCount: afterDiscardRenderedPanelCount,
    createdPanelId: createdPanels[0].id,
    createdPanelDeletedIds: afterAddedPanelDelete.ids,
    duplicatePanelId: duplicate.id,
    duplicateBeforeSaveVisual,
    duplicateBeforeSaveHover,
    duplicateVisual,
    duplicateHover,
    deletedPanelIds: afterDelete.ids,
    deletedPanelRefreshRequests,
    deletedPanelReloadRequests: deletedRequests.length,
    restoredVisual,
  };
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

async function verifyPersistedBarsRendering(page, queryRequests, pageErrors, fixture) {
  await openPanelEditor(page, fixture.transitionPanelTitle);
  await waitForRequestIdle(page, queryRequests);
  assertLatestRequest(queryRequests, 'compact-v1', 'timeseries', fixture.transitionPanelId);
  const requestStart = queryRequests.length;
  const styleField = page.getByLabel(/Graph styles Style field property editor/);
  if (!(await styleField.isVisible().catch(() => false))) {
    const expand = page.getByRole('button', { name: /Expand Graph styles category/ });
    if ((await expand.count()) > 0) {
      await expand.click();
    }
  }
  await styleField.waitFor({ state: 'visible', timeout: 30_000 });
  const barsOption = styleField.getByRole('radio', { name: 'Bars', exact: true });
  if (!(await barsOption.isChecked())) {
    throw new Error('Reloaded panel did not select its persisted Bars style');
  }
  await page.mouse.move(1, 1);
  const persistedBarsHash = await chartScreenshotHash(page);
  if (!(await selectTimeSeriesStyle(page, 'Lines'))) {
    throw new Error('Reloaded Bars panel could not transition to Lines');
  }
  await settleUi(page);
  const linesHash = await waitForChartHashChange(page, persistedBarsHash);
  if (!(await selectTimeSeriesStyle(page, 'Bars'))) {
    throw new Error('Reloaded panel could not restore its Bars style');
  }
  await settleUi(page);
  const restoredBarsHash = await waitForChartHashChange(page, linesHash);
  await waitForRequestIdle(page, queryRequests);
  const styleRequests = panelRequests(queryRequests.slice(requestStart), fixture.transitionPanelId);
  if (styleRequests.length > 0) {
    throw new Error(`Persisted Bars verification issued ${styleRequests.length} datasource requests`);
  }
  assertNoBrowserErrors(pageErrors, 'persisted-bars-rendering');
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
  return { persistedBarsHash, linesHash, restoredBarsHash, styleRequestCount: styleRequests.length };
}

async function openPanelEditor(page, panelTitle, index = 0, preserveUnsavedState = false) {
  const header = page.getByTestId(`data-testid Panel header ${panelTitle}`).nth(index);
  await header.scrollIntoViewIfNeeded();
  await header.hover();
  const menu = page.getByLabel(`Menu for panel ${panelTitle}`, { exact: true }).nth(index);
  await menu.click();
  const edit = page.getByRole('menuitem', { name: /^Edit\b/ });
  await edit.waitFor({ state: 'visible', timeout: 30_000 });
  const href = await edit.getAttribute('href');
  if (!href) {
    throw new Error(`Panel ${panelTitle} Edit action had no navigation target`);
  }
  if (preserveUnsavedState) {
    await edit.click({ force: true });
  } else {
    await page.goto(new URL(href, page.url()).href, { waitUntil: 'domcontentloaded' });
  }
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

async function verifyHover(page, expectFocusOverlay, panelRef = 0) {
  await page.mouse.move(1, 1);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const panel =
    typeof panelRef === 'number'
      ? page
          .locator('[data-testid="data-testid panel content"]')
          .filter({ has: page.locator('.uplot') })
          .nth(panelRef)
      : panelContent(page, panelRef);
  await panel.scrollIntoViewIfNeeded();
  const bounds = await panel.locator('.u-over').boundingBox();
  if (!bounds) {
    throw new Error('Hover verification found no plot bounds');
  }
  const tooltip = page.locator('[data-testid="data-testid viz-tooltip-wrapper"]:visible').first();
  const paintedPositions = await findSeriesHoverPositions(panel);
  const positions = [
    { x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.5 },
    { x: bounds.x + bounds.width * 0.25, y: bounds.y + bounds.height * 0.25 },
    { x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.25 },
    { x: bounds.x + bounds.width * 0.75, y: bounds.y + bounds.height * 0.5 },
    { x: bounds.x + bounds.width * 0.75, y: bounds.y + bounds.height * 0.75 },
    ...paintedPositions,
  ];
  const startedAt = Date.now();
  let overlayCount = 0;
  let tooltipVisible = false;
  for (const position of positions) {
    await page.mouse.move(position.x, position.y);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    tooltipVisible = await tooltip.isVisible().catch(() => false);
    overlayCount = await panel.locator('.u-compact-focus-overlay').count();
    if (tooltipVisible && overlayCount === (expectFocusOverlay ? 1 : 0)) {
      break;
    }
  }
  let elapsedMs = Date.now() - startedAt;
  let focusTargetSearchMs = 0;
  if (expectFocusOverlay && overlayCount === 0) {
    const focusTarget = await seekCompactFocusOverlay(page, panel, bounds);
    overlayCount = focusTarget.overlayCount;
    focusTargetSearchMs = focusTarget.searchMs;
    if (focusTarget.responseMs != null) {
      elapsedMs = focusTarget.responseMs;
    }
    tooltipVisible = await tooltip.isVisible().catch(() => false);
  }
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
  let activeSeriesColor;
  let activeSeriesColorDistance;
  let nearestTooltipColorIndex;
  let activeSeriesDirectionDistance;
  let nearestTooltipDirectionIndex;
  if (expectFocusOverlay) {
    const tooltipColors = await tooltip.evaluate((root) => {
      const parseColor = (value) => {
        const match = value.match(/rgba?\(([^)]+)\)/);
        if (!match) {
          return null;
        }
        const channels = match[1].split(/[,\s/]+/).map(Number);
        return channels.length >= 3 && channels.slice(0, 3).every(Number.isFinite) ? channels.slice(0, 3) : null;
      };
      const focusedSeries = root.querySelector('[data-testid="compact-tooltip-focused-series"]');
      let active = focusedSeries ? parseColor(getComputedStyle(focusedSeries).borderLeftColor) : null;
      const colors = [];
      for (const icon of root.querySelectorAll('[data-testid="series-icon"]')) {
        const row = icon.parentElement?.parentElement;
        const color = parseColor(`${getComputedStyle(icon).backgroundColor} ${getComputedStyle(icon).backgroundImage}`);
        if (color) {
          colors.push(color);
        }
        if (
          !active &&
          row &&
          Array.from(row.querySelectorAll('div')).some((element) => Number(getComputedStyle(element).fontWeight) >= 600)
        ) {
          active = color;
        }
      }
      if (!active) {
        return null;
      }
      return [active, ...colors.filter((color) => color.some((channel, index) => channel !== active[index]))];
    });
    if (!tooltipColors) {
      throw new Error('Hover tooltip did not identify an active series color');
    }
    activeSeriesColor = tooltipColors[0];
    const focusEvidence = await panel.locator('.u-compact-focus-overlay').evaluate((canvas, seriesColors) => {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context || canvas.width <= 0 || canvas.height <= 0) {
        return {
          paintedPixels: 0,
          colorCount: 0,
          geometryPixels: 0,
          colorDistances: [],
          directionDistances: [],
        };
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
      let backdropColor;
      for (const [color, count] of colorCounts) {
        if (count > backdropPixels) {
          backdropPixels = count;
          backdropColor = color;
        }
      }
      const colorDistances = seriesColors.map(() => Number.POSITIVE_INFINITY);
      const directionDistances = seriesColors.map(() => Number.POSITIVE_INFINITY);
      for (const color of colorCounts.keys()) {
        if (color === backdropColor) {
          continue;
        }
        const channels = color.split(',').slice(0, 3).map(Number);
        for (let index = 0; index < seriesColors.length; index++) {
          const distance = Math.hypot(
            channels[0] - seriesColors[index][0],
            channels[1] - seriesColors[index][1],
            channels[2] - seriesColors[index][2]
          );
          colorDistances[index] = Math.min(colorDistances[index], distance);
          const channelNorm = Math.hypot(...channels);
          const seriesNorm = Math.hypot(...seriesColors[index]);
          if (channelNorm > 0 && seriesNorm > 0) {
            const cosine =
              (channels[0] * seriesColors[index][0] +
                channels[1] * seriesColors[index][1] +
                channels[2] * seriesColors[index][2]) /
              (channelNorm * seriesNorm);
            directionDistances[index] = Math.min(directionDistances[index], 1 - cosine);
          }
        }
      }
      return {
        paintedPixels,
        colorCount: colorCounts.size,
        geometryPixels: paintedPixels - backdropPixels,
        colorDistances,
        directionDistances,
      };
    }, tooltipColors);
    focusCanvasPainted = focusEvidence.paintedPixels > 0;
    focusColorCount = focusEvidence.colorCount;
    focusGeometryPixels = focusEvidence.geometryPixels;
    activeSeriesColorDistance = focusEvidence.colorDistances[0];
    nearestTooltipColorIndex = focusEvidence.colorDistances.indexOf(Math.min(...focusEvidence.colorDistances));
    activeSeriesDirectionDistance = focusEvidence.directionDistances[0];
    nearestTooltipDirectionIndex = focusEvidence.directionDistances.indexOf(
      Math.min(...focusEvidence.directionDistances)
    );
    if (
      !focusCanvasPainted ||
      focusColorCount < 2 ||
      focusGeometryPixels === 0 ||
      !Number.isFinite(activeSeriesColorDistance) ||
      !Number.isFinite(activeSeriesDirectionDistance) ||
      activeSeriesColorDistance > 64 ||
      activeSeriesDirectionDistance > 0.05 ||
      (nearestTooltipDirectionIndex !== 0 && activeSeriesDirectionDistance > 0.01)
    ) {
      throw new Error(
        `Hover focus overlay did not match the active tooltip series: activeDistance=${activeSeriesColorDistance}, activeDirection=${activeSeriesDirectionDistance}, nearestColor=${nearestTooltipColorIndex}, nearestDirection=${nearestTooltipDirectionIndex}`
      );
    }
  }
  await page.mouse.move(1, 1);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return {
    elapsedMs,
    focusTargetSearchMs,
    tooltipTextLength,
    overlayCount,
    focusCanvasPainted,
    focusColorCount,
    focusGeometryPixels,
    activeSeriesColor,
    activeSeriesColorDistance,
    nearestTooltipColorIndex,
    activeSeriesDirectionDistance,
    nearestTooltipDirectionIndex,
  };
}

async function findSeriesHoverPositions(panel) {
  return panel
    .locator('.uplot canvas:not(.u-compact-focus-overlay)')
    .first()
    .evaluate((canvas) => {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const panelRoot = canvas.closest('section');
      if (!context || !panelRoot || canvas.width <= 0 || canvas.height <= 0) {
        return [];
      }
      const seriesColors = [];
      for (const icon of panelRoot.querySelectorAll('[data-testid="series-icon"]')) {
        const style = getComputedStyle(icon);
        for (const match of `${style.backgroundColor} ${style.backgroundImage}`.matchAll(/rgba?\(([^)]+)\)/g)) {
          const channels = match[1].split(/[,\s/]+/).map(Number);
          if (channels.length >= 3 && channels.slice(0, 3).every(Number.isFinite)) {
            seriesColors.push(channels.slice(0, 3));
          }
        }
      }
      if (seriesColors.length === 0) {
        return [];
      }

      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const columns = [];
      const yFrom = Math.floor(canvas.height * 0.05);
      const yTo = Math.floor(canvas.height * 0.9);
      const isSeriesPixel = (offset) => {
        if (pixels[offset + 3] <= 8) {
          return false;
        }
        return seriesColors.some(
          (color) =>
            Math.abs(pixels[offset] - color[0]) <= 18 &&
            Math.abs(pixels[offset + 1] - color[1]) <= 18 &&
            Math.abs(pixels[offset + 2] - color[2]) <= 18
        );
      };
      for (let x = 0; x < canvas.width; x += 2) {
        let runFrom = -1;
        let longestFrom = -1;
        let longestTo = -1;
        for (let y = yFrom; y < yTo; y += 2) {
          const matched = isSeriesPixel((y * canvas.width + x) * 4);
          if (matched && runFrom < 0) {
            runFrom = y;
          }
          if ((!matched || y + 2 >= yTo) && runFrom >= 0) {
            const runTo = matched ? y : y - 2;
            if (runTo - runFrom > longestTo - longestFrom) {
              longestFrom = runFrom;
              longestTo = runTo;
            }
            runFrom = -1;
          }
        }
        if (longestFrom >= 0) {
          columns.push({ x, y: (longestFrom + longestTo) / 2, length: longestTo - longestFrom });
        }
      }

      const bounds = canvas.getBoundingClientRect();
      const selected = [];
      for (const column of columns.sort((left, right) => right.length - left.length)) {
        if (selected.every((candidate) => Math.abs(candidate.x - column.x) >= canvas.width * 0.02)) {
          selected.push(column);
        }
        if (selected.length === 12) {
          break;
        }
      }
      return selected.map(({ x, y }) => ({
        x: bounds.left + (x / canvas.width) * bounds.width,
        y: bounds.top + (y / canvas.height) * bounds.height,
      }));
    });
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
  const visual = await assertEditorVisual(page, pageErrors, expected, previousStyleHash);
  assertLatestRequest(queryRequests, expected.format, expected.plugin, panelId);
  return {
    name: expected.name,
    plugin: expected.plugin,
    style: expected.style,
    expectedFormat: expected.format,
    requestNumber: latestPanelRequest(queryRequests, panelId)?.requestNumber,
    visual,
  };
}

async function assertEditorVisual(page, pageErrors, expected, previousStyleHash) {
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
  assertNoBrowserErrors(pageErrors, expected.name);
  return visual;
}

async function assertStableDashboard(page, pageErrors, state) {
  const visual = await assertVisualization(page, 'timeseries');
  if (new URL(page.url()).searchParams.has('editPanel')) {
    throw new Error(`${state} remained in panel edit mode`);
  }
  assertNoBrowserErrors(pageErrors, state);
  return visual;
}

async function assertVisualization(page, plugin, panelRef = 0) {
  await panelContent(page, panelRef).scrollIntoViewIfNeeded();
  await settleUi(page);
  const result = await page.waitForFunction(
    ({ plugin, panelRef }) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return bounds.width > 0 && bounds.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const malformed = (text) => /Invalid date|\bNaN\b|\bundefined\b/i.test(text);
      let panel;
      if (typeof panelRef === 'number') {
        panel = Array.from(document.querySelectorAll('[data-testid="data-testid panel content"]'))[panelRef];
      } else {
        const testId = `data-testid Panel header ${panelRef.title}`;
        const header = Array.from(document.querySelectorAll('[data-testid]')).filter(
          (element) => element.getAttribute('data-testid') === testId
        )[panelRef.index];
        panel = header?.closest('section')?.querySelector('[data-testid="data-testid panel content"]');
      }
      if (
        !panel ||
        !visible(panel) ||
        malformed(panel.textContent ?? '') ||
        panel.querySelector('[aria-busy="true"]')
      ) {
        return false;
      }
      if (plugin === 'table') {
        const table = Array.from(panel.querySelectorAll('table,[role="table"],[role="grid"]')).find(visible);
        if (!table || !(table.textContent ?? '').trim()) {
          return false;
        }
        const dataCells = Array.from(table.querySelectorAll('tbody td,[role="gridcell"]')).filter(visible);
        if (dataCells.length === 0 || !dataCells.some((cell) => (cell.textContent ?? '').trim())) {
          return false;
        }
        return {
          kind: 'table',
          textLength: (table.textContent ?? '').trim().length,
          dataCellCount: dataCells.length,
        };
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
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let alpha = 3; alpha < pixels.length && canvasOpaque < 16; alpha += 16) {
          if (pixels[alpha] > 0) {
            canvasOpaque++;
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
    { plugin, panelRef },
    { timeout: 120_000, polling: 100 }
  );
  const alerts = await page.locator('[role="alert"]:visible').allTextContents();
  const errors = alerts.filter((text) => /error|failed|invalid compact/i.test(text));
  if (errors.length > 0) {
    throw new Error(`Panel rendered an error: ${errors.join(' | ')}`);
  }
  return result.jsonValue();
}

function panelContent(page, panelRef) {
  if (typeof panelRef === 'number') {
    return page.locator('[data-testid="data-testid panel content"]').nth(panelRef);
  }
  return page
    .getByTestId(`data-testid Panel header ${panelRef.title}`)
    .nth(panelRef.index)
    .getByTestId('data-testid panel content');
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

async function waitForRequestIdle(page, queryRequests) {
  let previousCount = -1;
  let stableSince = Date.now();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (queryRequests.length !== previousCount) {
      previousCount = queryRequests.length;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 500) {
      return;
    }
    await page.waitForTimeout(50);
  }
  throw new Error('Datasource requests did not become idle');
}

async function ensureDashboardEditMode(page) {
  const add = page.getByRole('button', { name: 'Add', exact: true });
  if (await add.isVisible().catch(() => false)) {
    return;
  }
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await add.waitFor({ state: 'visible', timeout: 30_000 });
}

async function duplicatePanel(page, panelTitle) {
  const header = page.getByTestId(`data-testid Panel header ${panelTitle}`).first();
  await header.scrollIntoViewIfNeeded();
  await header.hover();
  await page.getByLabel(`Menu for panel ${panelTitle}`, { exact: true }).first().click();
  const more = page.getByRole('menuitem', { name: 'More...', exact: true });
  await more.hover();
  await page.getByRole('menuitem', { name: /^Duplicate\b/ }).click();
}

async function addTimeSeriesPanel(page, title) {
  await ensureDashboardEditMode(page);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Visualization', exact: true }).click();
  const timeSeriesCard = page.locator('[data-testid$="Plugin visualization item Time series"]');
  await timeSeriesCard.waitFor({ state: 'visible', timeout: 30_000 });
  await timeSeriesCard.click();
  await optionsHeader(page).waitFor({ state: 'visible', timeout: 30_000 });
  const titleInput = page.getByTestId('data-testid Panel editor option pane field input Title');
  await titleInput.fill(title);
  await titleInput.press('Tab');
}

async function removePanel(page, panelTitle, index) {
  const header = page.getByTestId(`data-testid Panel header ${panelTitle}`).nth(index);
  await header.scrollIntoViewIfNeeded();
  await header.hover();
  await page.getByLabel(`Menu for panel ${panelTitle}`, { exact: true }).nth(index).click();
  await page.getByRole('menuitem', { name: /^Remove\b/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove panel' });
  await dialog.waitFor({ state: 'visible', timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
}

async function saveDashboard(page) {
  await page.getByRole('button', { name: 'Save dashboard', exact: true }).click();
  const save = page.getByTestId('data-testid Save dashboard drawer button');
  await save.waitFor({ state: 'visible', timeout: 30_000 });
  const savedResponse = page.waitForResponse((response) => isDashboardSaveResponse(response), { timeout: 30_000 });
  await save.click();
  const response = await savedResponse;
  if (!response.ok()) {
    throw new Error(`Dashboard save failed: ${response.status()} ${await response.text()}`);
  }
  await settleUi(page);
}

function isDashboardSaveResponse(response) {
  const method = response.request().method();
  const pathname = new URL(response.url()).pathname;
  if (method === 'POST' && /^\/api\/dashboards\/db\/?$/.test(pathname)) {
    return true;
  }
  return (
    method === 'PUT' &&
    /^\/apis\/dashboard\.grafana\.app\/v(?:1|2)beta1\/namespaces\/[^/]+\/dashboards\/[^/]+$/.test(pathname)
  );
}

async function returnToDashboard(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(250);
  if (new URL(page.url()).searchParams.has('editPanel')) {
    const back = page.getByRole('button', { name: 'Back to dashboard' });
    await back.waitFor({ state: 'visible', timeout: 30_000 });
    await back.click();
  }
  await page.waitForFunction(() => !new URL(window.location.href).searchParams.has('editPanel'), undefined, {
    timeout: 30_000,
  });
  await page
    .locator('[data-testid="data-testid panel content"]')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });
  await settleUi(page);
}

async function readPanelInventory(page, baseUrl, dashboardUid) {
  const response = await page.request.get(`${baseUrl}/api/dashboards/uid/${dashboardUid}`);
  if (!response.ok()) {
    throw new Error(`Dashboard inventory readback failed: ${response.status()} ${await response.text()}`);
  }
  const body = await response.json();
  const panels = flattenPanels(body.dashboard?.panels ?? [])
    .map((panel) => structuredClone(panel))
    .sort((left, right) => Number(left.id) - Number(right.id));
  return createPanelInventory(panels);
}

function createPanelInventory(panels) {
  return {
    ids: panels.map((panel) => panel.id),
    panels,
  };
}

function uniquePanelTitle(inventory, base) {
  const existing = new Set(inventory.panels.map((panel) => panel.title));
  let title = base;
  for (let suffix = 2; existing.has(title); suffix++) {
    title = `${base} ${suffix}`;
  }
  return title;
}

function assertSameInventory(expected, actual, action, ignoreLayout = false) {
  const ignoredKeys = new Set(['pluginVersion', ...(ignoreLayout ? ['gridPos'] : [])]);
  const fingerprint = (inventory) =>
    JSON.stringify(
      inventory.panels.map((panel) => {
        const configuration = structuredClone(panel);
        for (const key of ignoredKeys) {
          delete configuration[key];
        }
        return configuration;
      })
    );
  if (fingerprint(actual) !== fingerprint(expected)) {
    const changedKeys = expected.panels.flatMap((panel) => {
      const current = actual.panels.find((candidate) => String(candidate.id) === String(panel.id));
      if (!current) {
        return [`${panel.id}:missing`];
      }
      return Array.from(new Set([...Object.keys(panel), ...Object.keys(current)]))
        .filter((key) => !ignoredKeys.has(key))
        .filter((key) => JSON.stringify(panel[key]) !== JSON.stringify(current[key]))
        .map((key) => `${panel.id}:${key}`);
    });
    throw new Error(
      `${action} changed persisted panels: before=${expected.ids.join(',')} after=${actual.ids.join(',')} keys=${changedKeys.join(',')}`
    );
  }
}

function cloneConfigurationFingerprint(panel) {
  const configuration = structuredClone(panel);
  for (const identityOrLayoutKey of ['id', 'title', 'gridPos', 'pluginVersion']) {
    delete configuration[identityOrLayoutKey];
  }
  return JSON.stringify(configuration);
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
  await page.waitForFunction(
    () => {
      const snapshot = window.__compactPaintProbe?.snapshot();
      return snapshot?.lastCanvasOperationAt == null || performance.now() - snapshot.lastCanvasOperationAt >= 250;
    },
    undefined,
    { timeout: 120_000, polling: 50 }
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function screenshot(page, outputDir, report, name) {
  if (!report.screenshotsEnabled) {
    return;
  }
  const filePath = path.join(outputDir, `${name}.png`);
  await page.screenshot({ path: filePath });
  report.screenshots.push(filePath);
}
