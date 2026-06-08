import uPlot from 'uplot';

import { CompactNativeRenderPlan } from '../GraphNG/compactNativePlan';

import { toggleCompactLegendSeries } from './CompactPlotLegend';

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
