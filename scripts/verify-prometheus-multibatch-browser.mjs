#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';

const MULTIBATCH_CONTENT_TYPES = ['application/com.openai.prometheus.multibatch', 'application/prometheus.multibatch'];
const MULTIBATCH_PATH = '/resources/api/v1/query_range';
const QUERY_DATA_PATH = '/api/ds/query';
const COMPACT_HEADER = 'x-grafana-query-format';
const COMPACT_VERSION = 'compact-v1';
const QUERY_DATA_COMPACT_MEDIA_TYPE = 'application/vnd.grafana.querydata.compact;version=1';
const JSON_FALLBACK_PAYLOAD_TYPE = 1;
const COMPACT_PAYLOAD_TYPE = 2;
const FINAL_FLAG = 1;
const FRAME_HEADER_SIZE = 12;

const options = parseArgs(process.argv.slice(2));
const browser = await chromium.launch({
  executablePath: options.chromiumPath,
  headless: options.headless,
});
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1800, height: 1100 } });
if (options.multibatchToggle !== undefined) {
  await context.addInitScript(installFeatureToggleOverride, { enabled: options.multibatchToggle });
}
await context.addInitScript(installResourceResponseProbe, { multibatchPath: MULTIBATCH_PATH });
const page = await context.newPage();
const pageErrors = [];
const ignoredConsoleErrors = [];
const queryResponses = [];
const pendingObservations = new Set();

page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
page.on('console', (message) => {
  if (message.type() === 'error') {
    const text = message.text();
    if (isBenignConsoleNoise(text)) {
      ignoredConsoleErrors.push(text);
    } else {
      pageErrors.push(`console: ${text}`);
    }
  }
});
page.on('response', (response) => {
  // CDP cannot reliably retrieve a streamed response body after the browser
  // consumes it. Resource streams are cloned by the in-page fetch probe below;
  // ordinary /api/ds/query responses remain visible through Playwright.
  if (!isDataSourceQueryURL(response.url())) {
    return;
  }
  const observation = observeQueryResponse(response)
    .then((record) => queryResponses.push(record))
    .catch((error) => {
      queryResponses.push({
        error: error instanceof Error ? error.message : String(error),
        requestURL: response.url(),
        status: response.status(),
      });
    })
    .finally(() => pendingObservations.delete(observation));
  pendingObservations.add(observation);
});

let report;
try {
  await openDashboard(page, options);
  await waitForQueryResponses(page, queryResponses, pendingObservations, options.timeoutMs);
  await waitForTimeseriesCanvas(page, options.timeoutMs);
  await waitForQueryResponses(page, queryResponses, pendingObservations, options.timeoutMs);
  queryResponses.push(...(await collectResourceProbeResponses(page)));
  const panelState = await inspectPanelState(page);
  report = validateReport({ ignoredConsoleErrors, options, pageErrors, panelState, queryResponses, url: page.url() });
  await maybeScreenshot(page, options.screenshot);
  await writeReport(options.output, report);
  console.log(`PASS ${options.name}: ${queryResponses.length} browser query response(s)`);
} catch (error) {
  const panelState = await inspectPanelState(page).catch(() => ({
    panelErrors: [],
    regressionMessages: [],
    visibleCanvasCount: 0,
  }));
  report = {
    error: error instanceof Error ? error.message : String(error),
    ignoredConsoleErrors,
    name: options.name,
    pageErrors,
    panelState,
    queryResponses,
    url: page.url(),
  };
  await maybeScreenshot(page, options.screenshot).catch(() => undefined);
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
      case '--screenshot':
        parsed.screenshot = value;
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
      case '--multibatch-toggle':
        parsed.multibatchToggle = parseOnOff(value, '--multibatch-toggle');
        index++;
        break;
      case '--enable-multibatch-toggle':
        parsed.multibatchToggle = true;
        break;
      case '--disable-multibatch-toggle':
        parsed.multibatchToggle = false;
        break;
      case '--expect-request-multibatch':
        parsed.expectRequestMultibatch = parseBoolean(value, '--expect-request-multibatch');
        index++;
        break;
      case '--expect-request-compact':
        parsed.expectRequestCompact = parseBoolean(value, '--expect-request-compact');
        index++;
        break;
      case '--expected-response':
        parsed.expectedResponse = value;
        index++;
        break;
      case '--require-compact-request':
        parsed.expectRequestCompact = true;
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
  if (
    parsed.expectedResponse !== undefined &&
    ![
      'top-level-json',
      'top-level-compact',
      'top-level-querydata-json',
      'mb-type1',
      'mb-type1-querydata',
      'mb-type2',
    ].includes(parsed.expectedResponse)
  ) {
    throw new Error(`Unknown --expected-response value: ${parsed.expectedResponse}`);
  }
  return parsed;
}

function parseBoolean(value, flag) {
  if (value === 'true' || value === 'yes' || value === 'on') {
    return true;
  }
  if (value === 'false' || value === 'no' || value === 'off') {
    return false;
  }
  throw new Error(`${flag} must be true or false`);
}

function parseOnOff(value, flag) {
  if (value === 'on') {
    return true;
  }
  if (value === 'off') {
    return false;
  }
  throw new Error(`${flag} must be on or off`);
}

function usage(exitCode) {
  console.error(`Usage: node scripts/verify-prometheus-multibatch-browser.mjs --url URL [options]

Options:
  --name NAME                         Report label
  --output PATH                       JSON report path
  --screenshot PATH                   Optional full-page screenshot
  --username USER --password PASS    Local Grafana credentials
  --multibatch-toggle on|off         Force the frontend feature toggle before boot
  --expect-request-multibatch BOOL   Assert browser Accept includes/omits multibatch
  --expect-request-compact BOOL      Assert browser compact-v1 header is present/absent
  --expected-response KIND           top-level-json, top-level-compact,
                                     top-level-querydata-json, mb-type1,
                                     mb-type1-querydata, or mb-type2
  --timeout-ms N                      Navigation/query timeout (default 120000)
  --headed                           Run Chromium visibly (headless is default)
  --chromium-path PATH               Override Chromium executable`);
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

async function waitForQueryResponses(page, records, pending, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let quietSince;
  while (Date.now() < deadline) {
    const resourceProbe = await page.evaluate(() => {
      const records = globalThis.__prometheusResourceResponseProbe ?? [];
      return { count: records.length, done: records.every((record) => record.done) };
    });
    if ((records.length > 0 || resourceProbe.count > 0) && pending.size === 0 && resourceProbe.done) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= 250) {
        return;
      }
    } else {
      quietSince = undefined;
    }
    await page.waitForTimeout(50);
  }
  throw new Error(
    `browser query responses did not settle within ${timeoutMs}ms (records=${records.length}, pending=${pending.size})`
  );
}

async function collectResourceProbeResponses(page) {
  const records = await page.evaluate(() => globalThis.__prometheusResourceResponseProbe ?? []);
  return records.map((record) => {
    if (record.error) {
      return {
        error: record.error,
        requestURL: record.requestURL,
        status: record.status,
      };
    }
    return buildQueryResponseRecord({
      body: new Uint8Array(record.bodyBytes),
      method: record.method,
      requestHeaders: record.requestHeaders,
      requestURL: record.requestURL,
      responseContentType: record.responseHeaders['content-type'] ?? '',
      status: record.status,
    });
  });
}

async function waitForTimeseriesCanvas(page, timeoutMs) {
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('canvas')).some((canvas) => {
        const bounds = canvas.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      }),
    undefined,
    { timeout: timeoutMs }
  );
}

async function inspectPanelState(page) {
  return page.evaluate(() => {
    const visibleCanvasCount = Array.from(document.querySelectorAll('canvas')).filter((canvas) => {
      const bounds = canvas.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    }).length;
    const panelErrors = Array.from(
      document.querySelectorAll(
        '[data-testid="panel-error"], [data-testid*="panel error" i], [aria-label*="panel error" i], .panel-error, .panel-error-container'
      )
    )
      .map((element) => element.textContent?.trim() ?? '')
      .filter(Boolean);
    const bodyText = document.body?.innerText ?? '';
    const regressionPatterns = [
      /Prometheus multi-batch compact-v1 response returned non-compact payload/i,
      /Expected application\.vnd\.grafana\.querydata\.compact;version=1 or application\/json fallback response/i,
      /query response does not satisfy compact-v1/i,
    ];
    const regressionMessages = regressionPatterns
      .filter((pattern) => pattern.test(bodyText))
      .map((pattern) => pattern.source);
    return { panelErrors, regressionMessages, visibleCanvasCount };
  });
}

function validateReport({ ignoredConsoleErrors, options: runOptions, pageErrors, panelState, queryResponses, url }) {
  const failures = [...pageErrors];
  if (queryResponses.length === 0) {
    failures.push('dashboard issued no browser Prometheus query requests');
  }
  if (panelState.visibleCanvasCount < 1) {
    failures.push('dashboard rendered no visible timeseries canvas');
  }
  for (const error of panelState.panelErrors) {
    failures.push(`panel error: ${error}`);
  }
  for (const message of panelState.regressionMessages) {
    failures.push(`regression error rendered in page: ${message}`);
  }

  for (const [index, record] of queryResponses.entries()) {
    const label = `query response ${index + 1}`;
    if (record.error) {
      failures.push(`${label}: ${record.error}`);
      continue;
    }
    if (record.status < 200 || record.status >= 300) {
      failures.push(`${label}: HTTP ${record.status}`);
    }
    if (
      runOptions.expectRequestMultibatch !== undefined &&
      record.requestAcceptsMultibatch !== runOptions.expectRequestMultibatch
    ) {
      failures.push(
        `${label}: expected browser multibatch Accept=${runOptions.expectRequestMultibatch}, received ${record.requestAcceptsMultibatch}`
      );
    }
    if (runOptions.expectRequestCompact !== undefined && record.compactRequested !== runOptions.expectRequestCompact) {
      failures.push(
        `${label}: expected browser compact-v1 header=${runOptions.expectRequestCompact}, received ${record.compactRequested}`
      );
    }
    if (runOptions.expectRequestMultibatch === true && !record.isResourceQuery) {
      failures.push(`${label}: multibatch browser request did not use the resource query path`);
    }
    if (runOptions.expectRequestMultibatch === false && !record.isDataSourceQuery) {
      failures.push(`${label}: non-multibatch browser request did not use /api/ds/query`);
    }
    validateExpectedResponse(record, runOptions.expectedResponse, label, failures);
  }

  if (failures.length > 0) {
    throw new Error(failures.join('\n'));
  }
  return {
    ignoredConsoleErrors,
    name: runOptions.name,
    pageErrors,
    panelState,
    queryResponses,
    url,
  };
}

function isBenignConsoleNoise(message) {
  return (
    /Failed to load resource: the server responded with a status of 404/i.test(message) ||
    /favicon\.ico/i.test(message) ||
    /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i.test(message)
  );
}

function validateExpectedResponse(record, expectedResponse, label, failures) {
  if (!expectedResponse) {
    return;
  }
  const contentType = record.responseContentType.toLowerCase();
  if (expectedResponse === 'top-level-json' || expectedResponse === 'top-level-querydata-json') {
    if (record.isMultibatchContentType) {
      failures.push(`${label}: expected top-level JSON, received multibatch`);
    }
    if (!contentType.startsWith('application/json')) {
      failures.push(`${label}: expected application/json, received ${record.responseContentType || 'none'}`);
    }
    if (!record.topLevelJson?.valid) {
      failures.push(`${label}: top-level JSON response did not parse`);
    }
    if (expectedResponse === 'top-level-querydata-json' && !record.topLevelJson?.hasResults) {
      failures.push(`${label}: compact fallback was not QueryData JSON with results`);
    }
    return;
  }
  if (expectedResponse === 'top-level-compact') {
    if (record.isMultibatchContentType) {
      failures.push(`${label}: expected top-level compact, received multibatch`);
    }
    if (!contentType.startsWith(QUERY_DATA_COMPACT_MEDIA_TYPE)) {
      failures.push(
        `${label}: expected ${QUERY_DATA_COMPACT_MEDIA_TYPE}, received ${record.responseContentType || 'none'}`
      );
    }
    if (!record.bodyStartsGQD1) {
      failures.push(`${label}: top-level compact payload did not begin GQD1`);
    }
    return;
  }

  if (!record.isMultibatchContentType) {
    failures.push(`${label}: expected multibatch response, received ${record.responseContentType || 'none'}`);
    return;
  }
  if (!record.sawResponseHeader) {
    failures.push(`${label}: multibatch response did not begin with MBRH`);
  }
  if (!record.sawFinal) {
    failures.push(`${label}: multibatch response ended without a final frame`);
  }
  if (record.frames.length === 0) {
    failures.push(`${label}: multibatch response contained no frames`);
    return;
  }

  const expectedPayloadType = expectedResponse === 'mb-type2' ? COMPACT_PAYLOAD_TYPE : JSON_FALLBACK_PAYLOAD_TYPE;
  if (record.frames.some((frame) => frame.payloadType !== expectedPayloadType)) {
    failures.push(
      `${label}: expected only payload type ${expectedPayloadType}, received ${record.frames
        .map((frame) => frame.payloadType)
        .join(',')}`
    );
  }
  if (expectedResponse === 'mb-type2' && record.frames.some((frame) => !frame.payloadStartsGQD1)) {
    failures.push(`${label}: compact multibatch payload did not begin GQD1`);
  }
  if (expectedResponse === 'mb-type1-querydata' && !record.frames.some((frame) => frame.queryDataJson?.hasResults)) {
    failures.push(`${label}: compact fallback type-1 payload was not QueryData JSON with results`);
  }
}

async function observeQueryResponse(response) {
  const request = response.request();
  const requestHeaders = normalizeHeaders(await request.allHeaders());
  const responseHeaders = normalizeHeaders(await response.allHeaders());
  const body = new Uint8Array(await response.body());
  return buildQueryResponseRecord({
    body,
    method: request.method(),
    requestHeaders,
    requestURL: response.url(),
    responseContentType: responseHeaders['content-type'] ?? '',
    status: response.status(),
  });
}

function buildQueryResponseRecord({ body, method, requestHeaders, requestURL, responseContentType, status }) {
  const record = {
    bodyByteLength: body.byteLength,
    bodyPrefix: prefix(body),
    bodyStartsGQD1: startsWithASCII(body, 'GQD1'),
    compactRequested: requestHeaders[COMPACT_HEADER] === COMPACT_VERSION,
    isDataSourceQuery: isDataSourceQueryURL(requestURL),
    isMultibatchContentType: isMultibatchContentType(responseContentType),
    isResourceQuery: isResourceQueryURL(requestURL),
    method,
    requestAccept: requestHeaders.accept ?? '',
    requestAcceptsMultibatch: isMultibatchAccept(requestHeaders.accept ?? ''),
    requestCompactHeader: requestHeaders[COMPACT_HEADER],
    requestURL,
    responseContentType,
    status,
  };
  if (record.isMultibatchContentType) {
    Object.assign(record, parseMultibatch(body));
  } else {
    record.topLevelJson = parseJsonPayload(body);
  }
  return record;
}

function parseMultibatch(body) {
  const frames = [];
  let offset = 0;
  let sawResponseHeader = false;
  let sawFinal = false;
  while (offset < body.byteLength) {
    if (body.byteLength - offset < FRAME_HEADER_SIZE) {
      throw new Error('multibatch response ended with a truncated header');
    }
    const magic = ascii(body.subarray(offset, offset + 4));
    if (magic === 'MBRH') {
      if (sawResponseHeader || offset !== 0) {
        throw new Error('multibatch response contained an unexpected MBRH');
      }
      sawResponseHeader = true;
      offset += FRAME_HEADER_SIZE;
      continue;
    }
    if (magic !== 'MBBF') {
      throw new Error(`invalid multibatch frame magic ${magic}`);
    }
    if (!sawResponseHeader) {
      throw new Error('multibatch frame arrived before response header');
    }
    const header = body.subarray(offset, offset + FRAME_HEADER_SIZE);
    const payloadLength = new DataView(header.buffer, header.byteOffset + 8, 4).getUint32(0, false);
    const frameLength = FRAME_HEADER_SIZE + payloadLength;
    if (body.byteLength - offset < frameLength) {
      throw new Error('multibatch response ended with a truncated frame');
    }
    const payload = body.subarray(offset + FRAME_HEADER_SIZE, offset + frameLength);
    const flags = header[6];
    const isFinal = (flags & FINAL_FLAG) !== 0;
    sawFinal ||= isFinal;
    frames.push({
      compression: header[7],
      flags,
      isFinal,
      payloadByteLength: payload.byteLength,
      payloadPrefix: prefix(payload),
      payloadStartsGQD1: startsWithASCII(payload, 'GQD1'),
      payloadType: header[5],
      queryDataJson: parseJsonPayload(payload),
    });
    offset += frameLength;
  }
  return { frames, sawFinal, sawResponseHeader };
}

function parseJsonPayload(bytes) {
  const text = new TextDecoder().decode(bytes).trim();
  if (!text.startsWith('{')) {
    return { hasResults: false, valid: false };
  }
  try {
    const value = JSON.parse(text);
    return {
      hasResults: typeof value === 'object' && value !== null && 'results' in value,
      valid: true,
    };
  } catch {
    return { hasResults: false, valid: false };
  }
}

function isResourceQueryURL(rawURL) {
  return new URL(rawURL).pathname.includes(MULTIBATCH_PATH);
}

function isDataSourceQueryURL(rawURL) {
  return new URL(rawURL).pathname.endsWith(QUERY_DATA_PATH);
}

function isMultibatchAccept(accept) {
  const normalized = accept.toLowerCase();
  return MULTIBATCH_CONTENT_TYPES.some((contentType) => normalized.includes(contentType));
}

function isMultibatchContentType(contentType) {
  const normalized = contentType.toLowerCase();
  return MULTIBATCH_CONTENT_TYPES.some((type) => normalized.includes(type));
}

function normalizeHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

function startsWithASCII(bytes, expected) {
  return ascii(bytes.subarray(0, expected.length)) === expected;
}

function ascii(bytes) {
  return String.fromCharCode(...bytes);
}

function prefix(bytes) {
  return ascii(bytes.subarray(0, Math.min(bytes.byteLength, 16))).replace(/[^\x20-\x7e]/g, '.');
}

async function maybeScreenshot(page, screenshot) {
  if (!screenshot) {
    return;
  }
  await fs.mkdir(path.dirname(screenshot), { recursive: true });
  await page.screenshot({ fullPage: true, path: screenshot });
}

async function writeReport(output, report) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}

function installFeatureToggleOverride({ enabled }) {
  let bootData;
  Object.defineProperty(globalThis, 'grafanaBootData', {
    configurable: true,
    get: () => bootData,
    set: (value) => {
      value.settings ??= {};
      value.settings.featureToggles ??= {};
      value.settings.featureToggles.prometheusMultiBatchStreaming = enabled;
      bootData = value;
    },
  });
}

function installResourceResponseProbe({ multibatchPath }) {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.__prometheusResourceResponseProbe = [];
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const requestInput = args[0];
    const requestURL =
      typeof requestInput === 'string'
        ? new URL(requestInput, globalThis.location.href).href
        : new URL(requestInput?.url ?? String(requestInput), globalThis.location.href).href;
    if (!new URL(requestURL).pathname.includes(multibatchPath)) {
      return response;
    }

    const requestHeaders = Object.fromEntries(
      new Headers(
        args[1]?.headers ??
          (typeof requestInput === 'object' && requestInput !== null ? requestInput.headers : undefined)
      ).entries()
    );
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const record = {
      bodyBytes: [],
      done: false,
      error: undefined,
      method: args[1]?.method ?? requestInput?.method ?? 'GET',
      requestHeaders,
      requestURL,
      responseHeaders,
      status: response.status,
    };
    globalThis.__prometheusResourceResponseProbe.push(record);
    const clone = response.clone();
    try {
      // Drain the clone before handing the original response back. The
      // datasource aborts its fetch signal as soon as it is done rendering;
      // waiting here keeps that cleanup from racing the evidence reader.
      const body = await clone.arrayBuffer();
      record.bodyBytes = Array.from(new Uint8Array(body));
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
    } finally {
      record.done = true;
    }
    return response;
  };
}
