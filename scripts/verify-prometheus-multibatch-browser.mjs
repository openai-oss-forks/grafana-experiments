#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';

const MULTIBATCH_PATH = '/resources/api/v1/query_range';
const COMPACT_HEADER = 'x-grafana-query-format';
const COMPACT_VERSION = 'compact-v1';
const COMPACT_PAYLOAD_TYPE = 2;
const FINAL_FLAG = 1;
const FRAME_HEADER_SIZE = 12;

const options = parseArgs(process.argv.slice(2));
const browser = await chromium.launch({
  executablePath: options.chromiumPath,
  headless: options.headless,
});
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1800, height: 1100 } });
await context.addInitScript(installMultiBatchProbe, {
  compactHeader: COMPACT_HEADER,
  compactVersion: COMPACT_VERSION,
  finalFlag: FINAL_FLAG,
  forceFeatureToggle: options.enableMultibatchToggle,
  frameHeaderSize: FRAME_HEADER_SIZE,
  multibatchPath: MULTIBATCH_PATH,
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
page.on('console', (message) => {
  if (message.type() === 'error') {
    pageErrors.push(`console: ${message.text()}`);
  }
});

let report;
try {
  await openDashboard(page, options);
  await waitForQueriesToSettle(page, options.timeoutMs);
  await scrollDashboard(page, options.timeoutMs);
  await waitForQueriesToSettle(page, options.timeoutMs);
  await page.waitForFunction(
    () => {
      const records = globalThis.__prometheusMultiBatchProbe ?? [];
      return records.length > 0 && records.every((record) => record.done);
    },
    undefined,
    { timeout: options.timeoutMs }
  );

  const streams = await page.evaluate(() => globalThis.__prometheusMultiBatchProbe ?? []);
  report = validateReport({ options, pageErrors, streams, url: page.url() });
  await writeReport(options.output, report);
  console.log(`PASS ${options.name}: ${streams.length} Prometheus multibatch stream(s)`);
} catch (error) {
  const streams = await page.evaluate(() => globalThis.__prometheusMultiBatchProbe ?? []).catch(() => []);
  report = {
    error: error instanceof Error ? error.message : String(error),
    name: options.name,
    pageErrors,
    streams,
    url: page.url(),
  };
  await writeReport(options.output, report);
  console.error(`FAIL ${options.name}: ${report.error}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}

function parseArgs(argv) {
  const parsed = {
    headless: true,
    name: 'dashboard',
    output: '/tmp/prometheus-multibatch-browser-report.json',
    password: process.env.GRAFANA_PASSWORD ?? 'admin',
    enableMultibatchToggle: false,
    expectedUpstream: undefined,
    forbidCacheStatus: false,
    requireCompactRequest: false,
    requireCacheStatus: false,
    requirePartialBeforeFinal: false,
    timeoutMs: 120_000,
    username: process.env.GRAFANA_USER ?? 'admin',
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];
    switch (arg) {
      case '--url':
        parsed.url = value;
        index++;
        break;
      case '--name':
        parsed.name = value;
        index++;
        break;
      case '--output':
        parsed.output = value;
        index++;
        break;
      case '--username':
        parsed.username = value;
        index++;
        break;
      case '--password':
        parsed.password = value;
        index++;
        break;
      case '--timeout-ms':
        parsed.timeoutMs = Number(value);
        index++;
        break;
      case '--chromium-path':
        parsed.chromiumPath = value;
        index++;
        break;
      case '--headed':
        parsed.headless = false;
        break;
      case '--require-cache-status':
        parsed.requireCacheStatus = true;
        break;
      case '--forbid-cache-status':
        parsed.forbidCacheStatus = true;
        break;
      case '--enable-multibatch-toggle':
        parsed.enableMultibatchToggle = true;
        break;
      case '--expected-upstream':
        parsed.expectedUpstream = value;
        index++;
        break;
      case '--require-compact-request':
        parsed.requireCompactRequest = true;
        break;
      case '--require-partial-before-final':
        parsed.requirePartialBeforeFinal = true;
        break;
      case '--help':
      case '-h':
        usage(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!parsed.url) {
    usage(1);
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }
  return parsed;
}

function usage(exitCode) {
  console.error(`Usage: node scripts/verify-prometheus-multibatch-browser.mjs --url URL [options]

Options:
  --name NAME                         Report label
  --output PATH                       JSON report path
  --username USER --password PASS    Local Grafana credentials
  --require-cache-status             Require x-trickster-result on every stream
  --forbid-cache-status              Require x-trickster-result to be absent
  --enable-multibatch-toggle         Enable the local frontend feature toggle before boot
  --expected-upstream NAME           Require the test upstream routing evidence header
  --require-compact-request          Require at least one completed compact-v1 browser request
  --require-partial-before-final     Require a complete non-final frame before the final frame header
  --timeout-ms N                      Navigation/query timeout (default 120000)
  --headed                            Run Chromium visibly
  --chromium-path PATH                Override Chromium executable`);
  process.exit(exitCode);
}

async function openDashboard(page, runOptions) {
  await page.goto(runOptions.url, { waitUntil: 'domcontentloaded', timeout: runOptions.timeoutMs });
  if (new URL(page.url()).pathname.startsWith('/login')) {
    const loginResponse = await page.request.post(new URL('/login', runOptions.url).toString(), {
      data: { password: runOptions.password, user: runOptions.username },
    });
    if (!loginResponse.ok()) {
      throw new Error(`local Grafana login failed: HTTP ${loginResponse.status()}`);
    }
    await page.goto(runOptions.url, { waitUntil: 'domcontentloaded', timeout: runOptions.timeoutMs });
  }
}

async function waitForQueriesToSettle(page, timeoutMs) {
  await page.waitForFunction(
    () => {
      const records = globalThis.__prometheusMultiBatchProbe ?? [];
      return records.length > 0 && records.every((record) => record.done);
    },
    undefined,
    { timeout: timeoutMs }
  );
}

async function scrollDashboard(page, timeoutMs) {
  let previousHeight = -1;
  let previousScrollTop = -1;
  for (let step = 0; step < 400; step++) {
    const position = await page.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      scrollTop: window.scrollY,
      viewport: window.innerHeight,
    }));
    const nextTop = Math.min(position.scrollTop + Math.max(position.viewport - 100, 100), position.height);
    await page.evaluate((scrollTop) => window.scrollTo(0, scrollTop), nextTop);
    await page.waitForTimeout(150);
    await waitForQueriesToSettle(page, timeoutMs);
    const current = await page.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      scrollTop: window.scrollY,
    }));
    if (
      current.scrollTop === previousScrollTop &&
      current.height === previousHeight &&
      current.scrollTop + position.viewport >= current.height - 1
    ) {
      return;
    }
    previousHeight = current.height;
    previousScrollTop = current.scrollTop;
  }
  throw new Error(`dashboard did not reach a stable scroll height within ${timeoutMs}ms`);
}

function validateReport({ options: runOptions, pageErrors, streams, url }) {
  const failures = [...pageErrors];
  const completedStreams = streams.filter((stream) => !stream.cancelled);
  if (completedStreams.length === 0) {
    failures.push('dashboard issued no Prometheus multibatch stream requests');
  }
  if (runOptions.requireCompactRequest && !completedStreams.some((stream) => stream.compactRequested)) {
    failures.push('dashboard issued no completed compact-v1 Prometheus multibatch request');
  }
  for (const [index, stream] of completedStreams.entries()) {
    const label = `stream ${index + 1}`;
    if (stream.error) {
      failures.push(`${label}: ${stream.error}`);
    }
    if (!stream.isMultiBatchContentType) {
      failures.push(`${label}: response content type was not multibatch`);
    }
    if (!stream.sawFinal) {
      failures.push(`${label}: response ended without a final frame`);
    }
    if (stream.compactRequested && stream.payloadTypes.some((type) => type !== COMPACT_PAYLOAD_TYPE)) {
      failures.push(
        `${label}: compact-v1 request returned non-compact payload type(s) ${stream.payloadTypes.join(',')}`
      );
    }
    if (runOptions.requireCacheStatus && !stream.cacheStatus) {
      failures.push(`${label}: response did not report x-trickster-result`);
    }
    if (runOptions.forbidCacheStatus && stream.cacheStatus) {
      failures.push(`${label}: response unexpectedly reported x-trickster-result=${stream.cacheStatus}`);
    }
    if (runOptions.expectedUpstream && stream.upstream !== runOptions.expectedUpstream) {
      failures.push(
        label + ': expected upstream ' + runOptions.expectedUpstream + ', received ' + (stream.upstream ?? 'none')
      );
    }
    if (
      runOptions.requirePartialBeforeFinal &&
      (stream.firstNonFinalCompleteAt == null ||
        stream.finalHeaderAt == null ||
        stream.firstNonFinalCompleteAt >= stream.finalHeaderAt)
    ) {
      failures.push(`${label}: browser did not receive a complete non-final frame before the final frame header`);
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join('\n'));
  }
  return {
    name: runOptions.name,
    pageErrors,
    streams,
    url,
  };
}

async function writeReport(output, report) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}

function installMultiBatchProbe({
  compactHeader,
  compactVersion,
  finalFlag,
  forceFeatureToggle,
  frameHeaderSize,
  multibatchPath,
}) {
  if (forceFeatureToggle) {
    let bootData;
    Object.defineProperty(globalThis, 'grafanaBootData', {
      configurable: true,
      get: () => bootData,
      set: (value) => {
        value.settings ??= {};
        value.settings.featureToggles ??= {};
        value.settings.featureToggles.prometheusMultiBatchStreaming = true;
        bootData = value;
      },
    });
  }
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.__prometheusMultiBatchProbe = [];
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const requestUrl = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? String(args[0]));
    if (!requestUrl.includes(multibatchPath)) {
      return response;
    }

    const requestHeaders = new Headers(
      args[1]?.headers ?? (typeof args[0] === 'object' && args[0] !== null ? args[0].headers : undefined)
    );
    const contentType = response.headers.get('content-type') ?? '';
    const record = {
      cacheStatus: response.headers.get('x-trickster-result'),
      cancelled: false,
      compactRequested: requestHeaders.get(compactHeader) === compactVersion,
      done: false,
      error: undefined,
      finalHeaderAt: undefined,
      firstNonFinalCompleteAt: undefined,
      isMultiBatchContentType:
        contentType.toLowerCase().includes('application/prometheus.multibatch') ||
        contentType.toLowerCase().includes('application/com.openai.prometheus.multibatch'),
      payloadTypes: [],
      responseContentType: contentType,
      sawFinal: false,
      status: response.status,
      upstream: response.headers.get('x-fake-upstream'),
      url: requestUrl,
    };
    globalThis.__prometheusMultiBatchProbe.push(record);

    const clone = response.clone();
    void observeStream(clone, record);
    return response;
  };

  async function observeStream(response, record) {
    if (!response.body) {
      record.error = 'response did not include a readable body';
      record.done = true;
      return;
    }
    const reader = response.body.getReader();
    let buffer = new Uint8Array();
    let sawHeader = false;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        buffer = concat(buffer, result.value);
        while (buffer.byteLength >= frameHeaderSize) {
          const magic = ascii(buffer.subarray(0, 4));
          if (magic === 'MBRH') {
            sawHeader = true;
            buffer = buffer.subarray(frameHeaderSize);
            continue;
          }
          if (magic !== 'MBBF') {
            throw new Error(`invalid frame magic ${magic}`);
          }
          if (!sawHeader) {
            throw new Error('batch arrived before response header');
          }
          const payloadLength = new DataView(buffer.buffer, buffer.byteOffset + 8, 4).getUint32(0, false);
          const frameLength = frameHeaderSize + payloadLength;
          const flags = buffer[6];
          const isFinal = (flags & finalFlag) !== 0;
          if (isFinal) {
            record.finalHeaderAt ??= performance.now();
          }
          if (buffer.byteLength < frameLength) {
            break;
          }
          const payloadType = buffer[5];
          record.payloadTypes.push(payloadType);
          if (isFinal) {
            record.sawFinal = true;
          } else {
            record.firstNonFinalCompleteAt ??= performance.now();
          }
          buffer = buffer.subarray(frameLength);
        }
      }
      if (buffer.byteLength > 0) {
        throw new Error('response ended with a truncated frame');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/aborted/i.test(message)) {
        record.cancelled = true;
      } else {
        record.error = message;
      }
    } finally {
      reader.releaseLock();
      record.done = true;
    }
  }

  function ascii(bytes) {
    return String.fromCharCode(...bytes);
  }

  function concat(left, right) {
    const result = new Uint8Array(left.byteLength + right.byteLength);
    result.set(left);
    result.set(right, left.byteLength);
    return result;
  }
}
