import { AxisPlacement } from '@grafana/schema';

import { CompactNativeRenderPlan } from '../GraphNG/compactNativePlan';

import {
  getCompactLegendAxis,
  getCompactLegendSortValue,
  normalizeCompactLegendCalcs,
  toggleCompactLegendSeries,
} from './CompactPlotLegend';

it('keeps remapped horizontal-bar value axes in the matching legend group', () => {
  expect(getCompactLegendAxis(AxisPlacement.Left)).toBe(1);
  expect(getCompactLegendAxis(AxisPlacement.Bottom)).toBe(1);
  expect(getCompactLegendAxis(AxisPlacement.Right)).toBe(2);
  expect(getCompactLegendAxis(AxisPlacement.Top)).toBe(2);
});

it('ignores malformed compact legend calculations', () => {
  expect(normalizeCompactLegendCalcs(undefined)).toEqual([]);
  expect(normalizeCompactLegendCalcs('min')).toEqual([]);
  expect(normalizeCompactLegendCalcs(['min', 'not-a-reducer', 'max'])).toEqual(['min', 'max']);
});

describe('toggleCompactLegendSeries', () => {
  it('isolates and restores every series with the selected display name', () => {
    const { controller, plan, visibility } = setup(['p50', 'p50', 'p99', 'max']);

    toggleCompactLegendSeries(controller, plan, 0, false);
    expect([...visibility]).toEqual([1, 1, 0, 0]);

    toggleCompactLegendSeries(controller, plan, 1, false);
    expect([...visibility]).toEqual([1, 1, 1, 1]);
  });

  it('appends visibility changes for the complete display-name group', () => {
    const { controller, plan, visibility } = setup(['p50', 'p50', 'p99']);

    toggleCompactLegendSeries(controller, plan, 0, true);
    expect([...visibility]).toEqual([0, 0, 1]);

    toggleCompactLegendSeries(controller, plan, 1, true);
    expect([...visibility]).toEqual([1, 1, 1]);
  });

  it('does not toggle bars excluded by configured visibility', () => {
    const { controller, plan, visibility } = setup(['p50', 'p50', 'p99'], [1, 0, 1]);

    toggleCompactLegendSeries(controller, plan, 0, false);
    expect([...visibility]).toEqual([1, 0, 0]);

    toggleCompactLegendSeries(controller, plan, 0, false);
    expect([...visibility]).toEqual([1, 0, 1]);
  });
});

describe('getCompactLegendSortValue', () => {
  it('maps the displayed reducer title back to its reducer ID', () => {
    const plan = {
      getDisplayName: () => 'series-a',
      reduce: (_seriesIndex: number, reducerId: string) => (reducerId === 'mean' ? 42 : -1),
    } as unknown as CompactNativeRenderPlan;

    expect(getCompactLegendSortValue(plan, ['mean'], 0, 'Mean')).toBe(42);
    expect(getCompactLegendSortValue(plan, ['mean'], 0, 'Name')).toBe('series-a');
    expect(getCompactLegendSortValue(plan, ['mean'], 0, 'Max')).toBeUndefined();
  });

  it('keeps empty reducer results missing instead of sorting them as zero', () => {
    const plan = {
      getDisplayName: () => 'empty-series',
      reduce: () => null,
    } as unknown as CompactNativeRenderPlan;

    expect(getCompactLegendSortValue(plan, ['mean'], 0, 'Mean')).toBeUndefined();
  });
});

function setup(displayNames: string[], barLayoutVisibility?: number[]) {
  const visibility = new Uint8Array(displayNames.length);
  visibility.fill(1);
  const layout = barLayoutVisibility ? Uint8Array.from(barLayoutVisibility) : undefined;
  if (layout) {
    for (let index = 0; index < layout.length; index++) {
      visibility[index] = layout[index];
    }
  }
  const plan = {
    seriesCount: displayNames.length,
    source: { columns: { visibility }, barLayoutVisibility: layout },
    getDisplayName: (index: number) => displayNames[index],
  } as unknown as CompactNativeRenderPlan;
  const controller = {
    setSeriesVisibility: (index: number | null, show: boolean) => {
      if (index == null) {
        for (let seriesIndex = 0; seriesIndex < visibility.length; seriesIndex++) {
          visibility[seriesIndex] = show ? (layout?.[seriesIndex] ?? 1) : 0;
        }
      } else {
        visibility[index] = show ? (layout?.[index] ?? 1) : 0;
      }
    },
  };
  return { controller, plan, visibility };
}
