import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const dashboardJson = process.env.DASHBOARD_JSON;
if (!dashboardJson || process.argv.includes('--help')) {
  console.log(`Usage: DASHBOARD_JSON=/path/to/dashboard.json node devenv/compact-high-cardinality/dashboard-suite.mjs

Environment:
  MAX_PANELS              Maximum representative panels (default: 20)
  PANEL_IDS               Optional comma-separated panel IDs instead of automatic selection
  SERIES_PER_QUERY        Series generated for each query (default: 2)
  POINT_COUNT             Samples generated for each series (default: 120)
  OUTPUT_DIR              Artifact directory (default: /tmp/grafana-compact-dashboard-suite)
  VERIFY_INTERACTIONS     Set to 1 to check interactions on every selected panel`);
  process.exit(dashboardJson ? 0 : 1);
}

const outputDir = process.env.OUTPUT_DIR ?? '/tmp/grafana-compact-dashboard-suite';
const maxPanels = readPositiveInteger('MAX_PANELS', 20);
const exported = JSON.parse(await fs.readFile(dashboardJson, 'utf8'));
const dashboard = exported.dashboard ?? exported;
const panels = flattenPanels(dashboard.panels ?? []);
const timeSeriesPanels = panels.filter(isBenchmarkableTimeSeriesPanel);
const selected = selectPanels(timeSeriesPanels, maxPanels, process.env.PANEL_IDS);
const universe = new Set(timeSeriesPanels.flatMap(panelFeatures));
const covered = new Set(selected.flatMap(panelFeatures));
const uncovered = [...universe].filter((feature) => !covered.has(feature)).sort();

await fs.mkdir(outputDir, { recursive: true });
const results = [];
for (let index = 0; index < selected.length; index++) {
  const panel = selected[index];
  const panelOutput = path.join(outputDir, `${String(index + 1).padStart(2, '0')}-${panel.id}`);
  await runPanel(panel, panelOutput);
  const report = JSON.parse(await fs.readFile(path.join(panelOutput, 'metrics.json'), 'utf8'));
  results.push({
    panelId: panel.id,
    title: panel.title,
    targetCount: panel.targets?.filter((target) => !target.hide).length ?? 0,
    status: report.status,
    format: report.queryRequests[0]?.responseFormat,
    series: report.queryRequests[0]?.seriesCount,
    rawBodyMB: mb(report.queryRequests[0]?.rawResponseBytes),
    gzipBodyMB: mb(report.queryRequests[0]?.gzipResponseBytes),
    brotliBodyMB: mb(report.queryRequests[0]?.brotliResponseBytes),
    paintMs: report.samples.find((sample) => sample.label === 'initial-render')?.paint?.responseToPaintMs,
    usedHeapMB: report.samples.find((sample) => sample.label === 'initial-render')?.usedHeapMB,
    backingMB: report.samples.find((sample) => sample.label === 'initial-render')?.backingStorageMB,
    domNodes: report.samples.find((sample) => sample.label === 'initial-render')?.dom?.nodes,
  });
}

const summary = {
  dashboard: { uid: dashboard.uid, title: dashboard.title },
  inventory: {
    panelCount: panels.length,
    timeSeriesPanelCount: timeSeriesPanels.length,
    configurationFeatureCount: universe.size,
    coveredConfigurationFeatureCount: covered.size,
    configurationCoverage: round(covered.size / Math.max(1, universe.size)),
    uncoveredConfigurationFeatures: uncovered,
  },
  selectedPanels: selected.map((panel) => ({ id: panel.id, title: panel.title })),
  formats: {
    compact: results.filter((result) => result.format === 'compact-v1').length,
    json: results.filter((result) => result.format === 'json').length,
  },
  results,
};
const summaryPath = path.join(outputDir, 'summary.json');
await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.table(results);
console.log(
  `Covered ${covered.size}/${universe.size} dashboard configuration features with ${selected.length}/${timeSeriesPanels.length} panel-isolated time-series runs.`
);
console.log(`Dashboard panel-sweep summary: ${summaryPath}`);

function runPanel(panel, panelOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['devenv/compact-high-cardinality/run.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DASHBOARD_JSON: dashboardJson,
        PANEL_ID: String(panel.id),
        EXPECTED_FORMAT: 'auto',
        SERIES_PER_QUERY: process.env.SERIES_PER_QUERY ?? '2',
        POINT_COUNT: process.env.POINT_COUNT ?? '120',
        REFRESHES: '0',
        VERIFY_INTERACTIONS: process.env.VERIFY_INTERACTIONS ?? '0',
        HEADLESS: process.env.HEADLESS ?? '1',
        OUTPUT_DIR: panelOutput,
      },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Panel ${panel.id} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
      }
    });
  });
}

function selectPanels(panels, limit, configuredIds) {
  if (configuredIds) {
    const byId = new Map(panels.map((panel) => [String(panel.id), panel]));
    return configuredIds.split(',').map((id) => {
      const panel = byId.get(id.trim());
      if (!panel) {
        throw new Error(`Benchmarkable Prometheus time-series panel ${id} was not found`);
      }
      return panel;
    });
  }

  if (panels.length === 0) {
    throw new Error('Dashboard has no benchmarkable Prometheus time-series panels');
  }

  const maximumTargetPanel = panels.reduce((current, panel) =>
    visibleTargetCount(panel) > visibleTargetCount(current) ? panel : current
  );
  const selected = [maximumTargetPanel];
  const selectedIds = new Set([maximumTargetPanel.id]);
  const uncovered = new Set(panels.flatMap(panelFeatures));
  removeCovered(uncovered, selected);

  while (selected.length < limit && uncovered.size > 0) {
    let bestPanel;
    let bestScore = 0;
    for (const panel of panels) {
      if (selectedIds.has(panel.id)) {
        continue;
      }
      const score = panelFeatures(panel).filter((feature) => uncovered.has(feature)).length;
      if (
        score > bestScore ||
        (score === bestScore && bestPanel && visibleTargetCount(panel) > visibleTargetCount(bestPanel))
      ) {
        bestPanel = panel;
        bestScore = score;
      }
    }
    if (!bestPanel || bestScore === 0) {
      break;
    }
    selected.push(bestPanel);
    selectedIds.add(bestPanel.id);
    removeCovered(uncovered, [bestPanel]);
  }
  return selected;
}

function panelFeatures(panel) {
  const features = new Set();
  features.add(`target-count:${targetCountBucket(visibleTargetCount(panel))}`);
  for (const target of panel.targets ?? []) {
    if (target.hide) {
      continue;
    }
    features.add(
      `target:${target.instant === true ? 'instant' : 'range'}:${target.exemplar === true ? 'exemplar' : 'plain'}:${target.format ?? ''}`
    );
  }
  addObjectFeatures(features, 'default.custom', panel.fieldConfig?.defaults?.custom);
  addObjectFeatures(features, 'default.color', panel.fieldConfig?.defaults?.color);
  if (panel.fieldConfig?.defaults?.links?.length) {
    features.add('default:links');
  }
  if (panel.fieldConfig?.defaults?.actions?.length) {
    features.add('default:actions');
  }
  for (const override of panel.fieldConfig?.overrides ?? []) {
    features.add(`matcher:${override.matcher?.id}`);
    for (const property of override.properties ?? []) {
      features.add(`override:${property.id}:${valueCategory(property.value)}`);
    }
  }
  features.add(`legend:${valueCategory(panel.options?.legend)}`);
  features.add(`tooltip:${valueCategory(panel.options?.tooltip)}`);
  features.add(`orientation:${panel.options?.orientation ?? 'horizontal'}`);
  return [...features];
}

function addObjectFeatures(features, prefix, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }
  for (const [key, propertyValue] of Object.entries(value)) {
    features.add(`${prefix}.${key}:${valueCategory(propertyValue)}`);
  }
}

function valueCategory(value) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    return value.startsWith('#') || value.startsWith('rgb') ? 'fixed-color' : value;
  }
  if (Array.isArray(value)) {
    return `[${value.map(valueCategory).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${key}=${valueCategory(value[key])}`)
    .join(',')}}`;
}

function removeCovered(uncovered, panels) {
  for (const panel of panels) {
    for (const feature of panelFeatures(panel)) {
      uncovered.delete(feature);
    }
  }
}

function isBenchmarkableTimeSeriesPanel(panel) {
  if (panel.type !== 'timeseries') {
    return false;
  }
  const targets = panel.targets?.filter((target) => !target.hide) ?? [];
  return targets.length > 0 && targets.every(isPrometheusTarget);
}

function isPrometheusTarget(target) {
  return target.datasource?.type === 'prometheus' && typeof target.expr === 'string' && target.expr.length > 0;
}

function visibleTargetCount(panel) {
  return panel?.targets?.filter((target) => !target.hide).length ?? 0;
}

function targetCountBucket(count) {
  return count <= 3 ? String(count) : count <= 6 ? '4-6' : '7+';
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

function readPositiveInteger(name, defaultValue) {
  const value = Number(process.env[name] ?? defaultValue);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function mb(bytes) {
  return bytes == null ? undefined : round(bytes / (1024 * 1024));
}

function round(value) {
  return Math.round(value * 100) / 100;
}
