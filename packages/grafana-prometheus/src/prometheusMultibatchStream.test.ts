import { dateTime, DataQueryRequest, DataQueryResponse, LoadingState } from '@grafana/data';
import { toDataQueryResponse } from '@grafana/runtime';

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
  toDataQueryResponse: jest.fn(),
}));

jest.mock('zstddec', () => ({
  ZSTDDecoder: class {
    init = jest.fn(async () => {});
    decode = jest.fn((payload: Uint8Array, uncompressedSize?: number) => {
      if (uncompressedSize !== undefined) {
        throw new Error('unexpected fixed zstd output size');
      }
      return payload;
    });
  },
}));

const FINAL_BATCH_FLAG = 1;
const PAYLOAD_ENCODING_IDENTITY = 0;
const PAYLOAD_ENCODING_ZSTD = 1;
const PAYLOAD_TYPE_COMPACT_V1 = 2;
const compactMediaType = 'application/vnd.grafana.querydata.compact;version=1';
const toDataQueryResponseMock = jest.mocked(toDataQueryResponse);

describe('Prometheus multi-batch streaming', () => {
  beforeEach(() => {
    toDataQueryResponseMock.mockImplementation((raw) => {
      const data = 'data' in raw ? raw.data : undefined;
      const payload =
        Object.prototype.toString.call(data) === '[object ArrayBuffer]'
          ? new TextDecoder().decode(data as ArrayBuffer)
          : 'json-fallback';
      return {
        compactSeries: { payload },
        data: [],
        state: LoadingState.Done,
      } as unknown as DataQueryResponse;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('detects the neutral content type', () => {
    expect(isMultiBatchContentType('application/prometheus.multibatch; version=1')).toBe(true);
    expect(isMultiBatchContentType('application/com.openai.prometheus.multibatch; version=1')).toBe(true);
    expect(isMultiBatchContentType('application/json')).toBe(false);
  });

  it('decodes split compact-v1 payload frames', async () => {
    const bytes = concatBytes(responseHeaderFrame(), frame('partial', 0), frame('final', FINAL_BATCH_FLAG));
    const batches: Array<{ payload: string; isFinal: boolean }> = [];

    await decodeMultiBatchFrames(
      [bytes.subarray(0, 5), bytes.subarray(5, 20), bytes.subarray(20)],
      (payload, isFinal) => {
        batches.push({ payload: new TextDecoder().decode(payload), isFinal });
      }
    );

    expect(batches).toEqual([
      { payload: 'partial', isFinal: false },
      { payload: 'final', isFinal: true },
    ]);
  });

  it('does not use a fixed zstd output size for compact-v1 payloads', async () => {
    const batches: Array<{ payload: string; isFinal: boolean }> = [];

    await decodeMultiBatchFrames(
      [responseHeaderFrame(), frame('final', FINAL_BATCH_FLAG, PAYLOAD_ENCODING_ZSTD)],
      (payload, isFinal) => {
        batches.push({ payload: new TextDecoder().decode(payload), isFinal });
      }
    );

    expect(batches).toEqual([{ payload: 'final', isFinal: true }]);
  });

  it('rejects truncated frames', async () => {
    await expect(decodeMultiBatchFrames([frame('payload').subarray(0, 10)], jest.fn())).rejects.toThrow(/Truncated/);
  });

  it('rejects responses without a final batch marker', async () => {
    await expect(decodeMultiBatchFrames([responseHeaderFrame(), frame('payload', 0)], jest.fn())).rejects.toThrow(
      /without a final batch/
    );
  });

  it('rejects responses without a response header frame', async () => {
    await expect(decodeMultiBatchFrames([frame('payload')], jest.fn())).rejects.toThrow(/missing response header/);
  });

  it('rejects unsupported frame magic', async () => {
    await expect(
      decodeMultiBatchFrames(
        [responseHeaderFrame(), frame('payload', FINAL_BATCH_FLAG, 0, PAYLOAD_TYPE_COMPACT_V1, 'BAD!')],
        jest.fn()
      )
    ).rejects.toThrow(/frame magic/);
  });

  it('rejects unsupported reserved flags', async () => {
    await expect(decodeMultiBatchFrames([responseHeaderFrame(), frame('payload', 0x02)], jest.fn())).rejects.toThrow(
      /frame flags/
    );
  });

  it('rejects data after the final batch marker', async () => {
    await expect(
      decodeMultiBatchFrames([responseHeaderFrame(), frame('payload'), frame('payload')], jest.fn())
    ).rejects.toThrow(/after the final batch/);
  });

  it('rejects unsupported payload encodings before decoding', async () => {
    await expect(
      decodeMultiBatchFrames([responseHeaderFrame(), frame('payload', FINAL_BATCH_FLAG, 9)], jest.fn())
    ).rejects.toThrow(/payload encoding/);
  });

  it('rejects unsupported payload types', async () => {
    await expect(
      decodeMultiBatchFrames([responseHeaderFrame(), frame('payload', FINAL_BATCH_FLAG, 0, 1)], jest.fn())
    ).rejects.toThrow(/payload type/);
  });

  it('emits compact-v1 partial and final responses through the regular compact decoder', async () => {
    const target: PromQuery = {
      expr: 'sum(rate(http_requests_total[$__interval]))',
      legendFormat: 'Result - {{result}}',
      refId: 'A',
      utcOffsetSec: 3600,
    };
    const request = requestForTarget(target);
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    global.fetch = jest.fn().mockResolvedValue({
      body: readableBody([concatBytes(responseHeaderFrame(), frame('partial', 0), frame('final', FINAL_BATCH_FLAG))]),
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
      '/api/datasources/uid/prometheus/resources/api/v1/query_range',
      expect.objectContaining({
        body: 'query=sum%28rate%28http_requests_total%5B%24__interval%5D%29%29&start=0&end=0&step=60',
        headers: expect.objectContaining({
          Accept: MULTIBATCH_ACCEPT_HEADER,
          'X-Grafana-Query-Format': 'compact-v1',
          'X-Grafana-Prometheus-Multibatch-Legend-Format': 'Result - {{result}}',
          'X-Grafana-Prometheus-Multibatch-Ref-Id': 'A',
          'X-Grafana-Prometheus-Multibatch-UTC-Offset-Sec': '3600',
        }),
        method: 'POST',
      })
    );
    expect(responses.map((response) => response.state)).toEqual([LoadingState.Streaming, LoadingState.Done]);
    expect(responses.map((response) => response.compactSeries)).toEqual([{ payload: 'partial' }, { payload: 'final' }]);
    expect(toDataQueryResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({ headers: new Headers({ 'content-type': compactMediaType }) }),
      [target],
      true
    );
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 0);
  });

  it('decodes a non-multibatch compact fallback response with the regular compact decoder', async () => {
    const target: PromQuery = { expr: 'up', refId: 'A' };
    const request = requestForTarget(target);
    global.fetch = jest.fn().mockResolvedValue({
      arrayBuffer: jest.fn().mockResolvedValue(new TextEncoder().encode('single').buffer),
      body: null,
      headers: new Headers({ 'content-type': compactMediaType }),
      ok: true,
      text: jest.fn(),
    });

    const responses = await collectResponses(
      queryPrometheusMultiBatch('prometheus', request, target, {
        customQueryParameters: new URLSearchParams(),
        httpMethod: 'POST',
      })
    );

    expect(responses.map((response) => response.compactSeries)).toEqual([{ payload: 'single' }]);
    expect(responses.map((response) => response.state)).toEqual([LoadingState.Done]);
  });

  it('uses datasource and target interval limits when building query_range parameters', async () => {
    const target: PromQuery = {
      expr: 'up',
      intervalFactor: 10,
      refId: 'A',
      stepSize: '2m',
    };
    const request = {
      ...requestForTarget(target),
      interval: '15s',
      intervalMs: 15000,
      range: {
        from: dateTime(10_500),
        to: dateTime(131_000),
      },
    } as DataQueryRequest<PromQuery>;
    global.fetch = jest.fn().mockResolvedValue({
      arrayBuffer: jest.fn().mockResolvedValue(new TextEncoder().encode('single').buffer),
      body: null,
      headers: new Headers({ 'content-type': compactMediaType }),
      ok: true,
      text: jest.fn(),
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
      '/api/datasources/uid/prometheus/resources/api/v1/query_range',
      expect.objectContaining({
        body: 'query=up&start=0&end=120&step=120&timeout=30s',
      })
    );
  });
});

function requestForTarget(target: PromQuery): DataQueryRequest<PromQuery> {
  return {
    interval: '1m',
    intervalMs: 60000,
    range: {
      from: dateTime(0),
      to: dateTime(10_000),
    },
    scopedVars: {},
    targets: [target],
  } as DataQueryRequest<PromQuery>;
}

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
  payloadType = PAYLOAD_TYPE_COMPACT_V1,
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
