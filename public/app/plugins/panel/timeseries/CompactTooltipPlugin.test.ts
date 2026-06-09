import { SortOrder } from '@grafana/schema';

import {
  filterTooltipIndexes,
  getTooltipTransform,
  isCompactTooltipPlotVisible,
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
    const snapshot = {
      seriesCount: 5,
      valueAt: (seriesIndex: number) => [4, null, -2, Number.NaN, 4][seriesIndex],
    };
    const filtered = filterTooltipIndexes(
      indexes,
      snapshot,
      (seriesIndex) => ({ config: seriesIndex === 1 ? { noValue: 'N/A' } : {} }),
      false
    );

    expect(readIndexes(sortTooltipIndexes(filtered, order))).toEqual(expected);
  });

  it('filters zero-valued rows and preserves reusable index capacity', () => {
    const snapshot = {
      seriesCount: 5,
      valueAt: (seriesIndex: number) => [0, null, -2, 0, 4][seriesIndex],
    };
    const filterStorage = new Uint32Array(indexes.length);
    const sortStorage = new Uint32Array(indexes.length);
    const filtered = filterTooltipIndexes(indexes, snapshot, getStyle, true, filterStorage);
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
        valueAt: (seriesIndex: number) => [0, null, -2, Number.NaN, 4][seriesIndex],
      },
      (seriesIndex) => ({ config: seriesIndex === 1 ? { noValue: 'N/A' } : {} }),
      false
    );

    expect(readIndexes(filtered)).toEqual([0, 1, 2, 3, 4]);
  });

  it('sorts filtered values from the shared cursor snapshot', () => {
    const snapshot = { seriesCount: 5, valueAt: (seriesIndex: number) => [4, null, -2, Number.NaN, 4][seriesIndex] };
    const filtered = filterTooltipIndexes(indexes, snapshot, getStyle, false);

    expect(readIndexes(sortTooltipIndexes(filtered, SortOrder.Descending))).toEqual([0, 4, 2, 3]);
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
    const filtered = filterTooltipIndexes(
      { length: 2, at: (index) => index },
      {
        seriesCount: values.length,
        valueAt: (seriesIndex) => resolveTooltipValue(source, seriesIndex, 1),
      },
      getStyle,
      false
    );

    expect(readIndexes(filtered)).toEqual([0, 1]);
    expect(filtered.valueAt(0)).toBe(1);
    expect(filtered.valueAt(1)).toBe(11);
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

describe('compact synchronized tooltip admission', () => {
  it('suppresses plots outside the visible viewport', () => {
    const visible = { rect: { top: 0, left: 0, right: 500, bottom: 400 } } as import('uplot');
    const partiallyVisible = { rect: { top: -200, left: 0, right: 500, bottom: 200 } } as import('uplot');
    const offscreen = { rect: { top: 800, left: 0, right: 500, bottom: 1200 } } as import('uplot');

    expect(isCompactTooltipPlotVisible(visible)).toBe(true);
    expect(isCompactTooltipPlotVisible(partiallyVisible)).toBe(true);
    expect(isCompactTooltipPlotVisible(offscreen)).toBe(false);
  });
});

function readIndexes(indexes: { length: number; at(index: number): number }): number[] {
  return Array.from({ length: indexes.length }, (_, index) => indexes.at(index));
}
