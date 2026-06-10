import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const profile = process.env.BENCHMARK_PROFILE ?? 'standard';
const rootOutput = process.env.OUTPUT_DIR ?? '/tmp/grafana-compact-suite';
const scenarios = {
  smoke: [
    {
      name: 'multi-query-correctness',
      env: {
        SCENARIO: 'synthetic',
        SERIES_PER_QUERY: '4',
        POINT_COUNT: '120',
        REFRESHES: '1',
        VERIFY_INTERACTIONS: '1',
      },
    },
  ],
  standard: [
    {
      name: 'multi-query-correctness',
      env: {
        SCENARIO: 'synthetic',
        SERIES_PER_QUERY: '4',
        POINT_COUNT: '120',
        REFRESHES: '1',
        VERIFY_INTERACTIONS: '1',
      },
    },
    {
      name: 'multi-query-refresh',
      env: { SCENARIO: 'synthetic', SERIES_PER_QUERY: '500', POINT_COUNT: '180', REFRESHES: '3' },
    },
    {
      name: 'single-query-cardinality',
      env: { SCENARIO: 'single-query', SERIES_PER_QUERY: '5000', POINT_COUNT: '360', REFRESHES: '1' },
    },
  ],
  crash: [
    {
      name: 'high-cardinality-multi-query',
      env: { SCENARIO: 'synthetic', SERIES_PER_QUERY: '2500', POINT_COUNT: '863', REFRESHES: '1', CPU_PROFILE: '1' },
    },
  ],
};

if (!scenarios[profile]) {
  throw new Error(`Unknown BENCHMARK_PROFILE "${profile}". Expected: ${Object.keys(scenarios).join(', ')}`);
}

await fs.mkdir(rootOutput, { recursive: true });
const results = [];
for (const scenario of scenarios[profile]) {
  const outputDir = path.join(rootOutput, scenario.name);
  await runScenario(scenario, outputDir);
  const report = JSON.parse(await fs.readFile(path.join(outputDir, 'metrics.json'), 'utf8'));
  results.push({
    name: scenario.name,
    status: report.status,
    series: report.queryRequests[0]?.seriesCount ?? 0,
    points: report.config.pointCount,
    rawBodyMB: mb(report.queryRequests[0]?.rawResponseBytes),
    gzipBodyMB: mb(report.queryRequests[0]?.gzipResponseBytes),
    brotliBodyMB: mb(report.queryRequests[0]?.brotliResponseBytes),
    initialPaintMs: report.samples.find((sample) => sample.label === 'initial-render')?.paint?.responseToPaintMs,
    finalPaintMs: report.samples.at(-2)?.paint?.responseToPaintMs,
    activeBackingMB: report.samples.find((sample) => sample.label === 'initial-render')?.backingStorageMB,
    finalBackingMB: report.samples.at(-2)?.backingStorageMB,
    domNodes: report.samples.find((sample) => sample.label === 'initial-render')?.dom?.nodes,
    legendButtons: report.samples.find((sample) => sample.label === 'initial-render')?.dom?.legendItems,
    tooltipMs: report.interactions?.hoverToTooltipMs,
  });
}

const outputPath = path.join(rootOutput, 'summary.json');
await fs.writeFile(outputPath, `${JSON.stringify({ profile, results }, null, 2)}\n`);
console.table(results);
console.log(`Benchmark summary: ${outputPath}`);

function runScenario(scenario, outputDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['devenv/compact-high-cardinality/run.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HEADLESS: process.env.HEADLESS ?? '1',
        OUTPUT_DIR: outputDir,
        ...scenario.env,
      },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${scenario.name} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
      }
    });
  });
}

function mb(bytes) {
  return bytes == null ? undefined : Math.round((bytes / (1024 * 1024)) * 100) / 100;
}
