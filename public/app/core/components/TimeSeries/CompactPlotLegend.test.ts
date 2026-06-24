import { AxisPlacement, LegendDisplayMode } from '@grafana/schema';
import { type VizLegendItemSource } from '@grafana/ui';

import { CompactNativeRenderPlan } from '../GraphNG/compactNativePlan';

import {
  getCompactLegendAxis,
  getCompactLegendIdentity,
  getCompactLegendSortValue,
  materializeCompactLegendItems,
  normalizeCompactLegendCalcs,
  toggleCompactLegendSeries,
} from './CompactPlotLegend';

it('does not read a legend item when the compact source is empty', () => {
  const getItem = jest.fn();
  const source = {
    length: 0,
    getItem,
    getItemKey: jest.fn(),
    getItemsForYAxis: () => ({ length: 0 }),
  } as unknown as VizLegendItemSource<number>;

  expect(getCompactLegendIdentity(source, LegendDisplayMode.List, 'bottom')).toBe(
    JSON.stringify([LegendDisplayMode.List, 'bottom', 0, [0, 0], []])
  );
  expect(getItem).not.toHaveBeenCalled();
});

it('uses the standard list items when the compact legend can preserve the established layout', () => {
  const source = {
    length: 240,
    getItem: () => ({ label: 'shared-name', yAxis: 1 }),
    getItemKey: (index: number) => index,
    getDisplayValues: (index: number) => [{ numeric: index, text: `value-${index}` }],
  } as VizLegendItemSource<number>;

  const items = materializeCompactLegendItems(source, LegendDisplayMode.List, 'bottom');
  expect(items).toHaveLength(240);
  expect(items?.[0].getItemKey?.()).toBe('0');
  expect(items?.[1].getItemKey?.()).toBe('1');
  expect(items?.[1].getDisplayValues?.()).toEqual([{ numeric: 1, text: 'value-1' }]);
  expect(materializeCompactLegendItems({ ...source, length: 501 }, LegendDisplayMode.List, 'bottom')).toHaveLength(500);
  expect(
    materializeCompactLegendItems({ ...source, length: 501 }, LegendDisplayMode.List, 'bottom', 1_000)
  ).toHaveLength(501);
  expect(materializeCompactLegendItems(source, LegendDisplayMode.Table, 'bottom')).toBeUndefined();
});

it('materializes a bounded batch from both bottom-axis groups', () => {
  const makeAxisSource = (axis: 1 | 2) =>
    ({
      length: 501,
      getItem: (index: number) => ({ label: `${axis}-${index}`, yAxis: axis }),
      getItemKey: (index: number) => `${axis}-${index}`,
    }) as VizLegendItemSource<number>;
  const axes = { 1: makeAxisSource(1), 2: makeAxisSource(2) };
  const source = {
    length: 1_002,
    getItem: () => ({ label: 'unused', yAxis: 1 }),
    getItemKey: (index: number) => index,
    getItemsForYAxis: (axis: 1 | 2) => axes[axis],
  } as VizLegendItemSource<number>;

  const items = materializeCompactLegendItems(source, LegendDisplayMode.List, 'bottom');
  expect(items).toHaveLength(1_000);
  expect(items?.[0].label).toBe('1-0');
  expect(items?.[500].label).toBe('2-0');
});

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
