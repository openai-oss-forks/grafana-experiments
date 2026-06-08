import { SortOrder } from '@grafana/schema';

import { filterTooltipIndexes, sortTooltipIndexes } from './CompactTooltipPlugin';

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
      { seriesCount: 5, yAt: (seriesIndex: number) => [0, null, -2, Number.NaN, 4][seriesIndex] },
      (seriesIndex) => ({ config: seriesIndex === 1 ? { noValue: 'N/A' } : {} }),
      0,
      false
    );

    expect(readIndexes(filtered)).toEqual([0, 1, 2, 3, 4]);
  });

  it('reads each series value once when filtering and sorting the same cursor column', () => {
    const yAt = jest.fn((seriesIndex: number) => [4, null, -2, Number.NaN, 4][seriesIndex]);
    const source = { seriesCount: 5, yAt };
    const filtered = filterTooltipIndexes(indexes, source, getStyle, 0, false);

    expect(readIndexes(sortTooltipIndexes(filtered, SortOrder.Descending))).toEqual([0, 4, 2, 3]);
    expect(yAt).toHaveBeenCalledTimes(5);
  });
});

function readIndexes(indexes: { length: number; at(index: number): number }): number[] {
  return Array.from({ length: indexes.length }, (_, index) => indexes.at(index));
}
