import { dateTime, DataQueryRequest, DataQueryResponse, LoadingState } from '@grafana/data';

import {
  MULTIBATCH_ACCEPT_HEADER,
  MULTIBATCH_CONTENT_TYPE,
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
    decode = jest.fn((payload: Uint8Array) => payload);
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
    const batches = [
      responseHeaderFrame(),
      frame(
        `${JSON.stringify({
          status: 'success',
          data: {
            resultType: 'matrix',
            result: [{ metric: { model: 'first' }, values: [[1, '10']] }],
          },
        })}\n`,
        0
      ),
      frame(
        `${JSON.stringify({
          status: 'success',
          data: {
            resultType: 'matrix',
            result: [{ metric: { model: 'first' }, values: [[2, '20']] }],
          },
        })}\n`,
        FINAL_BATCH_FLAG
      ),
    ];
    global.fetch = jest.fn().mockResolvedValue({
      body: readableBody(batches),
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

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/datasources/uid/prometheus/resources/api/v1/query_range',
      expect.objectContaining({
        body: 'query=sum%28rate%28http_requests_total%5B%24__interval%5D%29%29&start=0&end=10&step=60',
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
