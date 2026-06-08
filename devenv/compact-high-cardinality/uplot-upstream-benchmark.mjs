import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import * as esbuild from 'esbuild';
import { chromium } from 'playwright';

const UPSTREAM_VERSION = '1.6.32';
const UPSTREAM_DATA_URL = `https://raw.githubusercontent.com/leeoniya/uPlot/${UPSTREAM_VERSION}/bench/data.json`;
const UPSTREAM_DATA_SHA256 = '620ec683dfb856af79185dc1e42536c5e39a1fb1deebcff9202c7a660e54bf41';
const allFixtures = ['server-events', '600-series', '2m-single', '50-series'];
const fixtures = (process.env.UPLOT_FIXTURES ?? allFixtures.join(','))
  .split(',')
  .map((fixture) => fixture.trim())
  .filter(Boolean);
const iterations = readPositiveInteger('ITERATIONS', 5);
const warmups = readNonNegativeInteger('WARMUPS', 1);
const outputDir = process.env.OUTPUT_DIR ?? '/tmp/grafana-uplot-upstream-benchmark';
const cacheDir = process.env.UPLOT_BENCH_CACHE ?? '/tmp/grafana-uplot-upstream-1.6.32';
const chromiumPath = process.env.CHROMIUM_PATH;
const headless = process.env.HEADLESS !== '0';

for (const fixture of fixtures) {
  if (!allFixtures.includes(fixture)) {
    throw new Error(`Unknown upstream uPlot fixture: ${fixture}`);
  }
}

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(cacheDir, { recursive: true });
const bundlePath = path.join(outputDir, 'uplot-upstream-entry.js');
await esbuild.build({
  entryPoints: [path.resolve('devenv/compact-high-cardinality/uplot-upstream-entry.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  alias: {
    '@grafana/schema': path.resolve('packages/grafana-schema/src/common/common.gen.ts'),
  },
  sourcemap: false,
  minify: false,
});

const packed = fixtures.includes('server-events') ? await loadUpstreamServerEvents() : undefined;
const browser = await chromium.launch({
  executablePath: chromiumPath ?? chromium.executablePath(),
  headless,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const results = [];
try {
  for (const fixture of fixtures) {
    for (let warmup = 1; warmup <= warmups; warmup++) {
      for (const mode of modeOrder(warmup)) {
        await runCase(browser, fixture, mode, 0, packed);
      }
    }
    for (let iteration = 1; iteration <= iterations; iteration++) {
      for (const mode of modeOrder(iteration)) {
        results.push(await runCase(browser, fixture, mode, iteration, packed));
      }
    }
  }
} finally {
  await browser.close();
}

const summary = {
  benchmarkKind: 'uplot-renderer-microbenchmark',
  upstream: {
    repository: 'https://github.com/leeoniya/uPlot',
    version: UPSTREAM_VERSION,
    fixtures,
    dataUrl: fixtures.includes('server-events') ? UPSTREAM_DATA_URL : undefined,
    dataSha256: fixtures.includes('server-events') ? UPSTREAM_DATA_SHA256 : undefined,
  },
  environment: {
    browser: results[0]?.browser,
    iterations,
    warmups,
  },
  results,
  comparisons: compareModes(results),
};
const summaryPath = path.join(outputDir, 'summary.json');
await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.table(
  results.map((result) => ({
    fixture: result.fixture,
    mode: result.mode,
    samples: result.samples,
    'prep ms': result.prepared.prepMs,
    'first paint ms': result.render.firstPaintMs,
    'complete ms': result.render.completeMs,
    'redraw ms': result.redraw.completeMs,
    'zoom ms': result.zoom.completeMs,
    'prepared MB': result.memory.prepared.totalDeltaMB,
    'rendered MB': result.memory.rendered.totalDeltaMB,
  }))
);
console.table(summary.comparisons);
console.log(`Upstream uPlot renderer microbenchmark summary: ${summaryPath}`);

async function runCase(browser, fixture, mode, iteration, packedData) {
  const context = await browser.newContext({ viewport: { width: 2_000, height: 1_000 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ path: bundlePath });

  const baseline = await collectMemory(cdp);
  const prepared = await page.evaluate(
    ({ fixture, mode, packed }) => window.__uplotUpstreamBenchmark.prepare({ fixture, mode, packed }),
    { fixture, mode, packed: fixture === 'server-events' ? packedData : undefined }
  );
  const preparedMemory = await collectMemory(cdp);
  const render = await page.evaluate(() => window.__uplotUpstreamBenchmark.render());
  const renderedMemory = await collectMemory(cdp);
  const redraw = await page.evaluate(() => window.__uplotUpstreamBenchmark.redraw());
  const zoom = await page.evaluate(() => window.__uplotUpstreamBenchmark.zoom());
  await page.evaluate(() => window.__uplotUpstreamBenchmark.destroy());
  const destroyedMemory = await collectMemory(cdp);
  const result = {
    fixture,
    mode,
    iteration,
    browser: await browser.version(),
    samples: prepared.sampleCount,
    prepared,
    render,
    redraw,
    zoom,
    memory: {
      baseline,
      prepared: withDelta(preparedMemory, baseline),
      rendered: withDelta(renderedMemory, baseline),
      destroyed: withDelta(destroyedMemory, baseline),
    },
  };
  await context.close();
  return result;
}

async function collectMemory(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const usage = await cdp.send('Runtime.getHeapUsage');
  return {
    usedHeapMB: mb(usage.usedSize),
    embedderHeapMB: mb(usage.embedderHeapUsedSize),
    backingStorageMB: mb(usage.backingStorageSize),
    totalMB: mb(usage.usedSize + usage.embedderHeapUsedSize + usage.backingStorageSize),
  };
}

function withDelta(current, baseline) {
  return {
    ...current,
    usedHeapDeltaMB: round(current.usedHeapMB - baseline.usedHeapMB),
    embedderHeapDeltaMB: round(current.embedderHeapMB - baseline.embedderHeapMB),
    backingStorageDeltaMB: round(current.backingStorageMB - baseline.backingStorageMB),
    totalDeltaMB: round(current.totalMB - baseline.totalMB),
  };
}

async function loadUpstreamServerEvents() {
  const fixturePath = path.join(cacheDir, 'data.json');
  let bytes;
  try {
    bytes = await fs.readFile(fixturePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
    const response = await fetch(UPSTREAM_DATA_URL);
    if (!response.ok) {
      throw new Error(`Failed to download uPlot benchmark data: ${response.status} ${response.statusText}`);
    }
    bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(fixturePath, bytes);
  }
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== UPSTREAM_DATA_SHA256) {
    throw new Error(`Unexpected uPlot benchmark data checksum: ${digest}`);
  }
  return JSON.parse(bytes.toString('utf8'));
}

function compareModes(allResults) {
  const comparisons = [];
  for (const fixture of fixtures) {
    const legacy = summarize(allResults.filter((result) => result.fixture === fixture && result.mode === 'legacy'));
    const compact = summarize(allResults.filter((result) => result.fixture === fixture && result.mode === 'compact'));
    comparisons.push({
      fixture,
      'first paint median change %': percentChange(compact.firstPaintMs.median, legacy.firstPaintMs.median),
      'complete median change %': percentChange(compact.completeMs.median, legacy.completeMs.median),
      'redraw median change %': percentChange(compact.redrawMs.median, legacy.redrawMs.median),
      'zoom median change %': percentChange(compact.zoomMs.median, legacy.zoomMs.median),
      'prepared memory median change %': percentChange(compact.preparedMB.median, legacy.preparedMB.median),
      'rendered memory median change %': percentChange(compact.renderedMB.median, legacy.renderedMB.median),
      legacy,
      compact,
    });
  }
  return comparisons;
}

function summarize(values) {
  const metric = (selector) => distribution(values.map(selector));
  return {
    firstPaintMs: metric((value) => value.render.firstPaintMs),
    completeMs: metric((value) => value.render.completeMs),
    redrawMs: metric((value) => value.redraw.completeMs),
    zoomMs: metric((value) => value.zoom.completeMs),
    preparedMB: metric((value) => value.memory.prepared.totalDeltaMB),
    renderedMB: metric((value) => value.memory.rendered.totalDeltaMB),
  };
}

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    mean: round(mean),
    median: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
  };
}

function percentile(sorted, quantile) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

function modeOrder(iteration) {
  return iteration % 2 === 0 ? ['compact', 'legacy'] : ['legacy', 'compact'];
}

function percentChange(current, baseline) {
  return round(((current - baseline) / baseline) * 100);
}

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function readNonNegativeInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function mb(bytes) {
  return round(bytes / (1024 * 1024));
}

function round(value) {
  return Math.round(value * 100) / 100;
}
