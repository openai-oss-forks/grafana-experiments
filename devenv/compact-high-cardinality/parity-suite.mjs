import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const dashboardJson = process.env.DASHBOARD_JSON;
if (!dashboardJson || process.argv.includes('--help')) {
  console.log(`Usage: DASHBOARD_JSON=/path/to/dashboard.json node devenv/compact-high-cardinality/parity-suite.mjs

Environment:
  GRAFANA_URL             Compact Grafana URL (default: http://127.0.0.1:3000)
  LEGACY_GRAFANA_URL      Optional JSON control URL (default: GRAFANA_URL)
  PANEL_IDS               Optional comma-separated panel IDs (default: representative Prometheus time-series panels)
  MAX_PANELS              Maximum automatically selected panels (default: 6)
  SERIES_PER_QUERY        Series generated for each query (default: 3)
  POINT_COUNT             Samples generated for each series (default: 120)
  DASHBOARD_FROM          Fixed start timestamp (default: 1700000000000)
  DASHBOARD_TO            Fixed end timestamp (default: 1700003600000)
  OUTPUT_DIR              Artifact directory (default: /tmp/grafana-compact-parity)
  MAX_MISMATCH_RATIO      Maximum compact-vs-JSON pixel mismatch ratio (default: 0.15)
  VERIFY_INTERACTIONS     Compare tooltip rows and ordering when set to 1 (default: 0)`);
  process.exit(dashboardJson ? 0 : 1);
}

const compactGrafanaUrl = process.env.GRAFANA_URL ?? 'http://127.0.0.1:3000';
const legacyGrafanaUrl = process.env.LEGACY_GRAFANA_URL ?? compactGrafanaUrl;
const outputDir = process.env.OUTPUT_DIR ?? '/tmp/grafana-compact-parity';
const maxPanels = readPositiveInteger('MAX_PANELS', 6);
const maxMismatchRatio = readRatio('MAX_MISMATCH_RATIO', 0.15);
const verifyInteractions = process.env.VERIFY_INTERACTIONS === '1';
const exported = JSON.parse(await fs.readFile(dashboardJson, 'utf8'));
const dashboard = exported.dashboard ?? exported;
const panels = flattenPanels(dashboard.panels ?? []).filter(isPrometheusTimeSeriesPanel);
const selected = selectPanels(panels, process.env.PANEL_IDS, maxPanels);
const results = [];

await fs.mkdir(outputDir, { recursive: true });

for (const panel of selected) {
  const panelDir = path.join(outputDir, String(panel.id));
  const compactDir = path.join(panelDir, 'auto');
  await runPanel(panel, compactDir, 'auto', 'auto', compactGrafanaUrl);
  const compactReport = await readReport(compactDir);
  const requestedFormat = compactReport.queryRequests[0]?.preferredFormat ?? 'json';

  if (requestedFormat !== 'compact-v1') {
    results.push({
      panelId: panel.id,
      title: panel.title,
      requestedFormat,
      responseFormat: compactReport.queryRequests[0]?.responseFormat,
      status: compactReport.status,
      visualParity: 'not-applicable',
    });
    continue;
  }

  const jsonDir = path.join(panelDir, 'json');
  await runPanel(panel, jsonDir, 'json', 'auto', legacyGrafanaUrl);
  const jsonReport = await readReport(jsonDir);
  const comparison = await comparePng(path.join(compactDir, 'chart.png'), path.join(jsonDir, 'chart.png'), panelDir);
  const tooltipSampleParity = arraysEqual(
    compactReport.interactions?.tooltip?.sampleRows,
    jsonReport.interactions?.tooltip?.sampleRows
  );
  const tooltipRowCountParity =
    compactReport.interactions?.tooltip?.totalRows === jsonReport.interactions?.tooltip?.totalRows;
  const tooltipDigestParity =
    compactReport.interactions?.tooltipRowDigest === jsonReport.interactions?.tooltipRowDigest;
  const tooltipContentParity =
    compactReport.interactions?.tooltipContentDigest === jsonReport.interactions?.tooltipContentDigest;
  const tooltipOrderParity = normalizedTooltipRowsEqual(
    compactReport.interactions?.tooltipRowHashes,
    compactReport.interactions?.tooltipFocusedHash,
    jsonReport.interactions?.tooltipRowHashes
  );
  const passed =
    comparison.mismatchRatio <= maxMismatchRatio &&
    (!verifyInteractions || (tooltipRowCountParity && tooltipContentParity && tooltipOrderParity));
  results.push({
    panelId: panel.id,
    title: panel.title,
    requestedFormat,
    responseFormat: compactReport.queryRequests[0]?.responseFormat,
    compactPaintMs: initialPaint(compactReport),
    jsonPaintMs: initialPaint(jsonReport),
    compactHeapMB: initialHeap(compactReport),
    jsonHeapMB: initialHeap(jsonReport),
    compactTooltipRows: compactReport.interactions?.tooltip?.totalRows,
    jsonTooltipRows: jsonReport.interactions?.tooltip?.totalRows,
    tooltipSampleParity,
    tooltipRowCountParity,
    tooltipDigestParity,
    tooltipContentParity,
    tooltipOrderParity,
    visualParity: passed ? 'passed' : 'failed',
    ...comparison,
  });
}

const failures = results.filter((result) => result.visualParity === 'failed');
const compactPanels = results.filter((result) => result.requestedFormat === 'compact-v1').length;
const summary = {
  dashboard: { uid: dashboard.uid, title: dashboard.title },
  maxMismatchRatio,
  selectedPanels: selected.map(({ id, title }) => ({ id, title })),
  compactPanels,
  jsonOnlyPanels: results.filter((result) => result.requestedFormat !== 'compact-v1').length,
  failures: failures.length,
  results,
};
const summaryPath = path.join(outputDir, 'summary.json');
await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.table(results);
console.log(`Parity summary: ${summaryPath}`);
if (failures.length > 0 || compactPanels === 0) {
  process.exitCode = 1;
}

function arraysEqual(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function normalizedTooltipRowsEqual(compactRows, focusedHash, jsonRows) {
  if (!Array.isArray(compactRows) || !Array.isArray(jsonRows)) {
    return false;
  }
  const normalizedJsonRows = [...jsonRows];
  if (focusedHash) {
    const focusedIndex = normalizedJsonRows.indexOf(focusedHash);
    if (focusedIndex < 0) {
      return false;
    }
    normalizedJsonRows.splice(focusedIndex, 1);
  }
  return arraysEqual(compactRows, normalizedJsonRows);
}

function runPanel(panel, panelOutput, expectedFormat, responseFormat, grafanaUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['devenv/compact-high-cardinality/run.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DASHBOARD_JSON: dashboardJson,
        GRAFANA_URL: grafanaUrl,
        PANEL_ID: String(panel.id),
        EXPECTED_FORMAT: expectedFormat,
        REQUEST_FORMAT: expectedFormat === 'json' ? 'json' : 'auto',
        RESPONSE_FORMAT: responseFormat,
        SERIES_PER_QUERY: process.env.SERIES_PER_QUERY ?? '3',
        POINT_COUNT: process.env.POINT_COUNT ?? '120',
        GAPPED_SERIES_EVERY: process.env.GAPPED_SERIES_EVERY ?? '2',
        GAP_EVERY: process.env.GAP_EVERY ?? '17',
        SEED: process.env.SEED ?? '7',
        DASHBOARD_FROM: process.env.DASHBOARD_FROM ?? '1700000000000',
        DASHBOARD_TO: process.env.DASHBOARD_TO ?? '1700003600000',
        REFRESHES: '0',
        VERIFY_INTERACTIONS: verifyInteractions ? '1' : '0',
        VERIFY_TOOLTIP_DIGEST: verifyInteractions ? '1' : '0',
        HEADLESS: '1',
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

async function comparePng(compactPath, jsonPath, outputPath) {
  const [compact, json] = await Promise.all([readPng(compactPath), readPng(jsonPath)]);
  if (compact.width !== json.width || compact.height !== json.height) {
    return {
      width: compact.width,
      height: compact.height,
      jsonWidth: json.width,
      jsonHeight: json.height,
      mismatchedPixels: compact.width * compact.height,
      mismatchRatio: 1,
    };
  }
  const diff = new PNG({ width: compact.width, height: compact.height });
  const mismatchedPixels = pixelmatch(compact.data, json.data, diff.data, compact.width, compact.height, {
    threshold: 0.1,
    includeAA: false,
  });
  await fs.writeFile(path.join(outputPath, 'diff.png'), PNG.sync.write(diff));
  return {
    width: compact.width,
    height: compact.height,
    mismatchedPixels,
    mismatchRatio: round(mismatchedPixels / (compact.width * compact.height)),
  };
}

async function readPng(filePath) {
  return PNG.sync.read(await fs.readFile(filePath));
}

async function readReport(outputPath) {
  return JSON.parse(await fs.readFile(path.join(outputPath, 'metrics.json'), 'utf8'));
}

function initialPaint(report) {
  return report.samples.find((sample) => sample.label === 'initial-render')?.paint?.responseToCompleteMs;
}

function initialHeap(report) {
  return report.samples.find((sample) => sample.label === 'initial-render')?.usedHeapMB;
}

function selectPanels(panels, configuredIds, limit) {
  if (configuredIds) {
    const byId = new Map(panels.map((panel) => [String(panel.id), panel]));
    return configuredIds.split(',').map((rawId) => {
      const id = rawId.trim();
      const panel = byId.get(id);
      if (!panel) {
        throw new Error(`Prometheus time-series panel ${id} was not found`);
      }
      return panel;
    });
  }

  const result = [];
  const seenSignatures = new Set();
  const prioritized = [...panels].sort((left, right) => visibleTargetCount(right) - visibleTargetCount(left));
  for (const panel of prioritized) {
    const signature = panelSignature(panel);
    if (seenSignatures.has(signature) && result.length > 0) {
      continue;
    }
    seenSignatures.add(signature);
    result.push(panel);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function panelSignature(panel) {
  const custom = panel.fieldConfig?.defaults?.custom ?? {};
  return [
    custom.drawStyle ?? 'line',
    custom.stacking?.mode ?? 'none',
    custom.scaleDistribution?.type ?? 'linear',
    custom.fillOpacity ?? 0,
    panel.options?.legend?.displayMode ?? 'list',
    panel.options?.tooltip?.mode ?? 'single',
    visibleTargetCount(panel) > 6 ? 'many-targets' : 'few-targets',
  ].join('|');
}

function isPrometheusTimeSeriesPanel(panel) {
  const targets = panel.targets?.filter((target) => !target.hide) ?? [];
  return (
    panel.type === 'timeseries' &&
    targets.length > 0 &&
    targets.every(
      (target) => target.datasource?.type === 'prometheus' && typeof target.expr === 'string' && target.expr.length > 0
    )
  );
}

function visibleTargetCount(panel) {
  return panel.targets?.filter((target) => !target.hide).length ?? 0;
}

function flattenPanels(panels) {
  return panels.flatMap((panel) => [panel, ...(Array.isArray(panel.panels) ? flattenPanels(panel.panels) : [])]);
}

function readPositiveInteger(name, defaultValue) {
  const value = Number(process.env[name] ?? defaultValue);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function readRatio(name, defaultValue) {
  const value = Number(process.env[name] ?? defaultValue);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
  return value;
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}
