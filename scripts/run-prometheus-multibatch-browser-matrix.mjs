#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const matrix = [
  {
    dataShape: 'eligible',
    expectedResponse: 'top-level-json',
    id: 'nonmb-no-compact-plain-eligible',
    requestCompact: false,
    requestMultibatch: false,
    upstreamFormat: 'plain',
  },
  {
    dataShape: 'eligible',
    expectedResponse: 'top-level-compact',
    id: 'nonmb-compact-plain-eligible',
    requestCompact: true,
    requestMultibatch: false,
    upstreamFormat: 'plain',
  },
  {
    dataShape: 'ineligible',
    expectedResponse: 'top-level-querydata-json',
    id: 'nonmb-compact-plain-ineligible',
    requestCompact: true,
    requestMultibatch: false,
    upstreamFormat: 'plain',
  },
  {
    dataShape: 'eligible',
    expectedResponse: 'mb-type1',
    id: 'mb-no-compact-plain-eligible',
    requestCompact: false,
    requestMultibatch: true,
    upstreamFormat: 'plain',
  },
  {
    dataShape: 'eligible',
    expectedResponse: 'mb-type1',
    id: 'mb-no-compact-multibatch-eligible',
    requestCompact: false,
    requestMultibatch: true,
    upstreamFormat: 'multibatch',
  },
  {
    dataShape: 'eligible',
    expectedResponse: 'mb-type2',
    id: 'mb-compact-plain-eligible',
    requestCompact: true,
    requestMultibatch: true,
    upstreamFormat: 'plain',
  },
  {
    dataShape: 'eligible',
    expectedResponse: 'mb-type2',
    id: 'mb-compact-multibatch-eligible',
    requestCompact: true,
    requestMultibatch: true,
    upstreamFormat: 'multibatch',
  },
  {
    dataShape: 'ineligible',
    expectedResponse: 'mb-type1-querydata',
    id: 'mb-compact-plain-ineligible',
    requestCompact: true,
    requestMultibatch: true,
    upstreamFormat: 'plain',
  },
  {
    dataShape: 'ineligible',
    expectedResponse: 'mb-type1-querydata',
    id: 'mb-compact-multibatch-ineligible',
    requestCompact: true,
    requestMultibatch: true,
    upstreamFormat: 'multibatch',
  },
];

const options = parseArgs(process.argv.slice(2));
const auth = 'Basic ' + Buffer.from(options.username + ':' + options.password).toString('base64');

await fs.mkdir(options.outputDir, { recursive: true });
await configureDatasource();

const results = [];
for (const [index, testCase] of matrix.entries()) {
  const dashboard = buildDashboard(testCase, index);
  await importDashboard(dashboard);
  await resetFakeRequests();
  await setFakeMode(testCase);

  const report = path.join(options.outputDir, `${testCase.id}.json`);
  const screenshot = path.join(options.outputDir, `${testCase.id}.png`);
  const verifierArgs = [
    options.verifyScript,
    '--url',
    dashboardURL(dashboard),
    '--name',
    testCase.id,
    '--output',
    report,
    '--screenshot',
    screenshot,
    '--username',
    options.username,
    '--password',
    options.password,
    '--multibatch-toggle',
    testCase.requestMultibatch ? 'on' : 'off',
    '--expect-request-multibatch',
    String(testCase.requestMultibatch),
    '--expect-request-compact',
    String(testCase.requestCompact),
    '--expected-response',
    testCase.expectedResponse,
    '--timeout-ms',
    String(options.timeoutMs),
  ];
  if (options.chromiumPath) {
    verifierArgs.push('--chromium-path', options.chromiumPath);
  }

  let exitCode = await run(process.execPath, verifierArgs);
  let fakeUpstream;
  let fakeEvidenceError;
  try {
    fakeUpstream = await validateFakeUpstreamEvidence(testCase);
  } catch (error) {
    fakeEvidenceError = error instanceof Error ? error.message : String(error);
    exitCode = 1;
  }
  await augmentReport(report, { fakeEvidenceError, fakeUpstream, matrixCase: testCase });

  results.push({
    exitCode,
    fakeEvidenceError,
    id: testCase.id,
    report,
    screenshot,
  });
  await writeIndex(results);
  if (exitCode !== 0 && options.failFast) {
    process.exit(exitCode);
  }
}

if (results.some((result) => result.exitCode !== 0)) {
  process.exitCode = 1;
} else {
  console.log(`PASS matrix: ${results.length} browser run(s)`);
}

function parseArgs(argv) {
  const parsed = {
    datasourceUID: 'PROMETHEUS_BROWSER_MATRIX',
    fakeControlURL: 'http://127.0.0.1:19090',
    failFast: false,
    grafanaURL: 'http://127.0.0.1:3000',
    outputDir: '/tmp/prometheus-multibatch-browser-matrix',
    password: process.env.GRAFANA_PASSWORD ?? 'admin',
    timeoutMs: 240_000,
    upstreamURL: 'http://127.0.0.1:19090',
    username: process.env.GRAFANA_USER ?? 'admin',
    verifyScript: path.resolve('scripts/verify-prometheus-multibatch-browser.mjs'),
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];
    switch (arg) {
      case '--datasource-uid':
        parsed.datasourceUID = value;
        index++;
        break;
      case '--fake-control-url':
        parsed.fakeControlURL = value;
        index++;
        break;
      case '--grafana-url':
        parsed.grafanaURL = value;
        index++;
        break;
      case '--upstream-url':
        parsed.upstreamURL = value;
        index++;
        break;
      case '--output-dir':
        parsed.outputDir = value;
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
      case '--verify-script':
        parsed.verifyScript = path.resolve(value);
        index++;
        break;
      case '--fail-fast':
        parsed.failFast = true;
        break;
      case '--keep-going':
        parsed.failFast = false;
        break;
      case '--help':
      case '-h':
        usage(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }
  return parsed;
}

function usage(exitCode) {
  console.error(
    'Usage: node scripts/run-prometheus-multibatch-browser-matrix.mjs [options]\n\n' +
      'Runs the nine browser → Grafana/Oscope → fake-upstream protocol cases.\n' +
      'Options: --grafana-url URL --upstream-url URL --fake-control-url URL --output-dir PATH\n' +
      '         --datasource-uid UID --chromium-path PATH --timeout-ms N --fail-fast'
  );
  process.exit(exitCode);
}

function buildDashboard(testCase, index) {
  const uid = `prom-mb-browser-${index + 1}`;
  const panelOptions = {
    legend: {
      calcs: [],
      displayMode: 'list',
      placement: 'bottom',
      showLegend: true,
    },
    tooltip: {
      mode: 'single',
      sort: 'none',
    },
  };
  if (!testCase.requestCompact) {
    // Vertical timeseries is renderable but intentionally outside compact-v1's panel policy.
    panelOptions.orientation = 'vertical';
  }
  return {
    annotations: { list: [] },
    editable: true,
    fiscalYearStartMonth: 0,
    graphTooltip: 0,
    id: null,
    panels: [
      {
        datasource: { type: 'prometheus', uid: options.datasourceUID },
        fieldConfig: { defaults: {}, overrides: [] },
        gridPos: { h: 14, w: 24, x: 0, y: 0 },
        id: 1,
        options: panelOptions,
        targets: [
          {
            datasource: { type: 'prometheus', uid: options.datasourceUID },
            expr: 'up',
            format: 'time_series',
            instant: false,
            range: true,
            refId: 'A',
          },
        ],
        title: testCase.id,
        transformations: [],
        type: 'timeseries',
      },
    ],
    refresh: '',
    schemaVersion: 41,
    tags: ['prometheus-multibatch-browser-matrix'],
    templating: { list: [] },
    time: { from: 'now-5m', to: 'now' },
    timezone: 'browser',
    title: `Prometheus browser matrix ${testCase.id}`,
    uid,
    version: 0,
  };
}

async function configureDatasource() {
  const existing = await grafanaRequest('/api/datasources/uid/' + encodeURIComponent(options.datasourceUID));
  const datasource = existing.ok
    ? await existing.json()
    : {
        access: 'proxy',
        isDefault: false,
        name: 'prometheus-browser-matrix',
        type: 'prometheus',
        uid: options.datasourceUID,
      };
  const response = await grafanaRequest(
    existing.ok ? '/api/datasources/uid/' + encodeURIComponent(options.datasourceUID) : '/api/datasources',
    {
      body: JSON.stringify({
        ...datasource,
        access: 'proxy',
        jsonData: { ...(datasource.jsonData ?? {}), httpMethod: 'POST' },
        url: options.upstreamURL,
      }),
      headers: { 'content-type': 'application/json' },
      method: existing.ok ? 'PUT' : 'POST',
    }
  );
  if (!response.ok) {
    throw new Error(`datasource update failed for ${options.datasourceUID}: HTTP ${response.status}`);
  }
}

async function importDashboard(dashboard) {
  const response = await grafanaRequest('/api/dashboards/db', {
    body: JSON.stringify({ dashboard, overwrite: true }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`dashboard import failed for ${dashboard.uid}: HTTP ${response.status}`);
  }
}

async function resetFakeRequests() {
  const response = await fakeRequest('/debug/requests/reset', { method: 'POST' });
  if (!response.ok) {
    throw new Error(`fake request reset failed: HTTP ${response.status}`);
  }
}

async function setFakeMode(testCase) {
  const response = await fakeRequest('/debug/mode', {
    body: new URLSearchParams({
      dataShape: testCase.dataShape,
      upstreamFormat: testCase.upstreamFormat,
    }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`fake mode update failed: HTTP ${response.status}`);
  }
}

async function validateFakeUpstreamEvidence(testCase) {
  const response = await fakeRequest('/debug/requests');
  if (!response.ok) {
    throw new Error(`fake request evidence failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const requests = Array.isArray(payload.requests) ? payload.requests : [];
  const rangeRequests = requests.filter((request) => request.path === '/api/v1/query_range');
  if (rangeRequests.length === 0) {
    throw new Error('fake upstream observed no /api/v1/query_range request');
  }

  const evidence = rangeRequests.map((request) => ({
    bodyKind: actualBodyKind(request),
    contentType: actualContentType(request),
    dataShape: actualDataShape(request),
    format: actualFormat(request),
    payloadType: actualPayloadType(request),
    request,
  }));
  for (const [index, entry] of evidence.entries()) {
    if (!entry.format) {
      throw new Error(`fake upstream request ${index + 1} did not report its actual returned format`);
    }
    if (entry.format !== testCase.upstreamFormat) {
      throw new Error(
        `fake upstream request ${index + 1} returned ${entry.format}; expected ${testCase.upstreamFormat}`
      );
    }
    if (!entry.dataShape) {
      throw new Error(`fake upstream request ${index + 1} did not report its actual returned data shape`);
    }
    if (entry.dataShape !== testCase.dataShape) {
      throw new Error(`fake upstream request ${index + 1} returned ${entry.dataShape}; expected ${testCase.dataShape}`);
    }
    if (entry.request.compactHeader) {
      throw new Error(
        `fake upstream request ${index + 1} unexpectedly received compact header ${entry.request.compactHeader}`
      );
    }
    if (testCase.upstreamFormat === 'plain') {
      if (entry.bodyKind !== 'prometheus-json' || !String(entry.contentType).startsWith('application/json')) {
        throw new Error(`fake upstream request ${index + 1} did not return ordinary Prometheus JSON`);
      }
    } else if (
      entry.bodyKind !== 'jsonl' ||
      !String(entry.contentType).includes('prometheus.multibatch') ||
      Number(entry.payloadType) !== 1
    ) {
      throw new Error(`fake upstream request ${index + 1} did not return multibatch type-1 JSONL`);
    }
  }
  return {
    rangeRequestCount: rangeRequests.length,
    returnedBodyKinds: evidence.map((entry) => entry.bodyKind),
    returnedContentTypes: evidence.map((entry) => entry.contentType),
    returnedDataShapes: evidence.map((entry) => entry.dataShape),
    returnedFormats: evidence.map((entry) => entry.format),
    returnedPayloadTypes: evidence.map((entry) => entry.payloadType),
    requests: rangeRequests,
  };
}

function actualFormat(request) {
  return (
    request.returnedFormat ??
    request.actualFormat ??
    request.responseFormat ??
    request.returnedUpstreamFormat ??
    request.upstreamFormatReturned
  );
}

function actualDataShape(request) {
  return request.returnedDataShape ?? request.actualDataShape ?? request.responseDataShape ?? request.dataShapeReturned;
}

function actualBodyKind(request) {
  return request.returnedBodyKind ?? request.actualBodyKind ?? request.responseBodyKind;
}

function actualContentType(request) {
  return request.returnedContentType ?? request.actualContentType ?? request.responseContentType;
}

function actualPayloadType(request) {
  return request.returnedPayloadType ?? request.actualPayloadType ?? request.responsePayloadType;
}

async function augmentReport(reportPath, extra) {
  let report = {};
  try {
    report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  } catch {
    // Preserve the runner evidence even if the verifier failed before writing a report.
  }
  await fs.writeFile(reportPath, `${JSON.stringify({ ...report, ...extra }, null, 2)}\n`);
}

function dashboardURL(dashboard) {
  return options.grafanaURL + '/d/' + dashboard.uid + '/prometheus-browser-matrix?from=now-5m&to=now&timezone=browser';
}

async function grafanaRequest(endpoint, init = {}) {
  return fetch(new URL(endpoint, options.grafanaURL), {
    ...init,
    headers: { Authorization: auth, ...(init.headers ?? {}) },
  });
}

async function fakeRequest(endpoint, init = {}) {
  return fetch(new URL(endpoint, options.fakeControlURL), init);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function writeIndex(results) {
  await fs.writeFile(path.join(options.outputDir, 'index.json'), `${JSON.stringify(results, null, 2)}\n`);
}
