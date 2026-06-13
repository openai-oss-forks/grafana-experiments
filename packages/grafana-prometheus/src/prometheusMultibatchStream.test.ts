import { dateTime, DataQueryRequest, DataQueryResponse, FieldType, LoadingState } from '@grafana/data';

import {
  MULTIBATCH_ACCEPT_HEADER,
  MULTIBATCH_CONTENT_TYPE,
  MULTIBATCH_PREFERRED_CONTENT_TYPE,
  decodeMultiBatchFrames,
  isMultiBatchContentType,
  queryPrometheusMultiBatch,
} from './prometheusMultibatchStream';
import { PromQuery } from './types';

jest.mock('@grafana/runtime', () => ({
  config: {
    appSubUrl: '',
  },
}));

jest.mock('zstddec', () => ({
  ZSTDDecoder: class {
    init = jest.fn(async () => {});
    decode = jest.fn((payload: Uint8Array, uncompressedSize?: number) => {
      const text = new TextDecoder().decode(payload);
      if (text.includes('needs-explicit-zstd-size') && !uncompressedSize) {
        throw new Error('memory access out of bounds');
      }
      return payload;
    });
  },
}));

const FINAL_BATCH_FLAG = 1;
const PAYLOAD_ENCODING_IDENTITY = 0;
const PAYLOAD_ENCODING_ZSTD = 1;

describe('Prometheus multi-batch streaming', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('detects the neutral content type', () => {
    expect(isMultiBatchContentType('application/prometheus.multibatch; version=1')).toBe(true);
    expect(isMultiBatchContentType('application/com.openai.prometheus.multibatch; version=1')).toBe(true);
    expect(isMultiBatchContentType('application/json')).toBe(false);
  });

  it('decodes split chunks and zstd-encoded JSONL payload frames', async () => {
    const bytes = concatBytes(
      responseHeaderFrame(),
      frame('{"type":"status","status":"streaming"}\n', 0),
      frame('{"type":"status","status":"done"}\n', FINAL_BATCH_FLAG, PAYLOAD_ENCODING_ZSTD)
    );
    const batches: Array<{ payload: string; isFinal: boolean }> = [];

    await decodeMultiBatchFrames(
      [bytes.subarray(0, 5), bytes.subarray(5, 20), bytes.subarray(20)],
      (payload, isFinal) => {
        batches.push({ payload, isFinal });
      }
    );

    expect(batches).toEqual([
      { payload: '{"type":"status","status":"streaming"}\n', isFinal: false },
      { payload: '{"type":"status","status":"done"}\n', isFinal: true },
    ]);
  });

  it('falls back to explicit zstd output sizes when the compressed frame does not advertise content size', async () => {
    const payload = '{"type":"status","status":"needs-explicit-zstd-size"}\n';
    const batches: Array<{ payload: string; isFinal: boolean }> = [];

    await decodeMultiBatchFrames(
      [responseHeaderFrame(), frame(payload, FINAL_BATCH_FLAG, PAYLOAD_ENCODING_ZSTD)],
      (batch, isFinal) => {
        batches.push({ payload: batch, isFinal });
      }
    );

    expect(batches).toEqual([{ payload, isFinal: true }]);
  });

  it('rejects truncated frames', async () => {
    await expect(decodeMultiBatchFrames([frame('{"type":"status"}\n').subarray(0, 10)], jest.fn())).rejects.toThrow(
      /Truncated/
    );
  });

  it('rejects responses without a final batch marker', async () => {
    await expect(
      decodeMultiBatchFrames([responseHeaderFrame(), frame('{"type":"status"}\n', 0)], jest.fn())
    ).rejects.toThrow(/without a final batch/);
  });

  it('rejects responses without a response header frame', async () => {
    await expect(decodeMultiBatchFrames([frame('{"type":"status"}\n')], jest.fn())).rejects.toThrow(
      /missing response header/
    );
  });

  it('rejects unsupported frame magic', async () => {
    await expect(
      decodeMultiBatchFrames(
        [responseHeaderFrame(), frame('{"type":"status","status":"done"}\n', FINAL_BATCH_FLAG, 0, 1, 'BAD!')],
        jest.fn()
      )
    ).rejects.toThrow(/frame magic/);
  });

  it('rejects unsupported reserved flags', async () => {
    await expect(
      decodeMultiBatchFrames([responseHeaderFrame(), frame('{"type":"status"}\n', 0x02)], jest.fn())
    ).rejects.toThrow(/frame flags/);
  });

  it('rejects data after the final batch marker', async () => {
    await expect(
      decodeMultiBatchFrames(
        [responseHeaderFrame(), frame('{"type":"status"}\n'), frame('{"type":"status"}\n')],
        jest.fn()
      )
    ).rejects.toThrow(/after the final batch/);
  });

  it('rejects unsupported payload encodings before decoding', async () => {
    await expect(
      decodeMultiBatchFrames([responseHeaderFrame(), frame('{"type":"status"}\n', FINAL_BATCH_FLAG, 9)], jest.fn())
    ).rejects.toThrow(/payload encoding/);
  });

  it('rejects unsupported payload types', async () => {
    await expect(
      decodeMultiBatchFrames([responseHeaderFrame(), frame('{"type":"status"}\n', FINAL_BATCH_FLAG, 0, 9)], jest.fn())
    ).rejects.toThrow(/payload type/);
  });

  it('rejects duplicate response headers', async () => {
    await expect(decodeMultiBatchFrames([responseHeaderFrame(), responseHeaderFrame()], jest.fn())).rejects.toThrow(
      /duplicate response header/
    );
  });

  it('rejects duplicate response headers after data starts', async () => {
    await expect(
      decodeMultiBatchFrames([responseHeaderFrame(), frame('{"type":"status"}\n', 0), responseHeaderFrame()], jest.fn())
    ).rejects.toThrow(/duplicate response header/);
  });

  it('rejects responses with only a response header', async () => {
    await expect(decodeMultiBatchFrames([responseHeaderFrame()], jest.fn())).rejects.toThrow(/without a final batch/);
  });

  it('emits partial Prometheus data first and keeps it in the final response', async () => {
    const target: PromQuery = {
      expr: 'sum(rate(http_requests_total[$__interval]))',
      refId: 'A',
    };
    const request = {
      interval: '1m',
      intervalMs: 60000,
      range: {
        from: dateTime(0),
        to: dateTime(10_000),
      },
      scopedVars: {},
      targets: [target],
    } as DataQueryRequest<PromQuery>;
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const partialFrame = frame(
      `${JSON.stringify({
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [{ metric: { model: 'first' }, values: [[1, '10']] }],
        },
      })}\n`,
      0
    );
    const finalFrame = frame(
      `${JSON.stringify({
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [{ metric: { model: 'first' }, values: [[2, '20']] }],
        },
      })}\n`,
      FINAL_BATCH_FLAG
    );
    const batches = [concatBytes(responseHeaderFrame(), partialFrame, finalFrame)];
    global.fetch = jest.fn().mockResolvedValue({
      body: readableBody(batches),
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? `${MULTIBATCH_PREFERRED_CONTENT_TYPE}; version=1` : null,
      },
      ok: true,
      text: jest.fn(),
    });

    const responses = await collectResponses(
      queryPrometheusMultiBatch('prometheus', request, target, {
        customQueryParameters: new URLSearchParams(),
        httpMethod: 'POST',
      })
    );

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/datasources/proxy/uid/prometheus/api/v1/query_range',
      expect.objectContaining({
        body: 'query=sum%28rate%28http_requests_total%5B%24__interval%5D%29%29&start=0&end=0&step=60',
        headers: expect.objectContaining({
          Accept: MULTIBATCH_ACCEPT_HEADER,
        }),
        method: 'POST',
      })
    );
    expect(responses.map((response) => response.state)).toEqual([LoadingState.Streaming, LoadingState.Done]);
    expect(responses[0].data[0].fields[0].values).toEqual([1000]);
    expect(responses[0].data[0].fields[1].values).toEqual([10]);
    expect(responses[1].data[0].fields[0].values).toEqual([1000, 2000]);
    expect(responses[1].data[0].fields[1].values).toEqual([10, 20]);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 0);
  });

  it('uses datasource and target interval limits when building query_range parameters', async () => {
    const target: PromQuery = {
      expr: 'up',
      refId: 'A',
      intervalFactor: 10,
      stepSize: '2m',
    };
    const request = {
      interval: '15s',
      intervalMs: 15000,
      range: {
        from: dateTime(10_500),
        to: dateTime(131_000),
      },
      scopedVars: {},
      targets: [target],
    } as DataQueryRequest<PromQuery>;
    global.fetch = jest.fn().mockResolvedValue({
      body: null,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      ok: true,
      text: jest.fn().mockResolvedValue(
        JSON.stringify({
          status: 'success',
          data: {
            resultType: 'matrix',
            result: [],
          },
        })
      ),
    });

    await collectResponses(
      queryPrometheusMultiBatch('prometheus', request, target, {
        customQueryParameters: new URLSearchParams(),
        httpMethod: 'POST',
        minInterval: '1m',
        queryTimeout: '30s',
      })
    );

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/datasources/proxy/uid/prometheus/api/v1/query_range',
      expect.objectContaining({
        body: 'query=up&start=0&end=120&step=120&timeout=30s',
      })
    );
  });

  it('preserves native histogram samples from Prometheus JSON responses', async () => {
    const target: PromQuery = {
      expr: 'histogram_metric',
      refId: 'A',
    };
    const request = {
      interval: '1m',
      intervalMs: 60000,
      range: {
        from: dateTime(0),
        to: dateTime(60_000),
      },
      scopedVars: {},
      targets: [target],
    } as DataQueryRequest<PromQuery>;
    const histogram = { count: '2', sum: '3', buckets: [] };
    global.fetch = jest.fn().mockResolvedValue({
      body: null,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      ok: true,
      text: jest.fn().mockResolvedValue(
        JSON.stringify({
          status: 'success',
          data: {
            resultType: 'matrix',
            result: [{ metric: { job: 'native' }, histograms: [[1, histogram]] }],
          },
        })
      ),
    });

    const responses = await collectResponses(
      queryPrometheusMultiBatch('prometheus', request, target, {
        customQueryParameters: new URLSearchParams(),
        httpMethod: 'POST',
      })
    );

    expect(responses[0].data[0].fields[1].type).toBe(FieldType.other);
    expect(responses[0].data[0].fields[1].values).toEqual([histogram]);
  });

  it('decodes OQP schema and data events keyed by frame id', async () => {
    const target: PromQuery = {
      expr: 'sum by ("turn_analytics.result") (sum_per_second({"client_turn_analytics.exchange_complete"}[1m]))',
      legendFormat: 'Result - {{turn_analytics.result}}',
      refId: 'A',
    };
    const request = {
      interval: '1m',
      intervalMs: 60000,
      range: {
        from: dateTime(0),
        to: dateTime(120_000),
      },
      scopedVars: {},
      targets: [target],
    } as DataQueryRequest<PromQuery>;

    const payload = [
      {
        type: 'schema',
        frame: 'result:0:series:canceled',
        columns: [
          { name: 'time', type: 'time', labels: {} },
          { name: 'value', type: 'number', labels: { 'turn_analytics.result': 'canceled' } },
        ],
      },
      { type: 'data', frame: 'result:0:series:canceled', data: ['1970-01-01T00:00:01Z', '10'] },
      {
        type: 'schema',
        frame: 'result:0:series:error',
        columns: [
          { name: 'time', type: 'time', labels: {} },
          { name: 'value', type: 'number', labels: { 'turn_analytics.result': 'error' } },
        ],
      },
      { type: 'data', frame: 'result:0:series:error', data: ['1970-01-01T00:00:02Z', '20'] },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');

    global.fetch = jest.fn().mockResolvedValue({
      body: readableBody([responseHeaderFrame(), frame(`${payload}\n`, FINAL_BATCH_FLAG)]),
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? `${MULTIBATCH_CONTENT_TYPE}; version=1` : null),
      },
      ok: true,
      text: jest.fn(),
    });

    const responses = await collectResponses(
      queryPrometheusMultiBatch('prometheus', request, target, {
        customQueryParameters: new URLSearchParams(),
        httpMethod: 'POST',
      })
    );

    expect(responses.map((response) => response.state)).toEqual([LoadingState.Done]);
    expect(responses[0].data).toHaveLength(2);
    expect(responses[0].data[0].refId).toBe('A');
    expect(responses[0].data[0].name).toBeUndefined();
    expect(responses[0].data[0].fields[0].values).toEqual([1000]);
    expect(responses[0].data[0].fields[1].config.displayNameFromDS).toBe('Result - canceled');
    expect(responses[0].data[0].fields[1].labels).toEqual({ 'turn_analytics.result': 'canceled' });
    expect(responses[0].data[0].fields[1].values).toEqual([10]);
    expect(responses[0].data[1].refId).toBe('A');
    expect(responses[0].data[1].name).toBeUndefined();
    expect(responses[0].data[1].fields[0].values).toEqual([2000]);
    expect(responses[0].data[1].fields[1].config.displayNameFromDS).toBe('Result - error');
    expect(responses[0].data[1].fields[1].labels).toEqual({ 'turn_analytics.result': 'error' });
    expect(responses[0].data[1].fields[1].values).toEqual([20]);
  });

  it('does not emit completed OQP schema-only frames as data', async () => {
    const target: PromQuery = {
      expr: 'sum(rate(empty_metric[$__interval]))',
      legendFormat: '{{result}}',
      refId: 'A',
    };
    const request = {
      interval: '1m',
      intervalMs: 60000,
      range: {
        from: dateTime(0),
        to: dateTime(120_000),
      },
      scopedVars: {},
      targets: [target],
    } as DataQueryRequest<PromQuery>;

    const payload = JSON.stringify({
      type: 'schema',
      frame: 'result:0:series:empty',
      columns: [
        { name: 'time', type: 'time', labels: {} },
        { name: 'value', type: 'number', labels: { result: 'empty' } },
      ],
    });

    global.fetch = jest.fn().mockResolvedValue({
      body: readableBody([responseHeaderFrame(), frame(`${payload}\n`, FINAL_BATCH_FLAG)]),
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? `${MULTIBATCH_CONTENT_TYPE}; version=1` : null),
      },
      ok: true,
      text: jest.fn(),
    });

    const responses = await collectResponses(
      queryPrometheusMultiBatch('prometheus', request, target, {
        customQueryParameters: new URLSearchParams(),
        httpMethod: 'POST',
      })
    );

    expect(responses.map((response) => response.state)).toEqual([LoadingState.Done]);
    expect(responses[0].data).toEqual([]);
  });

  it('uses the single label value for OQP auto legend frames', async () => {
    const target: PromQuery = {
      expr: 'sum by (turn_analytics_tools_used) (sum_over_time({"client_turn_analytics.tool_used"}[5m]))',
      legendFormat: '__auto',
      refId: 'A',
    };
    const request = {
      interval: '1m',
      intervalMs: 60000,
      range: {
        from: dateTime(0),
        to: dateTime(120_000),
      },
      scopedVars: {},
      targets: [target],
    } as DataQueryRequest<PromQuery>;

    const payload = [
      {
        type: 'schema',
        frame: 'result:0:series:web-run',
        columns: [
          { name: 'time', type: 'time', labels: {} },
          { name: 'value', type: 'number', labels: { turn_analytics_tools_used: 'web.run' } },
        ],
      },
      { type: 'data', frame: 'result:0:series:web-run', data: ['1970-01-01T00:00:01Z', '10'] },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');

    global.fetch = jest.fn().mockResolvedValue({
      body: readableBody([responseHeaderFrame(), frame(`${payload}\n`, FINAL_BATCH_FLAG)]),
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? `${MULTIBATCH_CONTENT_TYPE}; version=1` : null),
      },
      ok: true,
      text: jest.fn(),
    });

    const responses = await collectResponses(
      queryPrometheusMultiBatch('prometheus', request, target, {
        customQueryParameters: new URLSearchParams(),
        httpMethod: 'POST',
      })
    );

    expect(responses[0].data).toHaveLength(1);
    expect(responses[0].data[0].fields[1].config.displayNameFromDS).toBe('web.run');
    expect(responses[0].data[0].fields[1].values).toEqual([10]);
  });
});

function responseHeaderFrame(): Uint8Array {
  const bytes = new Uint8Array(12);
  bytes.set(
    [...`MBRH`].map((char) => char.charCodeAt(0)),
    0
  );
  bytes[4] = 1;
  return bytes;
}

function frame(
  payload: string,
  flags = FINAL_BATCH_FLAG,
  encoding = PAYLOAD_ENCODING_IDENTITY,
  payloadType = 1,
  magic = 'MBBF'
): Uint8Array {
  const payloadBytes = new TextEncoder().encode(payload);
  const bytes = new Uint8Array(12 + payloadBytes.byteLength);
  bytes.set(
    [...magic].map((char) => char.charCodeAt(0)),
    0
  );
  bytes.set([1, payloadType, flags, encoding], 4);
  new DataView(bytes.buffer).setUint32(8, payloadBytes.byteLength, false);
  bytes.set(payloadBytes, 12);
  return bytes;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function readableBody(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return {
    getReader() {
      return {
        read: async () => {
          if (index >= chunks.length) {
            return { done: true, value: undefined };
          }

          return { done: false, value: chunks[index++] };
        },
        releaseLock: jest.fn(),
      };
    },
  } as unknown as ReadableStream<Uint8Array>;
}

function collectResponses(observable: ReturnType<typeof queryPrometheusMultiBatch>): Promise<DataQueryResponse[]> {
  return new Promise((resolve, reject) => {
    const responses: DataQueryResponse[] = [];
    observable.subscribe({
      complete: () => resolve(responses),
      error: reject,
      next: (response) => responses.push(response),
    });
  });
}
