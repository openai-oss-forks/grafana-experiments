import { type MouseEvent, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { DisplayValue, fieldReducers, ReducerID } from '@grafana/data';
import { AxisPlacement, VizLegendOptions } from '@grafana/schema';
import { VizLayout, VizLegend, VizLegendItem, VizLegendItemSource } from '@grafana/ui';
import { UPlotConfigBuilder } from '@grafana/ui/internal';

import { CompactNativeRenderPlan, CompactNativeSeriesFlag } from '../GraphNG/compactNativePlan';

interface CompactPlotLegendProps extends VizLegendOptions {
  config: UPlotConfigBuilder;
  plan: CompactNativeRenderPlan;
}

export function CompactPlotLegend({
  config,
  plan,
  placement,
  calcs,
  displayMode,
  ...legendProps
}: CompactPlotLegendProps) {
  const plotRef = useRef<import('uplot') | null>(null);
  const [, setVisibilityRevision] = useState(0);
  useLayoutEffect(() => {
    config.addHook('init', (plot) => {
      plotRef.current = plot;
    });
    config.addHook('destroy', () => {
      plotRef.current = null;
    });
  }, [config]);
  const onSeriesVisibilityChange = useCallback(
    (item: VizLegendItem<number>, event: MouseEvent<HTMLButtonElement>) => {
      const plot = plotRef.current;
      const seriesIndex = item.data;
      if (!plot || seriesIndex == null) {
        return;
      }
      const append = event.ctrlKey || event.metaKey || event.shiftKey;
      if (append) {
        plot.setSeries(seriesIndex + 1, { show: plan.source.columns.visibility[seriesIndex] === 0 });
      } else {
        let isolated = plan.source.columns.visibility[seriesIndex] === 1;
        for (let index = 0; isolated && index < plan.seriesCount; index++) {
          isolated = index === seriesIndex || plan.source.columns.visibility[index] === 0;
        }
        plot.setSeries(null, { show: isolated });
        if (!isolated) {
          plot.setSeries(seriesIndex + 1, { show: true });
        }
      }
      setVisibilityRevision((revision) => revision + 1);
    },
    [plan]
  );
  const source = useMemo(() => createLegendSource(config, plan, calcs), [calcs, config, plan]);
  if (source.length === 0) {
    return null;
  }

  return (
    <VizLayout.Legend placement={placement} {...legendProps}>
      <VizLegend
        placement={placement}
        items={[]}
        itemSource={source}
        displayMode={displayMode}
        onSeriesVisibilityChange={onSeriesVisibilityChange}
        sortBy={legendProps.sortBy}
        sortDesc={legendProps.sortDesc}
        isSortable={true}
        displayValueColumns={calcs.map((reducerId) => {
          const reducer = fieldReducers.get(reducerId);
          return { title: reducer.name, description: reducer.description };
        })}
      />
    </VizLayout.Legend>
  );
}

function createLegendSource(
  config: UPlotConfigBuilder,
  plan: CompactNativeRenderPlan,
  calcs: string[]
): VizLegendItemSource<number> {
  const visibleIndexes = new Uint32Array(plan.seriesCount);
  let length = 0;
  for (let index = 0; index < plan.seriesCount; index++) {
    if ((plan.columns.flags[index] & CompactNativeSeriesFlag.HiddenFromLegend) === 0) {
      visibleIndexes[length++] = index;
    }
  }

  const sourceAt = (index: number) => visibleIndexes[index];
  const axisFor = (seriesIndex: number) =>
    config.getAxisPlacement(plan.source.scales[plan.source.columns.scaleIds[seriesIndex]].key) === AxisPlacement.Right
      ? 2
      : 1;
  const getItem = (index: number): VizLegendItem<number> => {
    const seriesIndex = sourceAt(index);
    const style = plan.source.styles[plan.source.columns.styleIds[seriesIndex]];
    const label = plan.getDisplayName(seriesIndex);
    return {
      itemKey: `${seriesIndex}:${label}`,
      label,
      fieldName: label,
      color: style.stroke,
      disabled: plan.source.columns.visibility[seriesIndex] === 0,
      yAxis: axisFor(seriesIndex),
      data: seriesIndex,
    };
  };
  const getDisplayValues = (index: number): DisplayValue[] => {
    const seriesIndex = sourceAt(index);
    const display = plan.getDisplay(seriesIndex);
    return calcs.map((reducerId) => {
      const reducer = fieldReducers.get(reducerId);
      const value = plan.reduce(seriesIndex, reducerId as ReducerID);
      return { ...display(value), title: reducer.name, description: reducer.description };
    });
  };
  const makeAxisSource = (axis: 1 | 2): VizLegendItemSource<number> => {
    const indexes = new Uint32Array(length);
    let axisLength = 0;
    for (let index = 0; index < length; index++) {
      if (axisFor(sourceAt(index)) === axis) {
        indexes[axisLength++] = sourceAt(index);
      }
    }
    return {
      length: axisLength,
      getItem: (index) => {
        const seriesIndex = indexes[index];
        const style = plan.source.styles[plan.source.columns.styleIds[seriesIndex]];
        const label = plan.getDisplayName(seriesIndex);
        return {
          itemKey: `${seriesIndex}:${label}`,
          label,
          fieldName: label,
          color: style.stroke,
          disabled: plan.source.columns.visibility[seriesIndex] === 0,
          yAxis: axis,
          data: seriesIndex,
        };
      },
      getItemKey: (index) => indexes[index],
      getDisplayValues: (index) => getDisplayValuesForSeries(plan, calcs, indexes[index]),
      getSortValue: (index, sortBy) => getSortValue(plan, calcs, indexes[index], sortBy),
    };
  };

  return {
    length,
    getItem,
    getItemKey: (index) => sourceAt(index),
    getItemsForYAxis: makeAxisSource,
    getDisplayValues,
    getSortValue: (index, sortBy) => getSortValue(plan, calcs, sourceAt(index), sortBy),
  };
}

function getDisplayValuesForSeries(plan: CompactNativeRenderPlan, calcs: string[], seriesIndex: number) {
  const display = plan.getDisplay(seriesIndex);
  return calcs.map((reducerId) => {
    const reducer = fieldReducers.get(reducerId);
    return {
      ...display(plan.reduce(seriesIndex, reducerId as ReducerID)),
      title: reducer.name,
      description: reducer.description,
    };
  });
}

function getSortValue(plan: CompactNativeRenderPlan, calcs: string[], seriesIndex: number, sortBy: string) {
  if (sortBy === 'Name') {
    return plan.getDisplayName(seriesIndex);
  }
  return calcs.includes(sortBy) ? Number(plan.reduce(seriesIndex, sortBy as ReducerID)) : undefined;
}
