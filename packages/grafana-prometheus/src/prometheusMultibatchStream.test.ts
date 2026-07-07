import {
  AUTO_STEP_SIZE_FALLBACK_MAX_DATA_POINTS,
  dateTime,
  DataFrameType,
  DataQueryRequest,
  DataQueryResponse,
  LoadingState,
} from '@grafana/data';
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

const mockZstdDecode = jest.fn((payload: Uint8Array, uncompressedSize?: number) => {
  if (uncompressedSize === undefined) {
    throw new Error('missing fixed zstd output size');
  }
  const decoded = payload.subarray(6);
  return uncompressedSize >= decoded.byteLength ? decoded : new Uint8Array();
});

jest.mock('@grafana/runtime', () => ({
  config: {
    appSubUrl: '',
  },
  toDataQueryResponse: jest.fn(),
}));

jest.mock('zstddec', () => ({
  ZSTDDecoder: class {
    init = jest.fn(async () => {});
    decode = mockZstdDecode;
  },
}));

const FINAL_BATCH_FLAG = 1;
const PAYLOAD_ENCODING_IDENTITY = 0;
const PAYLOAD_ENCODING_ZSTD = 1;
const PAYLOAD_TYPE_JSONL = 1;
const PAYLOAD_TYPE_COMPACT_V1 = 2;
const compactMediaType = 'application/vnd.grafana.querydata.compact;version=1';
const toDataQueryResponseMock = jest.mocked(toDataQueryResponse);

describe('Prometheus multi-batch streaming', () => {
  beforeEach(() => {
    mockZstdDecode.mockClear();
    toDataQueryResponseMock.mockClear();
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
    expect(isMultiBatchContentType(`${MULTIBATCH_CONTENT_TYPE}; version=1`)).toBe(true);
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

  it('uses zstd frame content size for compact-v1 payloads', async () => {
    const batches: Array<{ payload: string; isFinal: boolean }> = [];

    await decodeMultiBatchFrames(
      [responseHeaderFrame(), frame(zstdPayload('final'), FINAL_BATCH_FLAG, PAYLOAD_ENCODING_ZSTD)],
      (payload, isFinal) => {
        batches.push({ payload: new TextDecoder().decode(payload), isFinal });
      }
    );

    expect(batches).toEqual([{ payload: 'final', isFinal: true }]);
    expect(mockZstdDecode).toHaveBeenCalledWith(expect.any(Uint8Array), 5);
  });

  it('decodes zstd frames without content size using bounded fallback capacity', async () => {
    const batches: Array<{ payload: string; isFinal: boolean }> = [];

    await decodeMultiBatchFrames(
      [responseHeaderFrame(), frame(zstdPayloadWithoutContentSize('final'), FINAL_BATCH_FLAG, PAYLOAD_ENCODING_ZSTD)],
      (payload, isFinal) => {
        batches.push({ payload: new TextDecoder().decode(payload), isFinal });
      }
    );

    expect(batches).toEqual([{ payload: 'final', isFinal: true }]);
    expect(mockZstdDecode).toHaveBeenCalledWith(expect.any(Uint8Array), 256);
  });

  it('rejects invalid zstd frame magic before decoding', async () => {
    await expect(
      decodeMultiBatchFrames(
        [responseHeaderFrame(), frame(new Uint8Array([0, 1, 2, 3, 4, 5]), FINAL_BATCH_FLAG, PAYLOAD_ENCODING_ZSTD)],
        jest.fn()
      )
    ).rejects.toThrow(/invalid frame magic/);
    expect(mockZstdDecode).not.toHaveBeenCalled();
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
      decodeMultiBatchFrames([responseHeaderFrame(), frame('payload', FINAL_BATCH_FLAG, 0, 9)], jest.fn())
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
        headers: expect.objectContaining({
          Accept: MULTIBATCH_ACCEPT_HEADER,
          'Content-Type': 'application/json',
          'X-Grafana-Query-Format': 'compact-v1',
        }),
        method: 'POST',
      })
    );
    const requestBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(requestBody).toEqual({
      from: '0',
      to: '10000',
      queries: [
        expect.objectContaining({
          datasource: { uid: 'prometheus' },
          expr: 'sum(rate(http_requests_total[$__interval]))',
          intervalMs: 60000,
          legendFormat: 'Result - {{result}}',
          maxDataPoints: AUTO_STEP_SIZE_FALLBACK_MAX_DATA_POINTS,
          refId: 'A',
          utcOffsetSec: 3600,
        }),
      ],
    });
    expect(responses.map((response) => response.state)).toEqual([LoadingState.Streaming, LoadingState.Done]);
    expect(responses.map((response) => response.compactSeries)).toEqual([{ payload: 'partial' }, { payload: 'final' }]);
    expect(toDataQueryResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({ headers: new Headers({ 'content-type': compactMediaType }) }),
      [target],
      true
    );
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 0);
  });

  it('emits non-compact JSONL partial and final accumulated responses without compact headers', async () => {
    const target: PromQuery = {
      expr: 'sum(rate(http_requests_total[$__interval]))',
      legendFormat: '{{job}}',
      refId: 'A',
    };
    const request = requestForTarget(target, false);
    const partialJsonl = [
      jsonlSchema('series:1'),
      jsonlData('series:1', '2026-06-07T19:20:00Z', '1'),
      jsonlStatus('series:1', true),
    ].join('\n');
    const finalJsonl = [
      jsonlData('series:1', '2026-06-07T19:20:00Z', '10'),
      jsonlData('series:1', '2026-06-07T19:21:00Z', '2'),
      jsonlStatus('series:1', false),
    ].join('\n');
    global.fetch = jest.fn().mockResolvedValue({
      body: readableBody([
        concatBytes(
          responseHeaderFrame(),
          frame(partialJsonl, 0, PAYLOAD_ENCODING_IDENTITY, PAYLOAD_TYPE_JSONL),
          frame(finalJsonl, FINAL_BATCH_FLAG, PAYLOAD_ENCODING_IDENTITY, PAYLOAD_TYPE_JSONL)
        ),
      ]),
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
        httpMethod: 'GET',
      })
    );

    const fetchInit = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(fetchInit.method).toBe('POST');
    expect(fetchInit.headers).toEqual(
      expect.objectContaining({
        Accept: MULTIBATCH_ACCEPT_HEADER,
        'Content-Type': 'application/json',
      })
    );
    expect(fetchInit.headers).not.toHaveProperty('X-Grafana-Query-Format');
    expect(toDataQueryResponseMock).not.toHaveBeenCalled();
    expect(responses.map((response) => response.state)).toEqual([LoadingState.Streaming, LoadingState.Done]);
    expect(responses[0].data[0].length).toBe(1);
    expect(responses[0].data[0].fields[0].values).toEqual([Date.parse('2026-06-07T19:20:00Z')]);
    expect(responses[0].data[0].fields[1].values).toEqual([1]);
    expect(responses[0].data[0].fields[1].config.displayNameFromDS).toBe('api');
    expect(responses[1].data[0].length).toBe(2);
    expect(responses[1].data[0].fields[0].values).toEqual([
      Date.parse('2026-06-07T19:20:00Z'),
      Date.parse('2026-06-07T19:21:00Z'),
    ]);
    expect(responses[1].data[0].fields[1].values).toEqual([10, 2]);
  });

  it('keeps non-ASCII legend formats in the JSON body instead of browser headers', async () => {
    const legendFormat =
      '[{{app}}] in [{{cluster_short_name}}] ➡️ [{{oai_sd_target_service}}] in [{{oai_sd_routed_to}}] via {{route_type}}';
    const target: PromQuery = { expr: 'up', legendFormat, refId: 'A' };
    const request = requestForTarget(target);
    global.fetch = jest.fn().mockResolvedValue({
      body: readableBody([concatBytes(responseHeaderFrame(), frame('final', FINAL_BATCH_FLAG))]),
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? `${MULTIBATCH_PREFERRED_CONTENT_TYPE}; version=1` : null,
      },
      ok: true,
      text: jest.fn(),
    });

    await collectResponses(
      queryPrometheusMultiBatch('prometheus', request, target, {
        customQueryParameters: new URLSearchParams(),
        httpMethod: 'POST',
      })
    );

    const fetchInit = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(() => new Headers(fetchInit.headers)).not.toThrow();
    expect(fetchInit.headers).not.toHaveProperty('X-Grafana-Prometheus-Multibatch-Legend-Format');
    expect(fetchInit.headers).not.toHaveProperty('X-Grafana-Prometheus-Multibatch-Legend-Format-Encoding');
    expect(JSON.parse(fetchInit.body).queries[0].legendFormat).toBe(legendFormat);
  });

  it('emits a non-compact JSONL partial response before the final frame arrives', async () => {
    const target: PromQuery = { expr: 'up', refId: 'A' };
    const request = requestForTarget(target, false);
    const partialJsonl = [jsonlSchema('series:1'), jsonlData('series:1', '0', '1')].join('\n');
    const finalJsonl = [jsonlData('series:1', '60', '2')].join('\n');
    let resolveFinalFrame: (chunk: Uint8Array) => void = () => {};
    const finalFrame = new Promise<Uint8Array>((resolve) => {
      resolveFinalFrame = resolve;
    });
    global.fetch = jest.fn().mockResolvedValue({
      body: readableAsyncBody([
        concatBytes(responseHeaderFrame(), frame(partialJsonl, 0, PAYLOAD_ENCODING_IDENTITY, PAYLOAD_TYPE_JSONL)),
        finalFrame,
      ]),
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? `${MULTIBATCH_PREFERRED_CONTENT_TYPE}; version=1` : null,
      },
      ok: true,
      text: jest.fn(),
    });

    const responses: DataQueryResponse[] = [];
    const completion = new Promise<void>((resolve, reject) => {
      queryPrometheusMultiBatch('prometheus', request, target, {
        customQueryParameters: new URLSearchParams(),
        httpMethod: 'POST',
      }).subscribe({
        complete: resolve,
        error: reject,
        next: (response) => responses.push(response),
      });
    });

    await waitForResponses(responses, 1);
    expect(responses).toHaveLength(1);
    expect(responses[0].state).toBe(LoadingState.Streaming);
    expect(responses[0].data[0].length).toBe(1);
    expect(responses[0].data[0].fields[1].values).toEqual([1]);

    resolveFinalFrame(frame(finalJsonl, FINAL_BATCH_FLAG, PAYLOAD_ENCODING_IDENTITY, PAYLOAD_TYPE_JSONL));
    await completion;
    expect(responses).toHaveLength(2);
    expect(responses[1].state).toBe(LoadingState.Done);
    expect(responses[1].data[0].length).toBe(2);
    expect(responses[1].data[0].fields[1].values).toEqual([1, 2]);
  });

  it('surfaces non-compact multibatch plain text error payloads without parsing them as JSONL', async () => {
    const target: PromQuery = { expr: 'up', refId: 'A' };
    const request = requestForTarget(target, false);
    const text = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({
      body: readableBody([
        concatBytes(
          responseHeaderFrame(),
          frame('local_rate_limited', FINAL_BATCH_FLAG, PAYLOAD_ENCODING_IDENTITY, PAYLOAD_TYPE_JSONL)
        ),
      ]),
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? `${MULTIBATCH_PREFERRED_CONTENT_TYPE}; version=1` : null,
      },
      ok: false,
      status: 429,
      text,
    });

    const responses = await collectResponses(
      queryPrometheusMultiBatch('prometheus', request, target, {
        customQueryParameters: new URLSearchParams(),
        httpMethod: 'POST',
      })
    );

    expect(text).not.toHaveBeenCalled();
    expect(responses).toHaveLength(1);
    expect(responses[0].state).toBe(LoadingState.Done);
    expect(responses[0].error?.message).toBe('local_rate_limited');
  });

  it('surfaces non-compact multibatch JSON error payloads as response errors', async () => {
    const target: PromQuery = { expr: 'up', refId: 'A' };
    const request = requestForTarget(target, false);
    global.fetch = jest.fn().mockResolvedValue({
      body: readableBody([
        concatBytes(
          responseHeaderFrame(),
          frame(
            JSON.stringify({ error: { message: '401: Unauthorized', type: 'invalid_request_error' } }),
            FINAL_BATCH_FLAG,
            PAYLOAD_ENCODING_IDENTITY,
            PAYLOAD_TYPE_JSONL
          )
        ),
      ]),
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? `${MULTIBATCH_PREFERRED_CONTENT_TYPE}; version=1` : null,
      },
      ok: false,
      status: 401,
      text: jest.fn(),
    });

    const responses = await collectResponses(
      queryPrometheusMultiBatch('prometheus', request, target, {
        customQueryParameters: new URLSearchParams(),
        httpMethod: 'POST',
      })
    );

    expect(responses).toHaveLength(1);
    expect(responses[0].state).toBe(LoadingState.Done);
    expect(responses[0].error?.message).toBe('401: Unauthorized');
  });

  it('rejects successful JSONL payload frames for compact-v1 requests', async () => {
    const target: PromQuery = { expr: 'up', refId: 'A' };
    const request = requestForTarget(target);
    const queryResponse = JSON.stringify({
      results: {
        A: {
          frames: [
            {
              schema: {
                fields: [
                  { name: 'Time', type: 'time' },
                  { name: 'Value', type: 'number' },
                ],
              },
              data: { values: [[0], [1]] },
            },
          ],
        },
      },
    });
    global.fetch = jest.fn().mockResolvedValue({
      body: readableBody([
        concatBytes(
          responseHeaderFrame(),
          frame(queryResponse, FINAL_BATCH_FLAG, PAYLOAD_ENCODING_IDENTITY, PAYLOAD_TYPE_JSONL)
        ),
      ]),
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? `${MULTIBATCH_PREFERRED_CONTENT_TYPE}; version=1` : null,
      },
      ok: true,
      text: jest.fn(),
    });

    await expect(
      collectResponses(
        queryPrometheusMultiBatch('prometheus', request, target, {
          customQueryParameters: new URLSearchParams(),
          httpMethod: 'POST',
        })
      )
    ).rejects.toThrow(/compact-v1 request returned a successful JSONL payload/);
  });

  it('decodes zstd non-compact JSONL payload frames', async () => {
    const target: PromQuery = { expr: 'up', refId: 'A' };
    const request = requestForTarget(target, false);
    const jsonl = [jsonlSchema('series:1'), jsonlData('series:1', '60', '2')].join('\n');
    global.fetch = jest.fn().mockResolvedValue({
      body: readableBody([
        concatBytes(
          responseHeaderFrame(),
          frame(zstdPayload(jsonl), FINAL_BATCH_FLAG, PAYLOAD_ENCODING_ZSTD, PAYLOAD_TYPE_JSONL)
        ),
      ]),
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

    expect(responses).toHaveLength(1);
    expect(responses[0].data[0].length).toBe(1);
    expect(responses[0].data[0].fields[0].values).toEqual([60000]);
    expect(responses[0].data[0].fields[1].values).toEqual([2]);
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

  it('decodes a non-multibatch non-compact Prometheus fallback response', async () => {
    const target: PromQuery = { expr: 'up', legendFormat: '{{job}}', refId: 'A' };
    const request = requestForTarget(target, false);
    global.fetch = jest.fn().mockResolvedValue({
      arrayBuffer: jest.fn().mockResolvedValue(
        new TextEncoder().encode(
          JSON.stringify({
            status: 'success',
            data: {
              resultType: 'matrix',
              result: [{ metric: { job: 'api' }, values: [[0, '1']] }],
            },
          })
        ).buffer
      ),
      body: null,
      headers: new Headers({ 'content-type': 'application/json' }),
      ok: true,
      text: jest.fn(),
    });

    const responses = await collectResponses(
      queryPrometheusMultiBatch('prometheus', request, target, {
        customQueryParameters: new URLSearchParams(),
        httpMethod: 'POST',
      })
    );

    expect(toDataQueryResponseMock).not.toHaveBeenCalled();
    expect(responses.map((response) => response.state)).toEqual([LoadingState.Done]);
    expect(responses[0].data[0].fields[0].values).toEqual([0]);
    expect(responses[0].data[0].fields[1].values).toEqual([1]);
  });

  it('rejects a successful non-multibatch JSON fallback for a compact dashboard request', async () => {
    const target: PromQuery = { expr: 'up', legendFormat: '{{job}}', refId: 'A' };
    const request = requestForTarget(target);
    global.fetch = jest.fn().mockResolvedValue({
      arrayBuffer: jest.fn().mockResolvedValue(
        new TextEncoder().encode(
          JSON.stringify({
            status: 'success',
            data: {
              resultType: 'matrix',
              result: [{ metric: { job: 'api' }, values: [[0, '1']] }],
            },
          })
        ).buffer
      ),
      body: null,
      headers: new Headers({ 'content-type': 'application/json' }),
      ok: true,
      text: jest.fn(),
    });

    await expect(
      collectResponses(
        queryPrometheusMultiBatch('prometheus', request, target, {
          customQueryParameters: new URLSearchParams(),
          httpMethod: 'POST',
        })
      )
    ).rejects.toThrow(/compact-v1 request returned a successful JSONL payload/);
  });

  it('preserves Prometheus warnings and infos on decoded API payload frames', async () => {
    const target: PromQuery = { expr: 'up', refId: 'A' };
    const request = requestForTarget(target, false);
    global.fetch = jest.fn().mockResolvedValue({
      body: readableBody([
        concatBytes(
          responseHeaderFrame(),
          frame(
            JSON.stringify({
              status: 'success',
              warnings: ['partial data'],
              infos: ['query used cache'],
              data: {
                resultType: 'matrix',
                result: [{ metric: { job: 'api' }, values: [[0, '1']] }],
              },
            }),
            FINAL_BATCH_FLAG,
            PAYLOAD_ENCODING_IDENTITY,
            PAYLOAD_TYPE_JSONL
          )
        ),
      ]),
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

    expect(responses[0].data[0].meta?.notices).toEqual([
      { severity: 'warning', text: 'partial data' },
      { severity: 'info', text: 'query used cache' },
    ]);
  });

  it('decodes native histogram samples into heatmap-cell frames', async () => {
    const target: PromQuery = { expr: 'native_histogram', refId: 'A' };
    const request = requestForTarget(target, false);
    global.fetch = jest.fn().mockResolvedValue({
      body: readableBody([
        concatBytes(
          responseHeaderFrame(),
          frame(
            JSON.stringify({
              status: 'success',
              data: {
                resultType: 'matrix',
                result: [
                  {
                    metric: { job: 'api' },
                    histograms: [
                      [
                        60,
                        {
                          buckets: [
                            [0, '0', '1', '2'],
                            [0, '1', '2', '3'],
                          ],
                        },
                      ],
                    ],
                  },
                ],
              },
            }),
            FINAL_BATCH_FLAG,
            PAYLOAD_ENCODING_IDENTITY,
            PAYLOAD_TYPE_JSONL
          )
        ),
      ]),
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

    expect(responses[0].data[0].meta?.type).toBe(DataFrameType.HeatmapCells);
    expect(responses[0].data[0].fields.map((field: { name: string }) => field.name)).toEqual([
      'xMax',
      'yMin',
      'yMax',
      'count',
      'yLayout',
    ]);
    expect(responses[0].data[0].fields[0].values).toEqual([60000, 60000]);
    expect(responses[0].data[0].fields[3].values).toEqual([2, 3]);
  });

  it('decodes non-OK multibatch compact responses instead of reading binary as text', async () => {
    const target: PromQuery = { expr: 'bad promql', refId: 'A' };
    const request = requestForTarget(target);
    const text = jest.fn();
    const responseHeader = responseHeaderFrame();
    global.fetch = jest.fn().mockResolvedValue({
      body: readableBody([
        responseHeader.subarray(0, 2),
        responseHeader.subarray(2),
        frame('query-error', FINAL_BATCH_FLAG),
      ]),
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? `${MULTIBATCH_PREFERRED_CONTENT_TYPE}; version=1` : null,
      },
      ok: false,
      text,
    });

    const responses = await collectResponses(
      queryPrometheusMultiBatch('prometheus', request, target, {
        customQueryParameters: new URLSearchParams(),
        httpMethod: 'POST',
      })
    );

    expect(text).not.toHaveBeenCalled();
    expect(responses.map((response) => response.compactSeries)).toEqual([{ payload: 'query-error' }]);
    expect(responses.map((response) => response.state)).toEqual([LoadingState.Done]);
  });

  it('surfaces mislabeled non-OK multibatch responses as response errors', async () => {
    const target: PromQuery = { expr: 'up', refId: 'A' };
    const request = requestForTarget(target);
    global.fetch = jest.fn().mockResolvedValue({
      body: readableBody([new TextEncoder().encode('{"message":"context canceled"}')]),
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? `${MULTIBATCH_PREFERRED_CONTENT_TYPE}; version=1` : null,
      },
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: jest.fn(),
    });

    await expect(
      collectResponses(
        queryPrometheusMultiBatch('prometheus', request, target, {
          customQueryParameters: new URLSearchParams(),
          httpMethod: 'POST',
        })
      )
    ).rejects.toThrow('context canceled');
  });

  it('sends interval inputs in the structured query envelope for backend calculation', async () => {
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

    const requestBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(requestBody).toEqual({
      from: '10500',
      to: '131000',
      queries: [
        expect.objectContaining({
          datasource: { uid: 'prometheus' },
          expr: 'up',
          intervalFactor: 10,
          intervalMs: 60000,
          maxDataPoints: AUTO_STEP_SIZE_FALLBACK_MAX_DATA_POINTS,
          stepSize: '2m',
        }),
      ],
    });
  });

  it('leaves explicit target step sizes in the structured query envelope', async () => {
    const target: PromQuery = {
      expr: 'up',
      refId: 'A',
      stepSize: '1m',
    };
    const request = {
      ...requestForTarget(target),
      interval: '1m',
      intervalMs: 60000,
      maxDataPoints: 10_000,
      range: {
        from: dateTime(0),
        to: dateTime(48 * 60 * 60 * 1000),
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
      })
    );

    const requestBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(requestBody).toEqual({
      from: '0',
      to: String(48 * 60 * 60 * 1000),
      queries: [
        expect.objectContaining({
          datasource: { uid: 'prometheus' },
          expr: 'up',
          intervalMs: 60000,
          maxDataPoints: 10_000,
          stepSize: '1m',
        }),
      ],
    });
  });
});

function requestForTarget(target: PromQuery, preferredCompact = true): DataQueryRequest<PromQuery> {
  return {
    interval: '1m',
    intervalMs: 60000,
    preferredQueryResultFormat: preferredCompact ? 'compact-v1' : undefined,
    range: {
      from: dateTime(0),
      to: dateTime(10_000),
    },
    scopedVars: {},
    targets: [target],
  } as DataQueryRequest<PromQuery>;
}

function jsonlSchema(frameKey: string): string {
  return JSON.stringify({
    type: 'schema',
    frame: frameKey,
    columns: [
      { name: 'time', type: 'time' },
      { name: 'value', type: 'number', labels: { job: 'api' } },
    ],
  });
}

function jsonlData(frameKey: string, time: string, value: string): string {
  return JSON.stringify({
    type: 'data',
    frame: frameKey,
    data: [time, value],
  });
}

function jsonlStatus(frameKey: string, isIncomplete: boolean): string {
  return JSON.stringify({
    type: 'status',
    frame: frameKey,
    data: { isIncomplete },
  });
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
  payload: string | Uint8Array,
  flags = FINAL_BATCH_FLAG,
  encoding = PAYLOAD_ENCODING_IDENTITY,
  payloadType = PAYLOAD_TYPE_COMPACT_V1,
  magic = 'MBBF'
): Uint8Array {
  const payloadBytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
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

function zstdPayload(payload: string): Uint8Array {
  const payloadBytes = new TextEncoder().encode(payload);
  if (payloadBytes.byteLength > 255) {
    throw new Error('test helper only supports one-byte zstd content sizes');
  }

  const bytes = new Uint8Array(6 + payloadBytes.byteLength);
  bytes.set([0x28, 0xb5, 0x2f, 0xfd], 0);
  bytes[4] = 0x20;
  bytes[5] = payloadBytes.byteLength;
  bytes.set(payloadBytes, 6);
  return bytes;
}

function zstdPayloadWithoutContentSize(payload: string): Uint8Array {
  const payloadBytes = new TextEncoder().encode(payload);
  const bytes = new Uint8Array(6 + payloadBytes.byteLength);
  bytes.set([0x28, 0xb5, 0x2f, 0xfd], 0);
  bytes[4] = 0x00;
  bytes[5] = 0x00;
  bytes.set(payloadBytes, 6);
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

function readableAsyncBody(chunks: Array<Uint8Array | Promise<Uint8Array>>): ReadableStream<Uint8Array> {
  let index = 0;
  return {
    getReader() {
      return {
        read: async () => {
          if (index >= chunks.length) {
            return { done: true, value: undefined };
          }

          const value = await chunks[index++];
          return { done: false, value };
        },
        releaseLock: jest.fn(),
      };
    },
  } as unknown as ReadableStream<Uint8Array>;
}

async function waitForResponses(responses: DataQueryResponse[], count: number) {
  const start = Date.now();
  while (responses.length < count) {
    if (Date.now() - start > 1000) {
      throw new Error(`Timed out waiting for ${count} responses; received ${responses.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
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
