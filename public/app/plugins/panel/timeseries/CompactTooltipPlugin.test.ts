import { SortOrder } from '@grafana/schema';

import { filterTooltipIndexes, sortTooltipIndexes } from './CompactTooltipPlugin';

describe('compact tooltip sorting', () => {
  const indexes = {
    length: 5,
    at: (index: number) => [0, 1, 2, 3, 4][index],
  };
  const source = {
    yAt: (seriesIndex: number) => [4, null, -2, Number.NaN, 4][seriesIndex],
  };

  it('sorts numeric values descending and keeps missing values last', () => {
    const sorted = sortTooltipIndexes(indexes, source, 0, SortOrder.Descending);

    expect(Array.from(sorted)).toEqual([0, 4, 2, 1, 3]);
  });

  it('sorts numeric values ascending and keeps missing values last', () => {
    const sorted = sortTooltipIndexes(indexes, source, 0, SortOrder.Ascending);

    expect(Array.from(sorted)).toEqual([2, 0, 4, 1, 3]);
  });

  it('reuses the supplied index storage', () => {
    const storage = new Uint32Array(indexes.length);

    expect(sortTooltipIndexes(indexes, source, 0, SortOrder.Descending, storage)).toBe(storage);
  });

  it('filters zero-valued rows before sorting and reuses storage', () => {
    const storage = new Uint32Array(indexes.length);
    const filtered = filterTooltipIndexes(
      indexes,
      { yAt: (seriesIndex: number) => [0, null, -2, 0, 4][seriesIndex] },
      () => ({ config: {} }),
      0,
      true,
      storage
    );

    expect(filtered.storage).toBe(storage);
    expect(Array.from({ length: filtered.length }, (_, index) => filtered.at(index))).toEqual([2, 4]);
    const sorted = sortTooltipIndexes(filtered, source, 0, SortOrder.Descending, new Uint32Array(filtered.length));
    expect(Array.from(sorted)).toEqual([4, 2]);
    expect(Array.from({ length: filtered.length }, (_, index) => filtered.at(index))).toEqual([2, 4]);
  });

  it('keeps missing values when noValue is configured and preserves NaN parity with the legacy tooltip', () => {
    const filtered = filterTooltipIndexes(
      indexes,
      { yAt: (seriesIndex: number) => [0, null, -2, Number.NaN, 4][seriesIndex] },
      (seriesIndex) => ({ config: seriesIndex === 1 ? { noValue: 'N/A' } : {} }),
      0,
      false
    );

    expect(Array.from({ length: filtered.length }, (_, index) => filtered.at(index))).toEqual([0, 1, 2, 3, 4]);
  });
});
