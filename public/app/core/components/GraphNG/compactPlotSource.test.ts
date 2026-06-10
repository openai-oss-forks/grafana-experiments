import { COMPACT_TIME_SERIES_FORMAT, CompactTimeSeriesData, CompactTimeSeriesSeries } from '@grafana/data';
import { GraphTransform } from '@grafana/schema';

import { CompactPlotSeriesOptions, createCompactPlotSource } from './compactPlotSource';

describe('CompactPlotSource', () => {
  test('reads a regular axis and packed gaps without materializing point arrays', () => {
    const source = compactSource(
      [{ start: 1000, step: 1000, count: 5 }],
      [{ axisId: 0, values: [0, 4, 1_000_000], positions: [0, 2, 4] }]
    );
    const plot = createCompactPlotSource(source);

    expect(plot.buffer).toBe(source.buffer);
    expect(plot.pointCount).toBe(5);
    expect(Array.from({ length: plot.pointCount }, (_, index) => plot.xAt(index))).toEqual([
      1000, 2000, 3000, 4000, 5000,
    ]);
    expect(Array.from({ length: plot.pointCount }, (_, index) => plot.yAt(0, index))).toEqual([
      0,
      null,
      4,
      null,
      1_000_000,
    ]);

    const scanned: Array<number | null | undefined> = [];
    plot.scan(0, 0, plot.pointCount - 1, (_index, value) => scanned.push(value));
    expect(scanned).toEqual([0, null, 4, null, 1_000_000]);
    expect(plot.extent(0, 0, plot.pointCount - 1, 'all')).toEqual([0, 1_000_000]);
    expect(plot.nearestPresent(0, 1, 0)).toBe(0);
    expect(plot.nearestPresent(0, 3, 1)).toBe(4);

    const direct = emptyBufferScan();
    expect(plot.prepareBufferScan(0, 1, direct)).toBe(true);
    expect(direct).toMatchObject({
      axisStart: 1000,
      axisStep: 1000,
      valuesByteOffset: 0,
      presenceByteLength: 1,
      packedIndex: 1,
      valueMultiplier: 1,
      missingValue: null,
    });
  });

  test('applies no-value, negative, constant, and span-null semantics while reading', () => {
    const source = compactSource(
      [{ start: 0, step: 10, count: 5 }],
      [{ axisId: 0, values: [2, 4], positions: [0, 4] }]
    );
    const options: CompactPlotSeriesOptions[] = [{ noValue: '3', transform: GraphTransform.NegativeY }];
    const plot = createCompactPlotSource(source, (index) => options[index]);

    expect(Array.from({ length: 5 }, (_, index) => plot.yAt(0, index))).toEqual([-2, -3, -3, -3, -4]);
    expect(plot.extent(0, 0, 4, 'all')).toEqual([-4, -2]);
    expect(plot.extent(0, 0, 4, 'positive')).toEqual([null, null]);

    options[0] = { transform: GraphTransform.Constant };
    const constant = createCompactPlotSource(source, (index) => options[index]);
    expect(Array.from({ length: 5 }, (_, index) => constant.yAt(0, index))).toEqual([
      2,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(constant.prepareBufferScan(0, 0, emptyBufferScan())).toBe(false);

    options[0] = { spanNulls: 50 };
    const connected = createCompactPlotSource(source, (index) => options[index]);
    expect(Array.from({ length: 5 }, (_, index) => connected.yAt(0, index))).toEqual([
      2,
      undefined,
      undefined,
      undefined,
      4,
    ]);
    expect(Array.from({ length: 5 }, (_, index) => connected.cursorValueAt(0, index))).toEqual([
      2,
      null,
      null,
      null,
      4,
    ]);
  });

  test.each([
    { insertNulls: 50, spanNulls: false, expected: [2, undefined, undefined, undefined, 4] },
    { insertNulls: 20, spanNulls: false, expected: [2, null, null, null, 4] },
    { insertNulls: 20, spanNulls: -1, expected: [2, null, null, null, 4] },
    { insertNulls: 20, spanNulls: true, expected: [2, undefined, undefined, undefined, 4] },
    { insertNulls: 20, spanNulls: 50, expected: [2, undefined, undefined, undefined, 4] },
  ])('matches insert-null and span-null ordering: %p', ({ insertNulls, spanNulls, expected }) => {
    const source = compactSource(
      [{ start: 0, step: 10, count: 5 }],
      [{ axisId: 0, values: [2, 4], positions: [0, 4] }]
    );
    const plot = createCompactPlotSource(source, () => ({ insertNulls, spanNulls }));

    expect(Array.from({ length: 5 }, (_, index) => plot.yAt(0, index))).toEqual(expected);
    const scanned: Array<number | null | undefined> = [];
    plot.scan(0, 0, 4, (_index, value) => scanned.push(value));
    expect(scanned).toEqual(expected);

    const partial: Array<number | null | undefined> = [];
    plot.scan(0, 2, 3, (_index, value) => partial.push(value));
    expect(partial).toEqual(expected.slice(2, 4));
  });

  test.each([
    {
      positions: [2, 4],
      expected: [null, null, 2, undefined, 4],
    },
    {
      positions: [0, 2],
      expected: [2, undefined, 4, null, null],
    },
  ])('does not span numeric thresholds across an open range boundary: %p', ({ positions, expected }) => {
    const source = compactSource([{ start: 0, step: 10, count: 5 }], [{ axisId: 0, values: [2, 4], positions }]);
    const plot = createCompactPlotSource(source, () => ({ insertNulls: 10, spanNulls: 100 }));

    expect(Array.from({ length: 5 }, (_, index) => plot.yAt(0, index))).toEqual(expected);
    const scanned: Array<number | null | undefined> = [];
    plot.scan(0, 0, 4, (_index, value) => scanned.push(value));
    expect(scanned).toEqual(expected);
  });

  test('keeps multiple axes symbolic and distinguishes alignment absence from source gaps', () => {
    const source = compactSource(
      [
        { start: 0, step: 10, count: 3 },
        { start: 5, step: 10, count: 3 },
      ],
      [
        { axisId: 0, values: [1, 3], positions: [0, 2] },
        { axisId: 1, values: [5, 6, 7] },
      ]
    );
    const plot = createCompactPlotSource(source);

    expect(plot.prepareBufferScan(0, 0, emptyBufferScan())).toBe(false);
    expect(Array.from({ length: plot.pointCount }, (_, index) => plot.xAt(index))).toEqual([0, 5, 10, 15, 20, 25]);
    expect(Array.from({ length: plot.pointCount }, (_, index) => plot.yAt(0, index))).toEqual([
      1,
      null,
      null,
      null,
      3,
      undefined,
    ]);
    expect(Array.from({ length: plot.pointCount }, (_, index) => plot.cursorValueAt(0, index))).toEqual([
      1,
      undefined,
      null,
      undefined,
      3,
      undefined,
    ]);
    expect(Array.from({ length: plot.pointCount }, (_, index) => plot.yAt(1, index))).toEqual([
      undefined,
      5,
      undefined,
      6,
      undefined,
      7,
    ]);
    expect(plot.extent(0, 1, 4, 'all')).toEqual([3, 3]);
    expect(plot.nearestPresent(0, 3, -1)).toBe(0);
    expect(plot.nearestPresent(0, 3, 1)).toBe(4);
    expect(plot.nearestPresent(1, 2, -1)).toBe(1);
    expect(plot.nearestPresent(1, 2, 1)).toBe(3);

    const scanned: Array<[number, number | null | undefined]> = [];
    plot.scan(0, 0, plot.pointCount - 1, (index, value) => scanned.push([plot.xAt(index), value]));
    expect(scanned).toEqual([
      [0, 1],
      [5, null],
      [10, null],
      [15, null],
      [20, 3],
      [25, undefined],
    ]);

    const filled = createCompactPlotSource(source, (seriesIndex) => (seriesIndex === 0 ? { noValue: '0' } : undefined));
    expect(Array.from({ length: filled.pointCount }, (_, index) => filled.yAt(0, index))).toEqual([
      1,
      undefined,
      0,
      undefined,
      3,
      undefined,
    ]);
  });

  test('supports random access deep into a long gapped bitmap', () => {
    const count = 1025;
    const positions = Array.from({ length: count }, (_, index) => index).filter((index) => index % 3 === 0);
    const values = positions.map((index) => index * 2);
    const source = compactSource([{ start: 0, step: 1, count }], [{ axisId: 0, values, positions }]);
    const plot = createCompactPlotSource(source);

    expect(plot.yAt(0, 999)).toBe(1998);
    expect(plot.yAt(0, 1000)).toBeNull();
    expect(plot.yAt(0, 1023)).toBe(2046);
    expect(plot.extent(0, 768, 1024, 'all')).toEqual([1536, 2046]);
  });

  test('finds distant packed endpoints without probing aligned values', () => {
    const count = 100_000;
    const source = compactSource(
      [{ start: 0, step: 1, count }],
      [{ axisId: 0, values: [1, 2], positions: [0, count - 1] }]
    );
    const plot = createCompactPlotSource(source);
    plot.yAt = jest.fn(plot.yAt.bind(plot));

    expect(plot.nearestPresent(0, 50_000, -1)).toBe(0);
    expect(plot.nearestPresent(0, 50_000, 1)).toBe(count - 1);
    expect(plot.yAt).not.toHaveBeenCalled();
  });

  test('chooses the nearest timestamp rather than the nearest union index', () => {
    const source = compactSource(
      [
        { start: 40, step: 60, count: 2 },
        { start: 41, step: 1, count: 10 },
      ],
      [
        { axisId: 0, values: [1, 2] },
        { axisId: 1, values: Array.from({ length: 10 }, (_, index) => index) },
      ]
    );
    const plot = createCompactPlotSource(source);

    expect(plot.xAt(10)).toBe(50);
    expect(plot.nearestPresent(0, 10, 0)).toBe(0);
  });

  test('compiles series options once instead of allocating them during point reads', () => {
    const source = compactSource([{ start: 0, step: 1, count: 3 }], [{ axisId: 0, values: [1, 2, 3] }]);
    const getOptions = jest.fn(() => ({ transform: GraphTransform.NegativeY }));
    const plot = createCompactPlotSource(source, getOptions);

    expect(getOptions).toHaveBeenCalledTimes(1);
    expect(plot.yAt(0, 0)).toBe(-1);
    expect(plot.yAt(0, 1)).toBe(-2);
    expect(plot.extent(0, 0, 2, 'all')).toEqual([-3, -1]);
    expect(getOptions).toHaveBeenCalledTimes(1);
  });
});

interface TestSeries {
  axisId: number;
  values: number[];
  positions?: number[];
}

function emptyBufferScan() {
  return {
    axisStart: 0,
    axisStep: 0,
    valuesByteOffset: 0,
    presenceByteOffset: 0,
    presenceByteLength: 0,
    packedIndex: 0,
    valueMultiplier: 1 as const,
    missingValue: undefined,
  };
}

function compactSource(axes: CompactTimeSeriesData['axes'], input: TestSeries[]): CompactTimeSeriesData {
  const bitmapLengths = input.map((series) => {
    const count = axes[series.axisId].count;
    const positions = series.positions ?? Array.from({ length: count }, (_, index) => index);
    return positions.length === count ? 0 : Math.ceil(count / 8);
  });
  const valueBytes = input.reduce((total, series) => total + series.values.length * 8, 0);
  const bitmapBytes = bitmapLengths.reduce((total, length) => total + length, 0);
  const buffer = new ArrayBuffer(valueBytes + bitmapBytes);
  const records: CompactTimeSeriesSeries[] = [];
  let valuesByteOffset = 0;
  let presenceByteOffset = valueBytes;

  for (let seriesIndex = 0; seriesIndex < input.length; seriesIndex++) {
    const item = input[seriesIndex];
    const axis = axes[item.axisId];
    const positions = item.positions ?? Array.from({ length: axis.count }, (_, index) => index);
    new Float64Array(buffer, valuesByteOffset, item.values.length).set(item.values);
    const presenceByteLength = bitmapLengths[seriesIndex];
    if (presenceByteLength > 0) {
      const bitmap = new Uint8Array(buffer, presenceByteOffset, presenceByteLength);
      for (const position of positions) {
        bitmap[position >> 3] |= 1 << (position & 7);
      }
    }
    records.push({
      refId: String.fromCharCode(65 + seriesIndex),
      valueName: `series-${seriesIndex}`,
      axisId: item.axisId,
      labelRecordsOffset: 0,
      labelCount: 0,
      presenceByteOffset,
      presenceByteLength,
      presentCount: item.values.length,
      valuesByteOffset,
    });
    valuesByteOffset += item.values.length * 8;
    presenceByteOffset += presenceByteLength;
  }

  return {
    kind: 'compact-response-view',
    format: COMPACT_TIME_SERIES_FORMAT,
    buffer,
    axes,
    series: records,
    metadata: {
      getLabel: () => undefined,
      forEachLabel: () => undefined,
      materializeLabels: () => undefined,
    },
    decodeStats: {
      responseBytes: buffer.byteLength,
      axisCount: axes.length,
      resultCount: 1,
      stringCount: 0,
      stringBytes: 0,
      seriesCount: records.length,
    },
  };
}
