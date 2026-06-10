import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const dashboardJson = process.env.DASHBOARD_JSON;
const panelId = process.env.PANEL_ID;
if (!dashboardJson || !panelId || process.argv.includes('--help')) {
  console.log(`Usage:
  DASHBOARD_JSON=/path/to/dashboard.json PANEL_ID=42 node devenv/compact-high-cardinality/hover-benchmark.mjs

Environment:
  SERIES_PER_QUERY_SET  Comma-separated workload sizes (default: 15,100,250)
  TOOLTIP_VARIANTS      Comma-separated single,unsorted,ascending,descending (default: all)
  HOVER_PATTERNS        Comma-separated horizontal,vertical,sweep (default: horizontal)
  WARMUPS               Warmup runs per format and scenario (default: 2)
  RUNS                  Measured runs per format and scenario (default: 7)
  HOVER_STEPS           Mouse movements per run (default: 120)
  POINT_COUNT           Samples per series (default: 360)
  DASHBOARD_FROM        Fixed start timestamp shared by every run
  DASHBOARD_TO          Fixed end timestamp shared by every run
  RESPONSE_JSON         Optional captured Grafana JSON response
  OUTPUT_DIR            Artifact directory (default: /tmp/grafana-compact-hover)
  GRAFANA_URL           Compact Grafana URL (default: http://127.0.0.1:3000)
  LEGACY_GRAFANA_URL    Unmodified Grafana URL used for true no-header JSON runs`);
  process.exit(dashboardJson && panelId ? 0 : 1);
}

const outputDir = process.env.OUTPUT_DIR ?? '/tmp/grafana-compact-hover';
const seriesSet = readIntegerList('SERIES_PER_QUERY_SET', [15, 100, 250]);
const variants = readList('TOOLTIP_VARIANTS', ['single', 'unsorted', 'ascending', 'descending']);
const hoverPatterns = readList('HOVER_PATTERNS', ['horizontal']);
for (const pattern of hoverPatterns) {
  if (pattern !== 'horizontal' && pattern !== 'vertical' && pattern !== 'sweep') {
    throw new Error('HOVER_PATTERNS must contain only horizontal, vertical, or sweep');
  }
}
const warmups = readNonNegativeInteger('WARMUPS', 2);
const runs = readPositiveInteger('RUNS', 7);
const hoverSteps = readPositiveInteger('HOVER_STEPS', 120);
const pointCount = readPositiveInteger('POINT_COUNT', 360);
const dashboardFrom = readTimestamp('DASHBOARD_FROM', 1_700_000_000_000);
const dashboardTo = readTimestamp('DASHBOARD_TO', dashboardFrom + 60 * 60 * 1000);
if (dashboardTo <= dashboardFrom) {
  throw new Error('DASHBOARD_TO must be greater than DASHBOARD_FROM');
}
const compactGrafanaUrl = process.env.GRAFANA_URL ?? 'http://127.0.0.1:3000';
const legacyGrafanaUrl = process.env.LEGACY_GRAFANA_URL;
if (!legacyGrafanaUrl) {
  throw new Error('LEGACY_GRAFANA_URL is required so JSON runs use an unmodified Grafana build');
}
const formats = ['compact-v1', 'json'];
const source = JSON.parse(await fs.readFile(dashboardJson, 'utf8'));
const results = [];

await fs.mkdir(outputDir, { recursive: true });

for (const variant of variants) {
  const variantPath = path.join(outputDir, `dashboard-${variant}.json`);
  await fs.writeFile(variantPath, `${JSON.stringify(createVariant(source, panelId, variant))}\n`);

  for (const seriesPerQuery of seriesSet) {
    for (const hoverPattern of hoverPatterns) {
      const reports = new Map(formats.map((format) => [format, []]));
      const totalIterations = warmups + runs;
      for (let iteration = 0; iteration < totalIterations; iteration++) {
        const formatOrder = iteration % 2 === 0 ? formats : [...formats].reverse();
        const iterationReports = new Map();
        for (const format of formatOrder) {
          const runDir = path.join(
            outputDir,
            variant,
            String(seriesPerQuery),
            hoverPattern,
            format,
            iteration < warmups ? `warmup-${iteration + 1}` : `run-${iteration - warmups + 1}`
          );
          await runScenario({
            format,
            hoverPattern,
            hoverYFraction: variant === 'single' ? 0.85 : 0.45,
            variantPath,
            seriesPerQuery,
            runDir,
            seed: iteration + 1,
            verifyTooltipDigest: iteration === 0,
          });
          const report = JSON.parse(await fs.readFile(path.join(runDir, 'metrics.json'), 'utf8'));
          iterationReports.set(format, report);
          if (iteration >= warmups) {
            reports.get(format).push(report);
          }
        }
        assertTooltipParity(iterationReports.get('compact-v1'), iterationReports.get('json'), {
          variant,
          seriesPerQuery,
          hoverPattern,
          iteration: iteration + 1,
        });
      }

      for (const format of formats) {
        results.push(summarize(variant, seriesPerQuery, hoverPattern, format, reports.get(format)));
      }
    }
  }
}

const summary = {
  dashboardJson,
  panelId,
  warmups,
  runs,
  hoverSteps,
  hoverPatterns,
  pointCount,
  dashboardFrom,
  dashboardTo,
  results,
};
await fs.writeFile(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.table(results);
console.log(`Hover benchmark summary: ${path.join(outputDir, 'summary.json')}`);

function assertTooltipParity(compactReport, jsonReport, context) {
  const compactTooltip = compactReport?.interactions?.tooltip;
  const jsonTooltip = jsonReport?.interactions?.tooltip;
  if (!compactTooltip || !jsonTooltip) {
    throw new Error(`Missing tooltip results for ${JSON.stringify(context)}`);
  }
  if (compactTooltip.totalRows !== jsonTooltip.totalRows) {
    throw new Error(
      `Tooltip row count differs for ${JSON.stringify(context)}: compact=${compactTooltip.totalRows}, json=${jsonTooltip.totalRows}`
    );
  }
  if (JSON.stringify(compactTooltip.sampleRows) !== JSON.stringify(jsonTooltip.sampleRows)) {
    throw new Error(
      `Tooltip labels, values, or ordering differ for ${JSON.stringify(context)}:\n` +
        `compact=${JSON.stringify(compactTooltip.sampleRows)}\njson=${JSON.stringify(jsonTooltip.sampleRows)}`
    );
  }
  const compactDigest = compactReport.interactions?.tooltipRowDigest;
  const jsonDigest = jsonReport.interactions?.tooltipRowDigest;
  if ((compactDigest == null) !== (jsonDigest == null) || (compactDigest != null && compactDigest !== jsonDigest)) {
    throw new Error(
      `Full tooltip digest differs for ${JSON.stringify(context)}: compact=${compactDigest} json=${jsonDigest}`
    );
  }
}

function runScenario({
  format,
  hoverPattern,
  hoverYFraction,
  variantPath,
  seriesPerQuery,
  runDir,
  seed,
  verifyTooltipDigest,
}) {
  const json = format === 'json';
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['devenv/compact-high-cardinality/run.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DASHBOARD_JSON: variantPath,
        PANEL_ID: panelId,
        SERIES_PER_QUERY: String(seriesPerQuery),
        POINT_COUNT: String(pointCount),
        REFRESHES: '0',
        VERIFY_INTERACTIONS: '1',
        VERIFY_TOOLTIP_DIGEST: verifyTooltipDigest ? '1' : '0',
        HOVER_STEPS: String(hoverSteps),
        HOVER_PATTERN: hoverPattern,
        ...(hoverYFraction == null ? {} : { HOVER_Y_FRACTION: String(hoverYFraction) }),
        DASHBOARD_FROM: String(dashboardFrom),
        DASHBOARD_TO: String(dashboardTo),
        PRESERVE_PANEL_GRID: '1',
        DEVICE_SCALE_FACTOR: '1',
        HEADLESS: '1',
        SEED: String(seed),
        EXPECTED_FORMAT: json ? 'json' : 'compact-v1',
        RESPONSE_FORMAT: json ? 'json' : 'compact-v1',
        REQUEST_FORMAT: 'auto',
        GRAFANA_URL: json ? legacyGrafanaUrl : compactGrafanaUrl,
        OUTPUT_DIR: runDir,
      },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${format} benchmark failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
      }
    });
  });
}

function summarize(variant, seriesPerQuery, hoverPattern, format, reports) {
  const hoverSamples = reports.flatMap((report) => report.interactions.repeatedHover.samples);
  const commitSamples = hoverSamples.flatMap((sample) =>
    sample.inputToCommitMs == null ? [] : [sample.inputToCommitMs]
  );
  const paintSamples = hoverSamples.map((sample) => sample.inputToNextPaintMs);
  const firstHoverSamples = reports.map((report) => report.interactions.hoverToTooltipMs);
  const mountedRows = reports.map((report) => report.interactions.tooltip.mountedRows);
  const totalRows = reports.map((report) => report.interactions.tooltip.totalRows);
  const mutationTotals = hoverSamples.reduce(
    (total, sample) => {
      total.added += sample.mutations.addedNodes;
      total.removed += sample.mutations.removedNodes;
      total.attributes += sample.mutations.attributeMutations;
      total.text += sample.mutations.textMutations;
      return total;
    },
    { added: 0, removed: 0, attributes: 0, text: 0 }
  );
  const stage = (name) => reports.map((report) => report.interactions.repeatedHover.stages?.[name]).filter(Boolean);
  const longTasks = reports.map((report) => report.interactions.repeatedHover.longTasks);

  return {
    variant,
    hoverPattern,
    seriesPerQuery,
    series: reports[0]?.queryRequests[0]?.seriesCount ?? 0,
    format,
    firstHoverP50Ms: percentile(firstHoverSamples, 0.5),
    commitP50Ms: percentile(commitSamples, 0.5),
    commitP95Ms: percentile(commitSamples, 0.95),
    paintP50Ms: percentile(paintSamples, 0.5),
    paintP95Ms: percentile(paintSamples, 0.95),
    paintP99Ms: percentile(paintSamples, 0.99),
    mountedRowsMax: Math.max(...mountedRows),
    totalRowsMax: Math.max(...totalRows),
    addedNodesPerMove: divide(mutationTotals.added, hoverSamples.length),
    removedNodesPerMove: divide(mutationTotals.removed, hoverSamples.length),
    attributeMutationsPerMove: divide(mutationTotals.attributes, hoverSamples.length),
    textMutationsPerMove: divide(mutationTotals.text, hoverSamples.length),
    sampleResolutionP50Ms: percentile(
      stage('sampleResolution').map((sample) => sample.durationP50Ms),
      0.5
    ),
    focusSelectionP50Ms: percentile(
      stage('focusSelection').map((sample) => sample.durationP50Ms),
      0.5
    ),
    focusRedrawP50Ms: percentile(
      stage('focusRedraw').map((sample) => sample.durationP50Ms),
      0.5
    ),
    tooltipFilterP50Ms: percentile(
      stage('tooltipFilter').map((sample) => sample.durationP50Ms),
      0.5
    ),
    tooltipSortP50Ms: percentile(
      stage('tooltipSort').map((sample) => sample.durationP50Ms),
      0.5
    ),
    longTaskCount: longTasks.reduce((total, sample) => total + (sample?.count ?? 0), 0),
    longTaskTotalMs: round(longTasks.reduce((total, sample) => total + (sample?.totalDurationMs ?? 0), 0)),
    sweepMaxBacklog: maximum(reports.map((report) => report.interactions.repeatedHover.continuousSweep?.maxBacklog)),
    sweepFinalBacklog: maximum(
      reports.map((report) => report.interactions.repeatedHover.continuousSweep?.finalBacklog)
    ),
    sweepSettleP95Ms: percentile(
      reports.flatMap((report) => {
        const value = report.interactions.repeatedHover.continuousSweep?.settleAfterLastInputMs;
        return value == null ? [] : [value];
      }),
      0.95
    ),
  };
}

function createVariant(exported, targetPanelId, variant) {
  const clone = structuredClone(exported);
  const dashboard = clone.dashboard ?? clone;
  const panel = findPanel(dashboard.panels ?? [], targetPanelId);
  if (!panel) {
    throw new Error(`Panel ${targetPanelId} was not found`);
  }
  panel.options ??= {};
  panel.options.tooltip ??= {};
  if (variant === 'single') {
    panel.options.tooltip.mode = 'single';
    panel.options.tooltip.sort = 'none';
  } else {
    panel.options.tooltip.mode = 'multi';
    panel.options.tooltip.sort = variant === 'ascending' ? 'asc' : variant === 'descending' ? 'desc' : 'none';
  }
  return clone;
}

function findPanel(panels, targetPanelId) {
  for (const panel of panels) {
    if (String(panel.id) === String(targetPanelId)) {
      return panel;
    }
    const nested = findPanel(panel.panels ?? [], targetPanelId);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function readList(name, defaults) {
  const raw = process.env[name];
  return raw
    ? raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    : defaults;
}

function readIntegerList(name, defaults) {
  return readList(name, defaults.map(String)).map((value) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error(`${name} must contain positive safe integers`);
    }
    return parsed;
  });
}

function readPositiveInteger(name, defaultValue) {
  const value = readNonNegativeInteger(name, defaultValue);
  if (value < 1) {
    throw new Error(`${name} must be at least 1`);
  }
  return value;
}

function readNonNegativeInteger(name, defaultValue) {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? defaultValue : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function readTimestamp(name, defaultValue) {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? defaultValue : Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer timestamp`);
  }
  return value;
}

function percentile(values, fraction) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]);
}

function maximum(values) {
  const present = values.filter((value) => value != null);
  return present.length === 0 ? null : Math.max(...present);
}

function divide(numerator, denominator) {
  return denominator === 0 ? null : round(numerator / denominator);
}

function round(value) {
  return Math.round(value * 100) / 100;
}
