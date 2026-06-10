import fs from 'node:fs/promises';

export const DASHBOARD_UID = 'compact-high-cardinality-local';
export const DATASOURCE_UID = 'compact-fixture-prometheus';

const BASE_CUSTOM = {
  axisBorderShow: false,
  axisCenteredZero: false,
  axisColorMode: 'text',
  axisGridShow: true,
  axisLabel: '',
  axisPlacement: 'auto',
  barAlignment: 0,
  drawStyle: 'line',
  fillOpacity: 10,
  gradientMode: 'none',
  hideFrom: { legend: false, tooltip: false, viz: false },
  insertNulls: false,
  lineInterpolation: 'linear',
  lineWidth: 1,
  pointSize: 4,
  scaleDistribution: { type: 'linear' },
  showPoints: 'never',
  showValues: false,
  spanNulls: false,
  stacking: { group: 'A', mode: 'none' },
  thresholdsStyle: { mode: 'off' },
};

const SCENARIOS = {
  synthetic: {
    title: 'Synthetic three-query compact stress fixture',
    targets: ['A', 'B', 'C'].map((refId) => target(refId, `compact_fixture_${refId.toLowerCase()}`)),
    overrides: lineStyleOverrides(),
  },
  'single-query': {
    title: 'Synthetic single-query compact stress fixture',
    targets: [target('A', 'compact_fixture_single')],
    overrides: [],
  },
};

export async function createDashboardFixture({
  scenario: scenarioName,
  dashboardJson,
  panelId,
  pointCount,
  preservePanelGrid = false,
}) {
  return dashboardJson
    ? await createDashboardFromExport(dashboardJson, panelId, pointCount, preservePanelGrid)
    : createBuiltInDashboard(scenarioName, pointCount);
}

export async function createFullDashboardFixture(filePath, pointCount, { preserveRefresh = false } = {}) {
  const exported = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const sourceDashboard = exported.dashboard ?? exported;
  const dashboard = structuredClone(sourceDashboard);
  const sourcePanels = flattenPanels(sourceDashboard.panels ?? []);
  const sourcePanelsById = new Map(sourcePanels.map((panel) => [String(panel.id), panel]));

  dashboard.id = null;
  dashboard.uid = DASHBOARD_UID;
  dashboard.title = `Full replay: ${sourceDashboard.title}`;
  dashboard.version = 0;
  dashboard.refresh = preserveRefresh ? sourceDashboard.refresh : '';
  dashboard.templating = { list: createConstantVariables(sourceDashboard.templating?.list) };
  dashboard.annotations = { list: [] };
  dashboard.panels = rewriteFullDashboardPanels(sourceDashboard.panels ?? [], pointCount);

  const replayPanels = flattenPanels(dashboard.panels);
  const replayTimeSeriesPanels = replayPanels
    .filter((panel) => panel.type === 'timeseries')
    .map((panel) => {
      const sourcePanel = sourcePanelsById.get(String(panel.id)) ?? panel;
      const enabledTargets = (sourcePanel.targets ?? []).filter((target) => target.hide !== true);
      const compactIneligibility = getCompactTransportIneligibility(sourcePanel, enabledTargets);
      return {
        id: String(panel.id),
        title: panel.title ?? '',
        enabledTargetCount: enabledTargets.length,
        enabledRefIds: enabledTargets.map((target) => String(target.refId ?? '')),
        compactTransportEligible: compactIneligibility.length === 0,
        compactIneligibility,
      };
    });
  return {
    dashboard,
    source: {
      kind: 'full-dashboard-export',
      filePath,
      originalDashboardUid: sourceDashboard.uid,
      originalPanelCount: sourcePanels.length,
      replayPanelCount: replayPanels.length,
      omittedPanelCount: sourcePanels.length - replayPanels.length,
      replayTimeSeriesPanelCount: replayPanels.filter((panel) => panel.type === 'timeseries').length,
      replayTimeSeriesPanels,
      originalRefresh: sourceDashboard.refresh ?? '',
      replayRefresh: dashboard.refresh ?? '',
    },
  };
}

function getCompactTransportIneligibility(panel, targets) {
  const reasons = [];
  if (usesBarRendering(panel.fieldConfig)) {
    reasons.push('bar-rendering');
  }
  if (targets.length === 0) {
    reasons.push('no-enabled-targets');
    return reasons;
  }
  for (const target of targets) {
    const datasourceType = target.datasource?.type ?? panel.datasource?.type;
    if (datasourceType !== 'prometheus') {
      reasons.push('non-prometheus');
    }
    if (typeof target.expr !== 'string' || target.expr.length === 0) {
      reasons.push('missing-promql');
    }
    if (target.instant === true || target.range === false) {
      reasons.push('instant-query');
    }
    if (target.exemplar === true) {
      reasons.push('exemplars');
    }
    if (target.format != null && target.format !== '' && target.format !== 'time_series') {
      reasons.push('non-timeseries-format');
    }
  }
  return [...new Set(reasons)];
}

function usesBarRendering(fieldConfig) {
  if (fieldConfig?.defaults?.custom?.drawStyle === 'bars') {
    return true;
  }
  return (fieldConfig?.overrides ?? []).some((override) =>
    (override.properties ?? []).some((property) => property.id === 'custom.drawStyle' && property.value === 'bars')
  );
}

function createBuiltInDashboard(scenarioName, pointCount) {
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    throw new Error(`Unknown scenario "${scenarioName}". Expected one of: ${Object.keys(SCENARIOS).join(', ')}`);
  }
  return {
    dashboard: dashboardShell(scenario.title, createPanel(scenario, pointCount)),
    source: { kind: 'built-in', scenario: scenarioName },
  };
}

async function createDashboardFromExport(filePath, panelId, pointCount, preservePanelGrid) {
  const exported = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const sourceDashboard = exported.dashboard ?? exported;
  const panels = flattenPanels(sourceDashboard.panels ?? []);
  const sourcePanel =
    panelId == null
      ? panels.find((panel) => panel.type === 'timeseries')
      : panels.find((panel) => String(panel.id) === String(panelId));
  if (!sourcePanel) {
    throw new Error(
      panelId == null ? `No time-series panel found in ${filePath}` : `Panel ${panelId} was not found in ${filePath}`
    );
  }
  if (sourcePanel.type !== 'timeseries') {
    throw new Error(`Panel ${sourcePanel.id} is ${sourcePanel.type}, not timeseries`);
  }
  const panel = structuredClone(sourcePanel);
  panel.id = 1;
  panel.gridPos =
    preservePanelGrid && sourcePanel.gridPos ? { ...sourcePanel.gridPos, x: 0, y: 0 } : { h: 18, w: 24, x: 0, y: 0 };
  panel.datasource = rewriteDatasource(panel.datasource);
  panel.targets = (panel.targets ?? []).map((query) => ({
    ...query,
    datasource: rewriteDatasource(query.datasource),
    maxDataPoints: query.maxDataPoints ?? pointCount,
  }));
  return {
    dashboard: dashboardShell(`Replay: ${sourceDashboard.title} / ${sourcePanel.title}`, panel, sourceDashboard),
    source: {
      kind: 'dashboard-export',
      filePath,
      originalDashboardUid: sourceDashboard.uid,
      originalPanelId: sourcePanel.id,
      originalPanelTitle: sourcePanel.title,
    },
  };
}

function rewriteFullDashboardPanels(panels, pointCount) {
  const rewritten = [];
  for (const sourcePanel of panels) {
    if (!isReplayablePanel(sourcePanel)) {
      continue;
    }

    const panel = structuredClone(sourcePanel);
    panel.datasource = rewriteDatasource(panel.datasource);
    panel.targets = (panel.targets ?? []).map((query) => ({
      ...query,
      datasource: rewriteDatasource(query.datasource),
      maxDataPoints: query.maxDataPoints ?? pointCount,
    }));
    if (Array.isArray(panel.panels)) {
      panel.panels = rewriteFullDashboardPanels(panel.panels, pointCount);
    }
    rewritten.push(panel);
  }
  return rewritten;
}

function isReplayablePanel(panel) {
  return panel.type === 'row' || panel.type === 'text' || panel.type === 'timeseries' || panel.type === 'table';
}

function createPanel(scenario, pointCount) {
  return {
    id: 1,
    title: scenario.title,
    type: 'timeseries',
    datasource: rewriteDatasource(),
    gridPos: { h: 18, w: 24, x: 0, y: 0 },
    maxDataPoints: pointCount,
    fieldConfig: {
      defaults: {
        color: { mode: 'palette-classic-by-name' },
        custom: { ...BASE_CUSTOM },
        mappings: [],
        thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }] },
      },
      overrides: scenario.overrides,
    },
    options: {
      legend: { calcs: [], displayMode: 'list', placement: 'bottom', showLegend: true },
      tooltip: { mode: 'multi', sort: 'desc', hideZeros: true },
    },
    targets: scenario.targets.map((query) => ({ ...query, maxDataPoints: pointCount })),
  };
}

function dashboardShell(title, panel, sourceDashboard) {
  return {
    id: null,
    uid: DASHBOARD_UID,
    title,
    tags: ['gdev', 'compact-v1', 'memory'],
    timezone: sourceDashboard?.timezone ?? 'browser',
    schemaVersion: 41,
    version: 0,
    refresh: '',
    time: sourceDashboard?.time ?? { from: 'now-1h', to: 'now' },
    templating: { list: createConstantVariables(sourceDashboard?.templating?.list) },
    annotations: { list: [] },
    panels: [panel],
  };
}

function createConstantVariables(variables) {
  return (variables ?? []).map((variable) => {
    const value = getVariableValue(variable);
    return {
      name: variable.name,
      label: variable.label,
      type: 'constant',
      query: value,
      current: { selected: true, text: value, value },
      hide: 2,
      skipUrlSync: true,
    };
  });
}

function getVariableValue(variable) {
  const current = variable.current?.value ?? variable.current?.text;
  const firstValue = Array.isArray(current) ? current[0] : current;
  if (firstValue === '$__all' || firstValue === 'All' || firstValue == null || firstValue === '') {
    return '.*';
  }
  return String(firstValue);
}

function target(refId, expr, legendFormat = `${refId} - {{group}} {{series}}`) {
  return {
    refId,
    datasource: rewriteDatasource(),
    editorMode: 'code',
    expr,
    format: 'time_series',
    range: true,
    instant: false,
    exemplar: false,
    interval: '',
    intervalMs: 60_000,
    legendFormat,
  };
}

function lineStyleOverrides() {
  return [
    {
      matcher: { id: 'byFrameRefID', options: 'B' },
      properties: [{ id: 'custom.lineStyle', value: { fill: 'dash' } }],
    },
    {
      matcher: { id: 'byFrameRefID', options: 'C' },
      properties: [{ id: 'custom.lineStyle', value: { fill: 'dot' } }],
    },
  ];
}

function rewriteDatasource() {
  return { type: 'prometheus', uid: DATASOURCE_UID };
}

function flattenPanels(panels) {
  const result = [];
  for (const panel of panels) {
    result.push(panel);
    if (Array.isArray(panel.panels)) {
      result.push(...flattenPanels(panel.panels));
    }
  }
  return result;
}
