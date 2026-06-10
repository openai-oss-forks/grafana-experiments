import uPlot from 'uplot';

import { CompactNativeRenderPlan } from '../GraphNG/compactNativePlan';

import { getCompactLegendSortValue, toggleCompactLegendSeries } from './CompactPlotLegend';

describe('toggleCompactLegendSeries', () => {
  it('isolates and restores every series with the selected display name', () => {
    const { plan, plot, visibility } = setup(['p50', 'p50', 'p99', 'max']);

    toggleCompactLegendSeries(plot, plan, 0, false);
    expect([...visibility]).toEqual([1, 1, 0, 0]);

    toggleCompactLegendSeries(plot, plan, 1, false);
    expect([...visibility]).toEqual([1, 1, 1, 1]);
  });

  it('appends visibility changes for the complete display-name group', () => {
    const { plan, plot, visibility } = setup(['p50', 'p50', 'p99']);

    toggleCompactLegendSeries(plot, plan, 0, true);
    expect([...visibility]).toEqual([0, 0, 1]);

    toggleCompactLegendSeries(plot, plan, 1, true);
    expect([...visibility]).toEqual([1, 1, 1]);
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

function setup(displayNames: string[]) {
  const visibility = new Uint8Array(displayNames.length);
  visibility.fill(1);
  const plan = {
    seriesCount: displayNames.length,
    source: { columns: { visibility } },
    getDisplayName: (index: number) => displayNames[index],
  } as unknown as CompactNativeRenderPlan;
  const plot = {
    setSeries: (index: number | null, options: { show?: boolean }) => {
      if (options.show == null) {
        return;
      }
      if (index == null) {
        visibility.fill(options.show ? 1 : 0);
      } else {
        visibility[index - 1] = options.show ? 1 : 0;
      }
    },
  } as unknown as uPlot;
  return { plan, plot, visibility };
}
