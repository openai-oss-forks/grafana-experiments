#!/usr/bin/env node

import http from 'node:http';

const options = parseArgs(process.argv.slice(2));
let gateEnabled = options.gateEnabled;
let upstreamFormat = options.upstreamFormat;
let dataShape = options.dataShape;
const requests = [];

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const params = await readParams(request, url);

    if (url.pathname === '/debug/mode') {
      if (request.method === 'POST') {
        const enabled = params.get('gate');
        if (enabled !== null) {
          gateEnabled = enabled === 'true' || enabled === 'on';
        }
        const requestedUpstreamFormat = params.get('upstreamFormat');
        if (requestedUpstreamFormat !== null) {
          upstreamFormat = parseUpstreamFormat(requestedUpstreamFormat);
        }
        const requestedDataShape = params.get('dataShape');
        if (requestedDataShape !== null) {
          dataShape = parseDataShape(requestedDataShape);
        }
      }
      return writeJSON(response, { dataShape, gateEnabled, upstreamFormat });
    }
    if (url.pathname === '/debug/requests/reset') {
      if (request.method !== 'POST') {
        response.writeHead(405, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'error', error: 'method not allowed' }));
        return;
      }
      requests.length = 0;
      return writeJSON(response, { requests });
    }
    if (url.pathname === '/debug/requests') {
      return writeJSON(response, { requests });
    }

    const bypass = request.headers['x-oqp-cache-control'] === 'no-cache';
    const cacheEligible = gateEnabled && !bypass;
    const requestRecord = {
      accept: String(request.headers.accept ?? ''),
      acceptsMultiBatch: acceptsMultiBatch(request),
      bypass,
      cacheEligible,
      compactHeader: String(request.headers['x-grafana-query-format'] ?? ''),
      dataShape,
      method: request.method,
      path: url.pathname,
      query: params.get('query') ?? '',
      returnedBodyKind: null,
      returnedContentType: null,
      returnedDataShape: null,
      returnedFormat: null,
      returnedPayloadType: null,
      upstreamFormat,
    };
    requests.push(requestRecord);
    if (url.pathname === '/api/v1/labels') {
      return writeJSON(response, {
        status: 'success',
        data: [
          '__name__',
          'app',
          'cluster',
          'cluster_short_name',
          'env',
          'instance',
          'job',
          'oai_sd_routed_to',
          'oai_sd_target_service',
          'route_type',
          'service',
        ],
      });
    }
    if (url.pathname === '/api/v1/series') {
      return writeJSON(response, { status: 'success', data: [metricLabels(params)] });
    }
    if (url.pathname.startsWith('/api/v1/label/') && url.pathname.endsWith('/values')) {
      const label = decodeURIComponent(url.pathname.slice('/api/v1/label/'.length, -'/values'.length));
      return writeJSON(response, { status: 'success', data: labelValues(label) });
    }
    if (url.pathname === '/api/v1/query') {
      const timestamp = numberParam(params, 'time', Math.floor(Date.now() / 1000));
      return writeJSON(response, {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [{ metric: metricLabels(params), value: [timestamp, '1'] }],
        },
      });
    }
    if (url.pathname === '/api/v1/query_range') {
      const returnedFormat = resolveUpstreamFormat({ cacheEligible, request });
      requestRecord.returnedDataShape = dataShape;
      requestRecord.returnedFormat = returnedFormat;
      if (returnedFormat === 'multibatch') {
        requestRecord.returnedBodyKind = 'jsonl';
        requestRecord.returnedContentType = 'application/com.openai.prometheus.multibatch; version=1';
        requestRecord.returnedPayloadType = 1;
        return writeDelayedMultiBatch(response, params, dataShape);
      }
      requestRecord.returnedBodyKind = 'prometheus-json';
      requestRecord.returnedContentType = 'application/json';
      return writeJSON(response, rangeResponse(params, dataShape), {
        'x-fake-data-shape': dataShape,
        'x-fake-upstream': 'chronosphere',
        'x-fake-upstream-format': returnedFormat,
      });
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'error', error: `unknown path ${url.pathname}` }));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'error', error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(options.port, '127.0.0.1', () => {
  console.log(
    `fake Prometheus multibatch server listening on 127.0.0.1:${options.port}; gate=${gateEnabled}; upstreamFormat=${upstreamFormat}; dataShape=${dataShape}`
  );
});

function parseArgs(argv) {
  const parsed = {
    dataShape: 'eligible',
    finalDelayMs: 1000,
    gateEnabled: true,
    port: 19090,
    upstreamFormat: 'auto',
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--port') {
      parsed.port = Number(value);
      index++;
    } else if (arg === '--final-delay-ms') {
      parsed.finalDelayMs = Number(value);
      index++;
    } else if (arg === '--gate') {
      parsed.gateEnabled = value === 'true' || value === 'on';
      index++;
    } else if (arg === '--upstream-format') {
      parsed.upstreamFormat = parseUpstreamFormat(value);
      index++;
    } else if (arg === '--data-shape') {
      parsed.dataShape = parseDataShape(value);
      index++;
    } else if (arg === '--help' || arg === '-h') {
      console.error(
        'Usage: node scripts/fake-prometheus-multibatch.mjs [--port 19090] [--gate on|off] [--upstream-format plain|multibatch|auto] [--data-shape eligible|ineligible] [--final-delay-ms 1000]'
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(parsed.port) || parsed.port <= 0) {
    throw new Error('--port must be a positive integer');
  }
  if (!Number.isFinite(parsed.finalDelayMs) || parsed.finalDelayMs < 0) {
    throw new Error('--final-delay-ms must be zero or greater');
  }
  return parsed;
}

function parseUpstreamFormat(value) {
  if (value === 'plain' || value === 'multibatch' || value === 'auto') {
    return value;
  }
  throw new Error('--upstream-format/upstreamFormat must be plain, multibatch, or auto');
}

function parseDataShape(value) {
  if (value === 'eligible' || value === 'ineligible') {
    return value;
  }
  throw new Error('--data-shape/dataShape must be eligible or ineligible');
}

function resolveUpstreamFormat({ cacheEligible, request }) {
  if (upstreamFormat !== 'auto') {
    return upstreamFormat;
  }
  return cacheEligible && acceptsMultiBatch(request) ? 'multibatch' : 'plain';
}

async function readParams(request, url) {
  const params = new URLSearchParams(url.search);
  if (request.method !== 'POST') {
    return params;
  }
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  const contentType = request.headers['content-type'] ?? '';
  if (contentType.includes('application/json')) {
    const parsed = JSON.parse(body || '{}');
    for (const [key, value] of Object.entries(parsed)) {
      params.set(key, String(value));
    }
    return params;
  }
  for (const [key, value] of new URLSearchParams(body)) {
    params.set(key, value);
  }
  return params;
}

function acceptsMultiBatch(request) {
  const accept = String(request.headers.accept ?? '').toLowerCase();
  return (
    accept.includes('application/com.openai.prometheus.multibatch') ||
    accept.includes('application/prometheus.multibatch')
  );
}

function writeJSON(response, body, headers = {}) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(200, {
    ...headers,
    'content-length': String(encoded.length),
    'content-type': 'application/json',
  });
  response.end(encoded);
}

function writeDelayedMultiBatch(response, params, shape) {
  const start = numberParam(params, 'start', Math.floor(Date.now() / 1000) - 120);
  const step = Math.max(numberParam(params, 'step', 60), 1);
  const firstTimestamp = firstSeriesTimestamp(start, step, shape);
  const frameKey = 'series:1';
  const labels = metricLabels(params);
  const partial = [
    JSON.stringify({
      type: 'schema',
      frame: frameKey,
      columns: [
        { name: 'time', type: 'time' },
        { name: 'value', type: 'number', labels },
      ],
    }),
    JSON.stringify({ type: 'data', frame: frameKey, data: [new Date(firstTimestamp * 1000).toISOString(), '1'] }),
    JSON.stringify({ type: 'status', frame: frameKey, data: { isIncomplete: true } }),
  ].join('\n');
  const final = [
    JSON.stringify({
      type: 'data',
      frame: frameKey,
      data: [new Date((firstTimestamp + step) * 1000).toISOString(), '2'],
    }),
    JSON.stringify({ type: 'status', frame: frameKey, data: { isIncomplete: false } }),
  ].join('\n');

  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'application/com.openai.prometheus.multibatch; version=1',
    'x-fake-data-shape': shape,
    'x-fake-upstream': 'trickster',
    'x-fake-upstream-format': 'multibatch',
    'x-trickster-result': 'kmiss',
  });
  response.flushHeaders();
  response.write(responseHeader());
  response.write(batchFrame(Buffer.from(partial), 0));
  setTimeout(() => {
    response.end(batchFrame(Buffer.from(final), 1));
  }, options.finalDelayMs);
}

function responseHeader() {
  const header = Buffer.alloc(12);
  header.write('MBRH', 0, 'ascii');
  header[4] = 1;
  return header;
}

function batchFrame(payload, flags) {
  const header = Buffer.alloc(12);
  header.write('MBBF', 0, 'ascii');
  header[4] = 1;
  header[5] = 1;
  header[6] = flags;
  header[7] = 0;
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

function rangeResponse(params, shape) {
  const start = numberParam(params, 'start', Math.floor(Date.now() / 1000) - 120);
  const end = numberParam(params, 'end', start + 120);
  const step = Math.max(numberParam(params, 'step', 60), 1);
  const values = [];
  for (
    let timestamp = firstSeriesTimestamp(start, step, shape);
    timestamp <= end + 1e-9 && values.length < 1000;
    timestamp += step
  ) {
    values.push([timestamp, String(values.length + 1)]);
  }
  return {
    status: 'success',
    data: {
      resultType: 'matrix',
      result: [{ metric: metricLabels(params), values }],
    },
  };
}

function firstSeriesTimestamp(start, step, shape) {
  const aligned = Math.ceil(start / step) * step;
  return shape === 'ineligible' ? aligned + step / 2 : aligned;
}

function metricLabels(params) {
  return {
    __name__: expressionMetricName(params.get('query')),
    app: 'sa-server',
    cluster: 'prod-engine-aks-eastus-api-c1',
    cluster_short_name: 'c1',
    env: 'prod',
    instance: 'fake-prometheus:9090',
    job: 'fake',
    oai_sd_routed_to: 'coreapi-chat',
    oai_sd_target_service: 'coreapi-chat',
    route_type: 'direct',
    service: 'sa-server',
  };
}

function expressionMetricName(query) {
  const match = String(query ?? '').match(/[a-zA-Z_:][a-zA-Z0-9_:]*/);
  return match?.[0] ?? 'up';
}

function labelValues(label) {
  const values = {
    app: ['sa-server', 'enginev3'],
    cluster: ['prod-engine-aks-eastus-api-c1'],
    cluster_short_name: ['c1', 'c2'],
    caller_cluster_short_name: ['c1', 'c2'],
    dest_host: ['coreapi-chat'],
    destination_service: ['coreapi-chat'],
    env: ['prod'],
    job: ['fake'],
    oai_sd_routed_to: ['coreapi-chat'],
    oai_sd_target_service: ['coreapi-chat'],
    protocol: ['http'],
    route_type: ['direct'],
    sa_server_include: ['sa-server-dev-local'],
    service: ['sa-server', 'enginev3'],
    service_name: ['sa-server', 'enginev3'],
  };
  return values[label] ?? ['fake'];
}

function numberParam(params, name, fallback) {
  const value = Number(params.get(name));
  return Number.isFinite(value) ? value : fallback;
}
