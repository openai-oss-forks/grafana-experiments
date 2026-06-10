import { useCallback } from 'react';
import * as React from 'react';

import { DataHoverClearEvent, DataHoverEvent } from '@grafana/data';
import { LegendDisplayMode } from '@grafana/schema';

import { SeriesVisibilityChangeMode, usePanelContext } from '../PanelChrome';

import { VizLegendList } from './VizLegendList';
import { VizLegendTable } from './VizLegendTable';
import { LegendProps, SeriesVisibilityChangeBehavior, VizLegendItem } from './types';
import { mapMouseEventToMode } from './utils';

/**
 * @public
 *
 * https://developers.grafana.com/ui/latest/index.html?path=/docs/plugins-vizlegend--docs
 */
export function VizLegend<T>({
  items,
  itemSource,
  thresholdItems,
  mappingItems,
  displayMode,
  sortBy: sortKey,
  seriesVisibilityChangeBehavior = SeriesVisibilityChangeBehavior.Isolate,
  sortDesc,
  onLabelClick,
  onSeriesVisibilityChange,
  onToggleSort,
  placement,
  className,
  itemRenderer,
  readonly,
  isSortable,
  getItemDisplayValues,
  displayValueColumns,
}: LegendProps<T>) {
  const { eventBus, onToggleSeriesVisibility, onToggleLegendSort } = usePanelContext();

  const onMouseOver = useCallback(
    (
      item: VizLegendItem,
      event: React.MouseEvent<HTMLButtonElement, MouseEvent> | React.FocusEvent<HTMLButtonElement>
    ) => {
      eventBus?.publish({
        type: DataHoverEvent.type,
        payload: {
          raw: event,
          x: 0,
          y: 0,
          dataId: item.label,
        },
      });
    },
    [eventBus]
  );

  const onMouseOut = useCallback(
    (
      item: VizLegendItem,
      event: React.MouseEvent<HTMLButtonElement, MouseEvent> | React.FocusEvent<HTMLButtonElement>
    ) => {
      eventBus?.publish({
        type: DataHoverClearEvent.type,
        payload: {
          raw: event,
          x: 0,
          y: 0,
          dataId: item.label,
        },
      });
    },
    [eventBus]
  );

  const onLegendLabelClick = useCallback(
    (item: VizLegendItem, event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
      if (onLabelClick) {
        onLabelClick(item, event);
      }
      if (onSeriesVisibilityChange) {
        onSeriesVisibilityChange(item, event);
      } else if (onToggleSeriesVisibility) {
        onToggleSeriesVisibility(
          item.fieldName ?? item.label,
          seriesVisibilityChangeBehavior === SeriesVisibilityChangeBehavior.Hide
            ? SeriesVisibilityChangeMode.AppendToSelection
            : mapMouseEventToMode(event)
        );
      }
    },
    [onToggleSeriesVisibility, onLabelClick, onSeriesVisibilityChange, seriesVisibilityChangeBehavior]
  );

  const makeVizLegendList = useCallback(
    (items: VizLegendItem[], indexedSource?: typeof itemSource) => {
      return (
        <VizLegendList<T>
          className={className}
          placement={placement}
          onLabelMouseOver={onMouseOver}
          onLabelMouseOut={onMouseOut}
          onLabelClick={onLegendLabelClick}
          itemRenderer={itemRenderer}
          readonly={readonly}
          items={items}
          itemSource={indexedSource}
          getItemDisplayValues={getItemDisplayValues}
        />
      );
    },
    [className, placement, onMouseOver, onMouseOut, onLegendLabelClick, itemRenderer, readonly, getItemDisplayValues]
  );

  switch (displayMode) {
    case LegendDisplayMode.Table:
      return (
        <VizLegendTable<T>
          className={className}
          items={items}
          itemSource={itemSource}
          placement={placement}
          sortBy={sortKey}
          sortDesc={sortDesc}
          onLabelClick={onLegendLabelClick}
          onToggleSort={onToggleSort || onToggleLegendSort}
          onLabelMouseOver={onMouseOver}
          onLabelMouseOut={onMouseOut}
          itemRenderer={itemRenderer}
          readonly={readonly}
          isSortable={isSortable}
          getItemDisplayValues={getItemDisplayValues}
          displayValueColumns={displayValueColumns}
        />
      );
    case LegendDisplayMode.List:
      const isThresholdsEnabled = thresholdItems && thresholdItems.length > 1;
      const isValueMappingEnabled = mappingItems && mappingItems.length > 0;
      const itemCount = itemSource?.length ?? items.length;
      return (
        <>
          {/* render items when single series and there is no thresholds and no value mappings
           * render items when multi series and there is no thresholds
           */}
          {!isThresholdsEnabled && (!isValueMappingEnabled || itemCount > 1) && makeVizLegendList(items, itemSource)}
          {/* render threshold colors if From thresholds scheme selected */}
          {isThresholdsEnabled && makeVizLegendList(thresholdItems, undefined)}
          {/* render value mapping colors */}
          {isValueMappingEnabled && makeVizLegendList(mappingItems, undefined)}
        </>
      );
    default:
      return null;
  }
}

VizLegend.displayName = 'VizLegend';
