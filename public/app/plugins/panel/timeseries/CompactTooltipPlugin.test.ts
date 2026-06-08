import { SortOrder } from '@grafana/schema';

import {
  filterTooltipIndexes,
  getTooltipTransform,
  resolveTooltipValue,
  sortTooltipIndexes,
} from './CompactTooltipPlugin';

describe('compact tooltip indexes', () => {
  const indexes = {
    length: 5,
    at: (index: number) => index,
  };
  const getStyle = () => ({ config: {} });

  it.each([
    [SortOrder.Descending, [0, 4, 2, 1, 3]],
    [SortOrder.Ascending, [2, 0, 4, 1, 3]],
  ])('sorts %s while keeping missing values last', (order, expected) => {
    const source = {
      seriesCount: 5,
      yAt: (seriesIndex: number) => [4, null, -2, Number.NaN, 4][seriesIndex],
      nearestPresent: () => null,
    };
    const filtered = filterTooltipIndexes(
      indexes,
      source,
      (seriesIndex) => ({ config: seriesIndex === 1 ? { noValue: 'N/A' } : {} }),
      0,
      false
    );

    expect(readIndexes(sortTooltipIndexes(filtered, order))).toEqual(expected);
  });

  it('filters zero-valued rows and preserves reusable index capacity', () => {
    const source = {
      seriesCount: 5,
      yAt: (seriesIndex: number) => [0, null, -2, 0, 4][seriesIndex],
      nearestPresent: () => null,
    };
    const filterStorage = new Uint32Array(indexes.length);
    const sortStorage = new Uint32Array(indexes.length);
    const filtered = filterTooltipIndexes(indexes, source, getStyle, 0, true, filterStorage);
    const sorted = sortTooltipIndexes(filtered, SortOrder.Descending, sortStorage);

    expect(filtered.storage).toBe(filterStorage);
    expect(readIndexes(filtered)).toEqual([2, 4]);
    expect(sorted.storage).toBe(sortStorage);
    expect(readIndexes(sorted)).toEqual([4, 2]);
  });

  it('keeps missing values when noValue is configured and preserves NaN parity with the legacy tooltip', () => {
    const filtered = filterTooltipIndexes(
      indexes,
      {
        seriesCount: 5,
        yAt: (seriesIndex: number) => [0, null, -2, Number.NaN, 4][seriesIndex],
        nearestPresent: () => null,
      },
      (seriesIndex) => ({ config: seriesIndex === 1 ? { noValue: 'N/A' } : {} }),
      0,
      false
    );

    expect(readIndexes(filtered)).toEqual([0, 1, 2, 3, 4]);
  });

  it('reads each series value once when filtering and sorting the same cursor column', () => {
    const yAt = jest.fn((seriesIndex: number) => [4, null, -2, Number.NaN, 4][seriesIndex]);
    const source = { seriesCount: 5, yAt, nearestPresent: () => null };
    const filtered = filterTooltipIndexes(indexes, source, getStyle, 0, false);

    expect(readIndexes(sortTooltipIndexes(filtered, SortOrder.Descending))).toEqual([0, 4, 2, 3]);
    expect(yAt).toHaveBeenCalledTimes(5);
  });

  it('uses the nearest present sample for a series gap like the legacy tooltip', () => {
    const values = [
      [1, null, 3],
      [10, 11, 12],
    ];
    const source = {
      seriesCount: values.length,
      yAt: (seriesIndex: number, valueIndex: number) => values[seriesIndex][valueIndex],
      nearestPresent: (seriesIndex: number, valueIndex: number) =>
        seriesIndex === 0 && valueIndex === 1 ? 0 : valueIndex,
    };
    const filtered = filterTooltipIndexes({ length: 2, at: (index) => index }, source, getStyle, 1, false);

    expect(readIndexes(filtered)).toEqual([0, 1]);
    expect(Array.from(filtered.valueStorage)).toEqual([1, 11]);
    expect(resolveTooltipValue(source, 0, 1)).toBe(1);
  });
});

describe('compact tooltip positioning', () => {
  const size = { width: 240, height: 160 };
  const viewport = { width: 1000, height: 800 };

  it('places the tooltip below and to the right when it fits', () => {
    expect(getTooltipTransform({ left: 300, top: 200 }, size, viewport)).toBe('translateX(310px) translateY(210px)');
  });

  it('reflects the tooltip away from the viewport edges', () => {
    expect(getTooltipTransform({ left: 900, top: 700 }, size, viewport)).toBe(
      'translateX(890px) translateX(-100%) translateY(690px) translateY(-100%)'
    );
  });
});

function readIndexes(indexes: { length: number; at(index: number): number }): number[] {
  return Array.from({ length: indexes.length }, (_, index) => indexes.at(index));
}
