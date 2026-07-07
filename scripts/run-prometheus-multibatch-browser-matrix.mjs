#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const dashboards = [
  {
    file: 'enginev3-dashboard.json',
    name: 'enginev3',
    slug: 'enginev3',
    uid: 'qey-v-oai-migrated-20260225224544-03b804',
  },
  {
    file: 'ste-dashboard.json',
    name: 'ste',
    slug: 'go-ste-turn-exchange-client-availability',
    uid: 'v63-3j8-73x',
  },
  {
    file: 'service-discovery-dashboard.json',
    name: 'service-discovery-panel-33',
    query:
      'orgId=1&from=now-30m&to=now&timezone=browser&var-dest_host=coreapi-chat&var-protocol=%22.%2A%22&var-env=prod&var-cluster_short_name=$__all&var-service=$__all&var-caller_cluster_short_name=$__all&var-sa_server_include=sa-server-dev-.%2A&refresh=30s&editPanel=33',
    slug: 'service-discovery-for-service-owners-callees',
    uid: '00e27986-022a-49d7-a9be-ecabb2383079',
  },
];
const datasourceUIDs = ['P4F457DFB421B3C5C', 'P868F181D1D76E0DD'];
const unicodeLegend =
  '[{{app}}] in [{{cluster_short_name}}] ➡️ [{{oai_sd_target_service}}] in [{{oai_sd_routed_to}}] via {{route_type}}';
const options = parseArgs(process.argv.slice(2));
const auth = 'Basic ' + Buffer.from(options.username + ':' + options.password).toString('base64');

await fs.mkdir(options.outputDir, { recursive: true });
for (const definition of dashboards) {
  await importDashboard(await readDashboard(definition));
}

const results = [];
for (const gate of [true, false]) {
  for (const bypass of [false, true]) {
    await setGate(gate);
    await configureDatasources(bypass);
    for (const dashboard of dashboards) {
      const name = dashboard.name + '-gate-' + (gate ? 'on' : 'off') + '-bypass-' + (bypass ? 'on' : 'off');
      const report = path.join(options.outputDir, name + '.json');
      const args = [
        options.verifyScript,
        '--enable-multibatch-toggle',
        '--url',
        dashboardURL(dashboard),
        '--name',
        name,
        '--output',
        report,
        '--username',
        options.username,
        '--password',
        options.password,
        '--require-compact-request',
        '--timeout-ms',
        String(options.timeoutMs),
      ];
      if (options.chromiumPath) {
        args.push('--chromium-path', options.chromiumPath);
      }
      if (gate && !bypass) {
        args.push('--expected-upstream', 'trickster', '--require-cache-status', '--require-partial-before-final');
      } else {
        args.push('--expected-upstream', 'chronosphere', '--forbid-cache-status');
      }
      const exitCode = await run(process.execPath, args);
      results.push({ bypass, dashboard: dashboard.name, exitCode, gate, report });
      await writeIndex(results);
      if (exitCode !== 0 && !options.keepGoing) {
        process.exit(exitCode);
      }
    }
  }
}

if (results.some((result) => result.exitCode !== 0)) {
  process.exitCode = 1;
} else {
  console.log('PASS matrix: ' + results.length + ' browser run(s)');
}

function parseArgs(argv) {
  const parsed = {
    dashboardDir: '',
    fakeControlURL: 'http://127.0.0.1:19090',
    grafanaURL: 'http://127.0.0.1:3000',
    keepGoing: false,
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
      case '--dashboard-dir':
        parsed.dashboardDir = value;
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
      case '--keep-going':
        parsed.keepGoing = true;
        break;
      case '--help':
      case '-h':
        usage(0);
        break;
      default:
        throw new Error('Unknown argument: ' + arg);
    }
  }
  if (!parsed.dashboardDir) {
    usage(1);
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }
  return parsed;
}

function usage(exitCode) {
  console.error(
    'Usage: node scripts/run-prometheus-multibatch-browser-matrix.mjs --dashboard-dir PATH [options]\n\n' +
      'The directory must contain enginev3-dashboard.json, ste-dashboard.json, and service-discovery-dashboard.json.\n' +
      'Options: --grafana-url URL --upstream-url URL --fake-control-url URL --output-dir PATH\n' +
      '         --chromium-path PATH --timeout-ms N --keep-going'
  );
  process.exit(exitCode);
}

async function readDashboard(definition) {
  const payload = JSON.parse(await fs.readFile(path.join(options.dashboardDir, definition.file), 'utf8'));
  const dashboard = structuredClone(payload.dashboard ?? payload);
  dashboard.id = null;
  dashboard.uid = definition.uid;
  if (definition.uid === '00e27986-022a-49d7-a9be-ecabb2383079') {
    restorePanel33Legend(dashboard);
  }
  return dashboard;
}

function restorePanel33Legend(dashboard) {
  const queue = [...(dashboard.panels ?? [])];
  while (queue.length > 0) {
    const panel = queue.shift();
    if (panel?.id === 33) {
      for (const target of panel.targets ?? []) {
        target.legendFormat = unicodeLegend;
      }
      return;
    }
    queue.push(...(panel?.panels ?? []));
  }
  throw new Error('service discovery dashboard did not contain panel 33');
}

async function importDashboard(dashboard) {
  const response = await grafanaRequest('/api/dashboards/db', {
    body: JSON.stringify({ dashboard, overwrite: true }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error('dashboard import failed for ' + dashboard.uid + ': HTTP ' + response.status);
  }
}

async function configureDatasources(bypass) {
  for (const uid of datasourceUIDs) {
    const existing = await grafanaRequest('/api/datasources/uid/' + uid);
    const datasource = existing.ok
      ? await existing.json()
      : { access: 'proxy', name: 'multibatch-' + uid, type: 'prometheus', uid };
    datasource.access = 'proxy';
    datasource.url = options.upstreamURL;
    datasource.jsonData = { ...(datasource.jsonData ?? {}), httpMethod: 'POST' };
    delete datasource.jsonData.httpHeaderName1;
    const secureJsonData = { httpHeaderValue1: '' };
    if (bypass) {
      datasource.jsonData.httpHeaderName1 = 'x-oqp-cache-control';
      secureJsonData.httpHeaderValue1 = 'no-cache';
    }
    const response = await grafanaRequest(existing.ok ? '/api/datasources/uid/' + uid : '/api/datasources', {
      body: JSON.stringify({ ...datasource, secureJsonData }),
      headers: { 'content-type': 'application/json' },
      method: existing.ok ? 'PUT' : 'POST',
    });
    if (!response.ok) {
      throw new Error('datasource update failed for ' + uid + ': HTTP ' + response.status);
    }
  }
}

async function setGate(gate) {
  if (!options.fakeControlURL) {
    return;
  }
  const response = await fetch(new URL('/debug/mode', options.fakeControlURL), {
    body: new URLSearchParams({ gate: String(gate) }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error('fake gate update failed: HTTP ' + response.status);
  }
}

function dashboardURL(dashboard) {
  const base = options.grafanaURL + '/d/' + dashboard.uid + '/' + dashboard.slug;
  return dashboard.query ? base + '?' + dashboard.query : base + '?from=now-30m&to=now';
}

async function grafanaRequest(endpoint, init = {}) {
  return fetch(new URL(endpoint, options.grafanaURL), {
    ...init,
    headers: { Authorization: auth, ...(init.headers ?? {}) },
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function writeIndex(results) {
  await fs.writeFile(path.join(options.outputDir, 'index.json'), JSON.stringify(results, null, 2) + '\n');
}
