import { FetchError, FetchResponse } from 'src/services';

import { type CompactTimeSeriesSeries, DataQuery, toDataFrameDTO, DataFrame } from '@grafana/data';

import {
  BackendDataSourceResponse,
  cachedResponseNotice,
  QUERY_DATA_COMPACT_MEDIA_TYPE,
  toDataQueryResponse,
  toTestingStatus,
} from './queryResponse';

const resp = {
  data: {
    results: {
      A: {
        frames: [
          {
            schema: {
              refId: 'A',
              fields: [
                { name: 'time', type: 'time', typeInfo: { frame: 'time.Time', nullable: true } },
                { name: 'A-series', type: 'number', typeInfo: { frame: 'float64', nullable: true } },
              ],
            },
            data: {
              values: [
                [1611767228473, 1611767240473, 1611767252473, 1611767264473, 1611767276473, 1611767288473],
                [1, 20, 90, 30, 5, 0],
              ],
            },
          },
        ],
      },
      B: {
        frames: [
          {
            schema: {
              refId: 'B',
              fields: [
                { name: 'time', type: 'time', typeInfo: { frame: 'time.Time', nullable: true } },
                { name: 'B-series', type: 'number', typeInfo: { frame: 'float64', nullable: true } },
              ],
            },
            data: {
              values: [
                [1611767228473, 1611767240473, 1611767252473, 1611767264473, 1611767276473, 1611767288473],
                [1, 20, 90, 30, 5, 0],
              ],
            },
          },
        ],
      },
    },
  },
} as unknown as FetchResponse<BackendDataSourceResponse>;

const resWithError = {
  data: {
    results: {
      A: {
        error: 'Hello Error',
        status: 400,
        frames: [
          {
            schema: {
              fields: [{ name: 'numbers', type: 'number' }],
              meta: {
                notices: [
                  {
                    severity: 2,
                    text: 'Text',
                  },
                ],
              },
            },
            data: {
              values: [[1, 3]],
            },
          },
        ],
      },
    },
  },
} as unknown as FetchResponse<BackendDataSourceResponse>;

const emptyResults = {
  data: { results: { '': { refId: '' } } },
};

type CompactTestAxis = [start: number, step: number, count: number];

interface CompactTestFrame {
  name: string;
  refId?: string;
  frameName?: string;
  displayNameFromDS?: string;
  labels?: Record<string, string>;
  axis?: number;
  values: number[];
  positions?: number[];
  bitmap?: Uint8Array;
}

interface CompactTestResult {
  status?: number;
  error?: string;
  executedQueryString?: string;
  calculatedMinStep?: number;
  notices?: Array<{
    severity: 'info' | 'warning' | 'error';
    text: string;
    link?: string;
    inspect?: 'meta' | 'error' | 'data' | 'stats';
  }>;
  frames: CompactTestFrame[];
}

function compactTestFrame(name: string, values: number[], positions?: number[]): CompactTestFrame {
  return { name, values, positions };
}

function makeCompactResponse(input: {
  axes: CompactTestAxis[];
  results: Record<string, CompactTestResult>;
}): ArrayBuffer {
  const strings = [''];
  const stringIDs = new Map([['', 0]]);
  const intern = (value = '') => {
    const existing = stringIDs.get(value);
    if (existing != null) {
      return existing;
    }
    const id = strings.length;
    strings.push(value);
    stringIDs.set(value, id);
    return id;
  };
  const sortedResults = Object.entries(input.results).sort(([a], [b]) => a.localeCompare(b));
  for (const [refId, result] of sortedResults) {
    intern(refId);
    intern(result.error);
    intern(result.executedQueryString);
    for (const notice of result.notices ?? []) {
      intern(notice.text);
      intern(notice.link);
    }
    for (const frame of result.frames) {
      intern(frame.frameName);
      intern(frame.refId ?? refId);
      intern(frame.name);
      intern(frame.displayNameFromDS);
      for (const [name, value] of Object.entries(frame.labels ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        intern(name);
        intern(value);
      }
    }
  }

  const encodedStrings = strings.map((value) => new TextEncoder().encode(value));
  const stringBytesLength = encodedStrings.reduce((length, value) => length + value.length, 0);
  const writer = new CompactTestWriter();
  writer.writeBytes(new TextEncoder().encode('GQD1'));
  writer.writeUint16(1);
  writer.writeUint16(0);
  writer.writeUint32(input.axes.length);
  writer.writeUint32(sortedResults.length);
  writer.writeUint32(strings.length);
  writer.writeUint32(stringBytesLength);
  writer.writeUint64(0);

  for (const [start, step, count] of input.axes) {
    writer.writeInt64(start);
    writer.writeUint64(step);
    writer.writeUint32(count);
    writer.writeUint32(0);
  }

  let stringOffset = 0;
  for (const value of encodedStrings) {
    writer.writeUint32(stringOffset);
    writer.writeUint32(value.length);
    stringOffset += value.length;
  }
  for (const value of encodedStrings) {
    writer.writeBytes(value);
  }
  writer.align8();

  for (const [refId, result] of sortedResults) {
    const resultWriter = new CompactTestWriter();
    const resultLengthOffset = resultWriter.length;
    resultWriter.writeUint32(0);
    resultWriter.writeUint32(intern(refId));
    resultWriter.writeUint32(intern(result.error));
    resultWriter.writeUint32(intern(result.executedQueryString));
    resultWriter.writeInt32(result.status ?? 0);
    resultWriter.writeUint32(result.frames.length);
    resultWriter.writeInt64(result.calculatedMinStep ?? 0);
    resultWriter.writeUint16(result.frames.length > 0 ? 1 : 0);
    resultWriter.writeUint16(result.frames.length > 0 ? 1 : 0);
    resultWriter.writeUint16(result.frames.length > 0 ? 0 : 0);
    resultWriter.writeUint16(result.frames.length > 0 ? 1 : 0);
    resultWriter.writeUint32(result.calculatedMinStep ? 1 : 0);
    resultWriter.writeUint32(result.notices?.length ?? 0);

    for (const notice of result.notices ?? []) {
      resultWriter.writeUint32(intern(notice.text));
      resultWriter.writeUint32(intern(notice.link));
      resultWriter.writeUint8({ info: 0, warning: 1, error: 2 }[notice.severity]);
      resultWriter.writeUint8(notice.inspect == null ? 0 : { meta: 1, error: 2, data: 3, stats: 4 }[notice.inspect]);
      resultWriter.writeUint16(0);
      resultWriter.writeUint32(0);
    }

    for (const frame of result.frames) {
      const axisID = frame.axis ?? 0;
      const axis = input.axes[axisID];
      const frameWriter = new CompactTestWriter();
      const frameLengthOffset = frameWriter.length;
      frameWriter.writeUint32(0);
      const positions = frame.positions ?? Array.from({ length: axis[2] }, (_, index) => index);
      let bitmap = frame.bitmap;
      if (!bitmap && positions.length !== axis[2]) {
        bitmap = new Uint8Array(Math.ceil(axis[2] / 8));
        for (const position of positions) {
          bitmap[position >> 3] |= 1 << (position & 7);
        }
      }
      frameWriter.writeUint32(axisID);
      frameWriter.writeUint32(frame.values.length);
      frameWriter.writeUint32(bitmap?.length ?? 0);
      frameWriter.writeUint32(intern(frame.frameName));
      frameWriter.writeUint32(intern(frame.refId ?? refId));
      frameWriter.writeUint32(intern(frame.name));
      frameWriter.writeUint32(intern(frame.displayNameFromDS));
      const labels = Object.entries(frame.labels ?? {}).sort(([a], [b]) => a.localeCompare(b));
      frameWriter.writeUint32(labels.length);
      frameWriter.writeUint32(0);
      frameWriter.writeUint64(0);
      for (const [name, value] of labels) {
        frameWriter.writeUint32(intern(name));
        frameWriter.writeUint32(intern(value));
      }
      if (bitmap) {
        frameWriter.writeBytes(bitmap);
      }
      frameWriter.align8();
      for (const value of frame.values) {
        frameWriter.writeFloat64(value);
      }
      frameWriter.setUint32(frameLengthOffset, frameWriter.length);
      resultWriter.writeBytes(frameWriter.toUint8Array());
    }

    resultWriter.setUint32(resultLengthOffset, resultWriter.length);
    writer.writeBytes(resultWriter.toUint8Array());
  }

  return writer.toArrayBuffer();
}

class CompactTestWriter {
  private bytes: number[] = [];

  get length() {
    return this.bytes.length;
  }

  writeBytes(values: Uint8Array) {
    this.bytes.push(...values);
  }

  writeUint16(value: number) {
    this.writeNumber(2, (view) => view.setUint16(0, value, true));
  }

  writeUint8(value: number) {
    this.bytes.push(value);
  }

  writeUint32(value: number) {
    this.writeNumber(4, (view) => view.setUint32(0, value, true));
  }

  writeInt32(value: number) {
    this.writeNumber(4, (view) => view.setInt32(0, value, true));
  }

  writeUint64(value: number) {
    this.writeNumber(8, (view) => view.setBigUint64(0, BigInt(value), true));
  }

  writeInt64(value: number) {
    this.writeNumber(8, (view) => view.setBigInt64(0, BigInt(value), true));
  }

  writeFloat64(value: number) {
    this.writeNumber(8, (view) => view.setFloat64(0, value, true));
  }

  align8() {
    while (this.bytes.length % 8 !== 0) {
      this.bytes.push(0);
    }
  }

  setUint32(offset: number, value: number) {
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setUint32(0, value, true);
    this.bytes.splice(offset, 4, ...new Uint8Array(buffer));
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }

  toArrayBuffer(): ArrayBuffer {
    const bytes = this.toUint8Array();
    const buffer = new ArrayBuffer(bytes.length);
    new Uint8Array(buffer).set(bytes);
    return buffer;
  }

  private writeNumber(size: number, write: (view: DataView) => void) {
    const buffer = new ArrayBuffer(size);
    write(new DataView(buffer));
    this.writeBytes(new Uint8Array(buffer));
  }
}

describe('Query Response parser', () => {
  test('parses an explicit JSON fallback when compact was requested', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(resp.data));
    const fallback = {
      data: bytes.buffer,
      headers: new Headers({ 'content-type': 'application/json' }),
    } as unknown as FetchResponse<ArrayBuffer>;

    const response = toDataQueryResponse(fallback, undefined, true);

    expect(response.compactSeries).toBeUndefined();
    expect(response.data).toHaveLength(2);
  });

  test('rejects a compact fallback without an explicit JSON media type', () => {
    expect(() => toDataQueryResponse(resp, undefined, true)).toThrow(
      `Expected ${QUERY_DATA_COMPACT_MEDIA_TYPE} or application/json fallback response`
    );
  });

  test('should parse output with dataframe', () => {
    const res = toDataQueryResponse(resp);
    const frames = res.data;
    expect(frames).toHaveLength(2);
    expect(frames[0].refId).toEqual('A');
    expect(frames[1].refId).toEqual('B');

    const norm = frames.map((f) => toDataFrameDTO(f));
    expect(norm).toMatchInlineSnapshot(`
      [
        {
          "fields": [
            {
              "config": {},
              "labels": undefined,
              "name": "time",
              "type": "time",
              "values": [
                1611767228473,
                1611767240473,
                1611767252473,
                1611767264473,
                1611767276473,
                1611767288473,
              ],
            },
            {
              "config": {},
              "labels": undefined,
              "name": "A-series",
              "type": "number",
              "values": [
                1,
                20,
                90,
                30,
                5,
                0,
              ],
            },
          ],
          "meta": undefined,
          "name": undefined,
          "refId": "A",
        },
        {
          "fields": [
            {
              "config": {},
              "labels": undefined,
              "name": "time",
              "type": "time",
              "values": [
                1611767228473,
                1611767240473,
                1611767252473,
                1611767264473,
                1611767276473,
                1611767288473,
              ],
            },
            {
              "config": {},
              "labels": undefined,
              "name": "B-series",
              "type": "number",
              "values": [
                1,
                20,
                90,
                30,
                5,
                0,
              ],
            },
          ],
          "meta": undefined,
          "name": undefined,
          "refId": "B",
        },
      ]
    `);
  });

  test('keeps compact axes, bitmaps, and values buffer-backed without creating data frames', () => {
    const compactResponse = {
      data: makeCompactResponse({
        axes: [[0, 1000, 5]],
        results: {
          A: {
            notices: [{ severity: 'warning', text: 'Partial response', link: '/inspect', inspect: 'stats' }],
            frames: [
              compactTestFrame('A-series', [1, 2, 3, 4, 5]),
              { ...compactTestFrame('B-series', [0, NaN, Infinity], [0, 2, 4]), labels: { host: 'a' } },
            ],
          },
        },
      }),
      headers: new Headers({ 'content-type': QUERY_DATA_COMPACT_MEDIA_TYPE }),
    } as unknown as FetchResponse<ArrayBuffer>;

    const response = toDataQueryResponse(compactResponse, undefined, true);
    const compact = response.compactSeries!;
    if (Array.isArray(compact.series)) {
      throw new Error('Expected decoded compact series to use column storage');
    }
    const columnSeries = compact.series as Exclude<typeof compact.series, readonly CompactTimeSeriesSeries[]>;
    const firstSeries = columnSeries.get(0);
    const secondSeries = columnSeries.get(1);

    expect(response.data).toEqual([]);
    expect(compact.axes).toEqual([{ start: 0, step: 1000, count: 5 }]);
    expect(compact.notices).toEqual([
      {
        refId: 'A',
        severity: 'warning',
        text: 'Partial response',
        link: '/inspect',
        inspect: 'stats',
      },
    ]);
    expect(compact.series).toHaveLength(2);
    expect(secondSeries).toMatchObject({
      refId: 'A',
      valueName: 'B-series',
      axisId: 0,
      presentCount: 3,
    });
    expect(secondSeries).not.toHaveProperty('labels');
    expect(secondSeries).not.toHaveProperty('presence');
    expect(columnSeries.getRefId(1)).toBe('A');
    expect(columnSeries.getValueName(1)).toBe('B-series');
    expect(columnSeries.getLabel(1, 'host')).toBe('a');
    const indexedLabels: Record<string, string> = {};
    columnSeries.forEachLabel(1, (name, value) => (indexedLabels[name] = value));
    expect(indexedLabels).toEqual({ host: 'a' });
    expect(compact.metadata.materializeLabels(secondSeries)).toEqual({ host: 'a' });
    expect(columnSeries.columns.axisIds).toEqual(new Uint32Array([0, 0]));
    expect(columnSeries.columns.presentCounts).toEqual(new Uint32Array([5, 3]));
    expect(new Uint8Array(compact.buffer, secondSeries.presenceByteOffset, secondSeries.presenceByteLength)).toEqual(
      new Uint8Array([0b00010101])
    );
    expect(new Float64Array(compact.buffer, firstSeries.valuesByteOffset, 5)).toEqual(
      new Float64Array([1, 2, 3, 4, 5])
    );
    expect(new Float64Array(compact.buffer, secondSeries.valuesByteOffset, 3)).toEqual(
      new Float64Array([0, NaN, Infinity])
    );
    expect(compact.decodeStats).toMatchObject({ responseBytes: compact.buffer.byteLength, seriesCount: 2 });
  });

  test('reorders and filters compact results without expanding the typed columns', () => {
    const compactResponse = {
      data: makeCompactResponse({
        axes: [[0, 1000, 1]],
        results: {
          A: { frames: [compactTestFrame('A-series', [1])] },
          B: { frames: [compactTestFrame('B-series', [2])] },
        },
      }),
      headers: new Headers({ 'content-type': QUERY_DATA_COMPACT_MEDIA_TYPE }),
    } as unknown as FetchResponse<ArrayBuffer>;

    const response = toDataQueryResponse(compactResponse, [{ refId: 'B' }, { refId: 'A' }], true);
    const series = response.compactSeries!.series;
    if (Array.isArray(series)) {
      throw new Error('Expected decoded compact series to use column storage');
    }
    const columnSeries = series as Exclude<typeof series, readonly CompactTimeSeriesSeries[]>;

    expect([...columnSeries].map((item) => item.refId)).toEqual(['B', 'A']);
    expect(columnSeries.resolveColumnIndex(0)).toBe(1);
    expect(columnSeries.take(1).get(0).valueName).toBe('B-series');
    expect(columnSeries.take(1).columns).toBe(columnSeries.columns);
    expect(columnSeries.take(2)).toBe(columnSeries);
    expect(columnSeries.filter((item) => item.refId === 'A').get(0).valueName).toBe('A-series');
    expect(columnSeries.columns.presentCounts).toEqual(new Uint32Array([1, 1]));
  });

  test('accepts compact content-type parameters', () => {
    const compactResponse = {
      data: makeCompactResponse({ axes: [], results: { A: { frames: [] } } }),
      headers: new Headers({ 'content-type': `${QUERY_DATA_COMPACT_MEDIA_TYPE}; charset=binary` }),
    } as unknown as FetchResponse<ArrayBuffer>;

    expect(toDataQueryResponse(compactResponse, undefined, true).data).toEqual([]);
  });

  test('rejects compact content when the request did not opt in', () => {
    const compactResponse = {
      data: makeCompactResponse({ axes: [], results: { A: { frames: [] } } }),
      headers: new Headers({ 'content-type': QUERY_DATA_COMPACT_MEDIA_TYPE }),
    } as unknown as FetchResponse<ArrayBuffer>;

    expect(() => toDataQueryResponse(compactResponse)).toThrow('unexpected compact query response');
  });

  test('decodes a JSON ArrayBuffer on the legacy path', () => {
    const encoded = new TextEncoder().encode(JSON.stringify(resp.data));
    const response = toDataQueryResponse({
      data: encoded.buffer,
      headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
    });

    expect(response.data).toHaveLength(2);
    expect(response.data.map((frame) => frame.refId)).toEqual(['A', 'B']);
  });

  test('does not impose an arbitrary compact axis-point cap', () => {
    const compactResponse = {
      data: makeCompactResponse({ axes: [[1000, 1000, 5_000_001]], results: {} }),
      headers: new Headers({ 'content-type': QUERY_DATA_COMPACT_MEDIA_TYPE }),
    } as unknown as FetchResponse<ArrayBuffer>;

    expect(() => toDataQueryResponse(compactResponse, undefined, true)).not.toThrow();
  });

  test('rejects compact frame bitmaps that do not match the value count', () => {
    const compactResponse = {
      data: makeCompactResponse({
        axes: [[1000, 1000, 3]],
        results: {
          A: {
            frames: [
              {
                ...compactTestFrame('A-series', [1, 2], [0, 2]),
                bitmap: new Uint8Array([0b00000001]),
              },
            ],
          },
        },
      }),
      headers: new Headers({ 'content-type': QUERY_DATA_COMPACT_MEDIA_TYPE }),
    } as unknown as FetchResponse<ArrayBuffer>;

    expect(() => toDataQueryResponse(compactResponse, undefined, true)).toThrow('Invalid compact query response');
  });

  test('rejects invalid UTF-8 before exposing a compact response', () => {
    const buffer = makeCompactResponse({
      axes: [[0, 1000, 1]],
      results: { A: { frames: [compactTestFrame('series', [1])] } },
    });
    const view = new DataView(buffer);
    const stringCount = view.getUint32(16, true);
    const stringRecordsOffset = 32 + 24;
    const stringBytesOffset = stringRecordsOffset + stringCount * 8;
    new Uint8Array(buffer)[stringBytesOffset] = 0xff;

    const compactResponse = {
      data: buffer,
      headers: new Headers({ 'content-type': QUERY_DATA_COMPACT_MEDIA_TYPE }),
    } as unknown as FetchResponse<ArrayBuffer>;

    expect(() => toDataQueryResponse(compactResponse, undefined, true)).toThrow('Invalid compact query response');
  });

  test('decodes compact query errors', () => {
    const compactResponse = {
      data: makeCompactResponse({
        axes: [],
        results: { A: { status: 504, error: 'query timed out', frames: [] } },
      }),
      headers: new Headers({ 'content-type': QUERY_DATA_COMPACT_MEDIA_TYPE }),
    } as unknown as FetchResponse<ArrayBuffer>;

    const response = toDataQueryResponse(compactResponse, undefined, true);
    expect(response.state).toBe('Error');
    expect(response.error).toMatchObject({ refId: 'A', message: 'query timed out', status: 504 });
    expect(response.compactSeries?.series).toHaveLength(0);
  });

  test('preserves compact format for no-data results', () => {
    const compactResponse = {
      data: makeCompactResponse({ axes: [], results: { A: { frames: [] } } }),
      headers: new Headers({ 'content-type': QUERY_DATA_COMPACT_MEDIA_TYPE }),
    } as unknown as FetchResponse<ArrayBuffer>;

    const response = toDataQueryResponse(compactResponse, undefined, true);

    expect(response.data).toEqual([]);
    expect(response.compactSeries?.series).toHaveLength(0);
  });

  test('returns parser failures as query errors', () => {
    const response = toDataQueryResponse(new Error('Invalid compact query response'));

    expect(response.state).toBe('Error');
    expect(response.error?.message).toBe('Invalid compact query response');
  });

  test('should parse output with dataframe in order of queries', () => {
    const queries: DataQuery[] = [{ refId: 'B' }, { refId: 'A' }];
    const res = toDataQueryResponse(resp, queries);
    const frames = res.data;
    expect(frames).toHaveLength(2);
    expect(frames[0].refId).toEqual('B');
    expect(frames[1].refId).toEqual('A');

    const norm = frames.map((f) => toDataFrameDTO(f));
    expect(norm).toMatchInlineSnapshot(`
      [
        {
          "fields": [
            {
              "config": {},
              "labels": undefined,
              "name": "time",
              "type": "time",
              "values": [
                1611767228473,
                1611767240473,
                1611767252473,
                1611767264473,
                1611767276473,
                1611767288473,
              ],
            },
            {
              "config": {},
              "labels": undefined,
              "name": "B-series",
              "type": "number",
              "values": [
                1,
                20,
                90,
                30,
                5,
                0,
              ],
            },
          ],
          "meta": undefined,
          "name": undefined,
          "refId": "B",
        },
        {
          "fields": [
            {
              "config": {},
              "labels": undefined,
              "name": "time",
              "type": "time",
              "values": [
                1611767228473,
                1611767240473,
                1611767252473,
                1611767264473,
                1611767276473,
                1611767288473,
              ],
            },
            {
              "config": {},
              "labels": undefined,
              "name": "A-series",
              "type": "number",
              "values": [
                1,
                20,
                90,
                30,
                5,
                0,
              ],
            },
          ],
          "meta": undefined,
          "name": undefined,
          "refId": "A",
        },
      ]
    `);
  });

  test('processEmptyResults', () => {
    const frames = toDataQueryResponse(emptyResults).data;
    expect(frames.length).toEqual(0);
  });

  test('keeps query order', () => {
    const resp = {
      data: {
        results: {
          X: {
            series: [{ target: '', datapoints: [[13.594958983547151, 1611839862951]] }],
          },
          B: {
            series: [{ target: '', datapoints: [[13.594958983547151, 1611839862951]] }],
          },
          A: {
            series: [{ target: '', datapoints: [[13.594958983547151, 1611839862951]] }],
          },
        },
      },
    };

    const queries: DataQuery[] = [{ refId: 'A' }, { refId: 'B' }];

    const ids = (toDataQueryResponse(resp, queries).data as DataFrame[]).map((f) => f.refId);
    expect(ids).toEqual(['A', 'B']);
  });

  test('should handle a success-response without traceIds', () => {
    const input = {
      data: {
        results: {
          A: {
            frames: [],
          },
        },
      },
    } as unknown as FetchResponse<BackendDataSourceResponse>;
    const res = toDataQueryResponse(input);
    expect(res.traceIds).toBeUndefined();
  });

  test('should handle a success-response with traceIds', () => {
    const input = {
      data: {
        results: {
          A: {
            frames: [],
          },
        },
      },
      traceId: 'traceId1',
    } as unknown as FetchResponse<BackendDataSourceResponse>;
    const res = toDataQueryResponse(input);
    expect(res.traceIds).toStrictEqual(['traceId1']);
  });

  test('should handle an error-response without traceIds', () => {
    const input = {
      data: {
        results: {
          A: {
            error: 'error from A',
            status: 400,
          },
          B: {
            error: 'error from B',
            status: 400,
          },
        },
      },
    } as unknown as FetchResponse<BackendDataSourceResponse>;
    const res = toDataQueryResponse(input);
    expect(res.traceIds).toBeUndefined();
    expect(res.error?.traceId).toBeUndefined();
    expect(res.errors).toHaveLength(2);
    expect(res.errors?.[0].traceId).toBeUndefined();
    expect(res.errors?.[1].traceId).toBeUndefined();
  });

  test('should handle an error-response with traceIds', () => {
    const input = {
      data: {
        results: {
          A: {
            error: 'error from A',
            status: 400,
          },
          B: {
            error: 'error from B',
            status: 400,
          },
        },
      },
      traceId: 'traceId1',
    } as unknown as FetchResponse<BackendDataSourceResponse>;
    const res = toDataQueryResponse(input);
    expect(res.traceIds).toStrictEqual(['traceId1']);
    expect(res.error?.traceId).toBe('traceId1');
    expect(res.errors).toHaveLength(2);
    expect(res.errors?.[0].traceId).toBe('traceId1');
    expect(res.errors?.[1].traceId).toBe('traceId1');
  });

  test('preserves proxied upstream headers grouped by ref ID', () => {
    const input = {
      data: {
        results: {
          A: { frames: [{ schema: { fields: [] } }] },
          B: { frames: [{ schema: { fields: [] } }] },
        },
        proxied_upstream_headers: {
          A: { 'X-Trickster-Result': 'cache-hit' },
          B: { 'X-Trickster-Result': 'proxy-hit' },
        },
      },
    } as unknown as FetchResponse<BackendDataSourceResponse>;

    expect(toDataQueryResponse(input).proxied_upstream_headers).toEqual(input.data.proxied_upstream_headers);
  });

  describe('Cache notice', () => {
    let resp: FetchResponse<BackendDataSourceResponse>;

    beforeEach(() => {
      resp = {
        url: '',
        type: 'basic',
        config: { url: '' },
        status: 200,
        statusText: 'OK',
        ok: true,
        redirected: false,
        headers: new Headers(),
        data: {
          results: {
            A: { frames: [{ schema: { fields: [] } }] },
          },
        },
      };
    });

    test('adds notice and cached boolean for responses with X-Cache: HIT header', () => {
      const queries: DataQuery[] = [{ refId: 'A' }];
      resp.headers.set('X-Cache', 'HIT');
      const meta = toDataQueryResponse(resp, queries).data[0].meta;
      expect(meta.notices).toStrictEqual([cachedResponseNotice]);
      expect(meta.isCachedResponse).toBeTruthy();
    });

    test('does not remove existing notices', () => {
      const queries: DataQuery[] = [{ refId: 'A' }];
      resp.headers.set('X-Cache', 'HIT');
      resp.data.results.A.frames![0].schema!.meta = { notices: [{ severity: 'info', text: 'Example' }] };
      expect(toDataQueryResponse(resp, queries).data[0].meta.notices).toStrictEqual([
        { severity: 'info', text: 'Example' },
        cachedResponseNotice,
      ]);
    });

    test('does not add notice or cached response boolean for responses with X-Cache: MISS header', () => {
      const queries: DataQuery[] = [{ refId: 'A' }];
      resp.headers.set('X-Cache', 'MISS');
      expect(toDataQueryResponse(resp, queries).data[0].meta?.notices).toBeUndefined();
      expect(toDataQueryResponse(resp, queries).data[0].meta?.isCachedResponse).toBeUndefined();
    });

    test('does not add notice for responses without X-Cache header', () => {
      const queries: DataQuery[] = [{ refId: 'A' }];
      expect(toDataQueryResponse(resp, queries).data[0].meta?.notices).toBeUndefined();
    });
  });

  test('resultWithError', () => {
    // Generated from:
    // qdr.Responses[q.GetRefID()] = backend.DataResponse{
    //   Error: fmt.Errorf("an Error: %w", fmt.Errorf("another error")),
    //   Frames: data.Frames{
    //     {
    //       Fields: data.Fields{data.NewField("numbers", nil, []float64{1, 3})},
    //       Meta: &data.FrameMeta{
    //         Notices: []data.Notice{
    //           {
    //             Severity: data.NoticeSeverityError,
    //             Text:     "Text",
    //           },
    //         },
    //       },
    //     },
    //   },
    // }
    const res = toDataQueryResponse(resWithError);
    expect(res.error).toMatchInlineSnapshot(`
      {
        "message": "Hello Error",
        "refId": "A",
        "status": 400,
      }
    `);
    expect(res.errors).toEqual([
      {
        message: 'Hello Error',
        refId: 'A',
        status: 400,
      },
    ]);

    const norm = res.data.map((f) => toDataFrameDTO(f));
    expect(norm).toMatchInlineSnapshot(`
      [
        {
          "fields": [
            {
              "config": {},
              "labels": undefined,
              "name": "numbers",
              "type": "number",
              "values": [
                1,
                3,
              ],
            },
          ],
          "meta": {
            "notices": [
              {
                "severity": 2,
                "text": "Text",
              },
            ],
          },
          "name": undefined,
          "refId": "A",
        },
      ]
    `);
  });

  describe('should convert to TestingStatus', () => {
    test('from api/ds/query generic errors', () => {
      const result = toTestingStatus({ status: 500, data: { message: 'message', error: 'error' } } as FetchError);
      expect(result).toMatchObject({
        status: 'error',
        message: 'message',
        details: { message: 'error' },
      });
    });
    test('from api/ds/query result errors', () => {
      const result = toTestingStatus({
        status: 400,
        data: {
          results: {
            A: {
              error: 'error',
            },
          },
        },
      } as FetchError);
      expect(result).toMatchObject({
        status: 'error',
        message: 'error',
      });
    });
    test('unknown errors', () => {
      expect(() => {
        toTestingStatus({ status: 503, data: 'Fatal Error' } as FetchError);
      }).toThrow();

      expect(() => {
        toTestingStatus({ status: 503, data: {} } as FetchError);
      }).toThrow();

      expect(() => {
        toTestingStatus({ status: 503 } as FetchError);
      }).toThrow();
    });
  });
});
