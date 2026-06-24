import { css } from '@emotion/css';
import { type MouseEvent, useCallback, useMemo, useState } from 'react';

import { DisplayValue, fieldReducers, isReducerID } from '@grafana/data';
import { AxisPlacement, VizLegendOptions } from '@grafana/schema';
import { useStyles2, VizLayout, VizLegend, VizLegendItem, VizLegendItemSource } from '@grafana/ui';
import { getCompactRenderController, UPlotConfigBuilder } from '@grafana/ui/internal';

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
  const styles = useStyles2(getStyles);
  const normalizedCalcs = useMemo(() => normalizeCompactLegendCalcs(calcs), [calcs]);
  const [, setVisibilityRevision] = useState(0);
  const onSeriesVisibilityChange = useCallback(
    (item: VizLegendItem<number>, event: MouseEvent<HTMLButtonElement>) => {
      const seriesIndex = item.data;
      if (seriesIndex == null) {
        return;
      }
      const append = event.ctrlKey || event.metaKey || event.shiftKey;
      toggleCompactLegendSeries(getCompactRenderController(plan.source), plan, seriesIndex, append);
      setVisibilityRevision((revision) => revision + 1);
    },
    [plan]
  );
  const source = useMemo(() => createLegendSource(config, plan, normalizedCalcs), [config, normalizedCalcs, plan]);
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
        className={displayMode === 'table' ? styles.table : undefined}
        displayValueColumns={normalizedCalcs.map((reducerId) => {
          const reducer = fieldReducers.get(reducerId);
          return { title: reducer.name, description: reducer.description };
        })}
      />
    </VizLayout.Legend>
  );
}

export function normalizeCompactLegendCalcs(calcs: unknown): string[] {
  return Array.isArray(calcs) ? calcs.filter(isReducerID) : [];
}

const getStyles = () => ({
  table: css({
    tableLayout: 'fixed',
    maxWidth: '100%',
    'th:first-child': {
      width: 'auto',
    },
    'th:not(:first-child), td:not(:first-child)': {
      width: 88,
      maxWidth: 88,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    },
    'td:first-child': {
      overflow: 'hidden',
    },
    'td:first-child > span': {
      minWidth: 0,
    },
    'td:first-child button': {
      minWidth: 0,
      maxWidth: '100%',
    },
  }),
});

export function toggleCompactLegendSeries(
  controller: Pick<ReturnType<typeof getCompactRenderController>, 'setSeriesVisibility'>,
  plan: CompactNativeRenderPlan,
  seriesIndex: number,
  append: boolean
) {
  const label = plan.getDisplayName(seriesIndex);
  if (append) {
    const show = plan.source.columns.visibility[seriesIndex] === 0;
    for (let index = 0; index < plan.seriesCount; index++) {
      if (isLegendToggleable(plan, index) && plan.getDisplayName(index) === label) {
        controller.setSeriesVisibility(index, show);
      }
    }
    return;
  }

  let isolated = true;
  for (let index = 0; index < plan.seriesCount; index++) {
    if (!isLegendToggleable(plan, index)) {
      continue;
    }
    const expectedVisibility = plan.getDisplayName(index) === label ? 1 : 0;
    if (plan.source.columns.visibility[index] !== expectedVisibility) {
      isolated = false;
      break;
    }
  }
  controller.setSeriesVisibility(null, isolated);
  if (!isolated) {
    for (let index = 0; index < plan.seriesCount; index++) {
      if (isLegendToggleable(plan, index) && plan.getDisplayName(index) === label) {
        controller.setSeriesVisibility(index, true);
      }
    }
  }
}

function createLegendSource(
  config: UPlotConfigBuilder,
  plan: CompactNativeRenderPlan,
  calcs: string[]
): VizLegendItemSource<number> {
  const visibleIndexes = new Uint32Array(plan.seriesCount);
  let length = 0;
  for (let index = 0; index < plan.seriesCount; index++) {
    if (
      isLegendToggleable(plan, index) &&
      (plan.columns.flags[index] & CompactNativeSeriesFlag.HiddenFromLegend) === 0
    ) {
      visibleIndexes[length++] = index;
    }
  }

  const sourceAt = (index: number) => visibleIndexes[index];
  const axisFor = (seriesIndex: number) =>
    getCompactLegendAxis(config.getAxisPlacement(plan.source.scales[plan.source.columns.scaleIds[seriesIndex]].key));
  const getItem = (index: number): VizLegendItem<number> => {
    const seriesIndex = sourceAt(index);
    const style = plan.source.styles[plan.source.columns.styleIds[seriesIndex]];
    const label = plan.getDisplayName(seriesIndex);
    return {
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
      const value = reduce(plan, seriesIndex, reducerId);
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
      getSortValue: (index, sortBy) => getCompactLegendSortValue(plan, calcs, indexes[index], sortBy),
    };
  };

  return {
    length,
    getItem,
    getItemKey: (index) => sourceAt(index),
    getItemsForYAxis: makeAxisSource,
    getDisplayValues,
    getSortValue: (index, sortBy) => getCompactLegendSortValue(plan, calcs, sourceAt(index), sortBy),
  };
}

export function getCompactLegendAxis(placement: AxisPlacement): 1 | 2 {
  return placement === AxisPlacement.Right || placement === AxisPlacement.Top ? 2 : 1;
}

function isLegendToggleable(plan: CompactNativeRenderPlan, seriesIndex: number): boolean {
  return (plan.source.barLayoutVisibility?.[seriesIndex] ?? 1) !== 0;
}

function getDisplayValuesForSeries(plan: CompactNativeRenderPlan, calcs: string[], seriesIndex: number) {
  const display = plan.getDisplay(seriesIndex);
  return calcs.map((reducerId) => {
    const reducer = fieldReducers.get(reducerId);
    return {
      ...display(reduce(plan, seriesIndex, reducerId)),
      title: reducer.name,
      description: reducer.description,
    };
  });
}

export function getCompactLegendSortValue(
  plan: CompactNativeRenderPlan,
  calcs: string[],
  seriesIndex: number,
  sortBy: string
) {
  if (sortBy === 'Name') {
    return plan.getDisplayName(seriesIndex);
  }
  const reducerId = calcs.find((candidate) => fieldReducers.get(candidate).name === sortBy);
  if (!reducerId) {
    return undefined;
  }
  const reduced = reduce(plan, seriesIndex, reducerId);
  if (reduced == null) {
    return undefined;
  }
  const value = Number(reduced);
  return Number.isNaN(value) ? undefined : value;
}

function reduce(plan: CompactNativeRenderPlan, seriesIndex: number, reducerId: string) {
  if (!isReducerID(reducerId)) {
    throw new Error(`Unsupported compact legend reducer: ${reducerId}`);
  }
  return plan.reduce(seriesIndex, reducerId);
}
