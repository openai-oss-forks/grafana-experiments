import { css } from '@emotion/css';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { dateTimeFormat, TimeZone } from '@grafana/data';
import { t } from '@grafana/i18n';
import { DashboardCursorSync, SortOrder, TooltipDisplayMode } from '@grafana/schema';
import { getPortalContainer, Icon, useStyles2 } from '@grafana/ui';
import { VizTooltipRow } from '@grafana/ui/internal';
import { CompactNativeRenderPlan, CompactNativeSeriesFlag } from 'app/core/components/GraphNG/compactNativePlan';

interface CompactTooltipPluginProps {
  config: import('@grafana/ui').UPlotConfigBuilder;
  plan: CompactNativeRenderPlan;
  mode: TooltipDisplayMode;
  sortOrder?: SortOrder;
  hideZeros?: boolean;
  maxHeight?: number;
  maxWidth?: number;
  syncMode?: DashboardCursorSync;
  syncScope?: string;
  timeZone: TimeZone;
  queryZoom?: (range: { from: number; to: number }) => void;
  onAnnotationRange?: (range: { from: number; to: number }) => void;
}

interface HoverState {
  source: CompactNativeRenderPlan['source'];
  cursorIndex: number;
  focusedIndex: number;
  focusedSeries: number;
  viaSync: boolean;
}

const ROW_HEIGHT = 24;
const MIN_ZOOM_DISTANCE = 5;

export function CompactTooltipPlugin({
  config,
  plan,
  mode,
  sortOrder = SortOrder.None,
  hideZeros = false,
  maxHeight = 400,
  maxWidth,
  syncMode = DashboardCursorSync.Off,
  syncScope = 'global',
  timeZone,
  queryZoom,
  onAnnotationRange,
}: CompactTooltipPluginProps) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const [pinned, setPinned] = useState(false);
  const portal = useRef<HTMLElement>(getPortalContainer());
  const scrollRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<HoverState | null>(null);
  const pinnedRef = useRef(false);
  const queryZoomRef = useRef(queryZoom);
  const annotationRangeRef = useRef(onAnnotationRange);
  const syncModeRef = useRef(syncMode);
  const syncScopeRef = useRef(syncScope);
  const sourceRef = useRef(plan.source);
  const yZoomedRef = useRef(false);
  const sortedIndexesRef = useRef<Uint32Array>();
  const filteredIndexesRef = useRef<Uint32Array>();
  const tooltipValueStorageRef = useRef<Float64Array>();
  const positionRef = useRef({ left: 0, top: 0 });
  const clearHover = useCallback(() => {
    hoverRef.current = null;
    setHover(null);
  }, []);
  const clearTooltip = useCallback(() => {
    pinnedRef.current = false;
    setPinned(false);
    clearHover();
  }, [clearHover]);
  hoverRef.current = hover;
  pinnedRef.current = pinned;
  queryZoomRef.current = queryZoom;
  annotationRangeRef.current = onAnnotationRange;
  syncModeRef.current = syncMode;
  syncScopeRef.current = syncScope;
  sourceRef.current = plan.source;
  const styles = useStyles2(getStyles, maxWidth);
  const baseIndexes = useMemo(() => buildTooltipIndexes(plan), [plan]);
  const activeHover = hover?.source === plan.source ? hover : null;
  const hoverSource = activeHover?.source;
  const hoverCursorIndex = activeHover?.cursorIndex;
  const effectiveMode = activeHover?.viaSync ? TooltipDisplayMode.Multi : mode;
  const filteredTooltipIndexes = useMemo(() => {
    if (!hoverSource || hoverCursorIndex == null || effectiveMode === TooltipDisplayMode.Single) {
      return null;
    }
    const filtered = filterTooltipIndexes(
      baseIndexes,
      hoverSource,
      plan.getStyle,
      hoverCursorIndex,
      hideZeros,
      filteredIndexesRef.current,
      tooltipValueStorageRef.current
    );
    filteredIndexesRef.current = filtered.storage;
    tooltipValueStorageRef.current = filtered.valueStorage;
    return filtered;
  }, [baseIndexes, effectiveMode, hideZeros, hoverCursorIndex, hoverSource, plan.getStyle]);
  const visibleIndexes = filteredTooltipIndexes ?? baseIndexes;
  const indexes = useMemo(() => {
    if (!filteredTooltipIndexes || sortOrder === SortOrder.None) {
      return visibleIndexes;
    }
    const sorted = sortTooltipIndexes(filteredTooltipIndexes, sortOrder, sortedIndexesRef.current);
    sortedIndexesRef.current = sorted.storage;
    return sorted;
  }, [filteredTooltipIndexes, sortOrder, visibleIndexes]);
  const focusedValue =
    activeHover && activeHover.focusedSeries >= 0
      ? activeHover.source.yAt(activeHover.focusedSeries, activeHover.focusedIndex)
      : undefined;
  const focusedValueVisible =
    activeHover?.focusedSeries != null && activeHover.focusedSeries >= 0
      ? shouldShowTooltipValue(focusedValue, plan.getStyle(activeHover.focusedSeries).config.noValue, hideZeros)
      : false;
  const rowCount =
    effectiveMode === TooltipDisplayMode.Single
      ? activeHover && activeHover.focusedSeries >= 0 && focusedValueVisible
        ? 1
        : 0
      : indexes.length;
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  useLayoutEffect(() => {
    let initializedPlot: import('uplot') | undefined;
    let clickHandler: ((event: MouseEvent) => void) | undefined;
    let mouseDownHandler: ((event: MouseEvent) => void) | undefined;
    let shiftMouseUp: (() => void) | undefined;
    if (syncModeRef.current !== DashboardCursorSync.Off) {
      config.setCursor({ sync: { key: syncScopeRef.current, scales: ['x', null] } });
    }
    config.setCursor({
      bind: {
        dblclick: (plot) => () => {
          if (yZoomedRef.current) {
            for (const scaleKey of Object.keys(plot.scales)) {
              if (scaleKey !== 'x') {
                Reflect.apply(plot.setScale, plot, [scaleKey, { min: null, max: null }]);
              }
            }
            yZoomedRef.current = false;
          } else if (queryZoomRef.current != null) {
            const xScale = plot.scales.x;
            const padding = (xScale.max! - xScale.min!) / 2;
            queryZoomRef.current({ from: xScale.min! - padding, to: xScale.max! + padding });
          }
          return null;
        },
      },
    });
    config.addHook('init', (plot) => {
      initializedPlot = plot;
      clickHandler = (event: MouseEvent) => {
        if (event.target !== plot.over) {
          return;
        }
        if (event.ctrlKey || event.metaKey) {
          if (annotationRangeRef.current != null && plot.cursor.left != null) {
            const value = plot.posToVal(plot.cursor.left, 'x');
            annotationRangeRef.current({ from: value, to: value });
          }
          return;
        }
        if (hoverRef.current != null) {
          pinnedRef.current = true;
          setPinned(true);
        }
      };
      mouseDownHandler = (event: MouseEvent) => {
        if (event.button !== 0 || !event.shiftKey || event.ctrlKey || event.metaKey) {
          return;
        }
        plot.cursor.drag!.x = false;
        plot.cursor.drag!.y = true;
        shiftMouseUp?.();
        shiftMouseUp = () => {
          plot.cursor.drag!.x = true;
          plot.cursor.drag!.y = false;
          document.removeEventListener('mouseup', shiftMouseUp!, true);
          shiftMouseUp = undefined;
        };
        document.addEventListener('mouseup', shiftMouseUp, true);
      };
      plot.over.addEventListener('click', clickHandler);
      plot.over.addEventListener('mousedown', mouseDownHandler, true);
    });
    config.addHook('setSelect', (plot) => {
      const event = plot.cursor.event;
      const from = plot.posToVal(plot.select.left, 'x');
      const to = plot.posToVal(plot.select.left + plot.select.width, 'x');
      if ((event?.ctrlKey || event?.metaKey) && annotationRangeRef.current != null) {
        annotationRangeRef.current({ from, to });
      } else if (event?.shiftKey && plot.select.height >= MIN_ZOOM_DISTANCE) {
        for (const scaleKey of Object.keys(plot.scales)) {
          if (scaleKey !== 'x') {
            plot.setScale(scaleKey, {
              min: plot.posToVal(plot.select.top + plot.select.height, scaleKey),
              max: plot.posToVal(plot.select.top, scaleKey),
            });
          }
        }
        yZoomedRef.current = true;
      } else if (queryZoomRef.current != null && plot.select.width >= MIN_ZOOM_DISTANCE) {
        queryZoomRef.current({ from, to });
      }
      plot.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
    });
    config.addHook('setCursor', (plot) => {
      if (pinnedRef.current) {
        return;
      }
      const cursor = plot.compactCursor;
      const index = plot.cursor.idx;
      const viaSync = plot.cursor.event == null;
      if (
        !cursor ||
        index == null ||
        plot.cursor.left == null ||
        plot.cursor.left < 0 ||
        (viaSync && syncModeRef.current !== DashboardCursorSync.Tooltip)
      ) {
        if (hoverRef.current != null) {
          clearHover();
        }
        return;
      }

      positionRef.current.left = plot.rect.left + plot.cursor.left + 10;
      positionRef.current.top = plot.rect.top + (plot.cursor.top ?? 0) + 10;
      if (tooltipRef.current) {
        tooltipRef.current.style.transform = getTooltipTransform(positionRef.current);
      }

      const nextHover = {
        source: sourceRef.current,
        cursorIndex: index,
        focusedIndex: cursor.dataIndex,
        focusedSeries: cursor.seriesIndex,
        viaSync,
      };
      const previousHover = hoverRef.current;
      if (
        previousHover?.source === nextHover.source &&
        previousHover.cursorIndex === nextHover.cursorIndex &&
        previousHover.focusedIndex === nextHover.focusedIndex &&
        previousHover.focusedSeries === nextHover.focusedSeries &&
        previousHover.viaSync === nextHover.viaSync
      ) {
        return;
      }
      hoverRef.current = nextHover;
      setHover(nextHover);
    });
    config.addHook('setData', () => {
      yZoomedRef.current = false;
      clearTooltip();
    });
    return () => {
      if (initializedPlot && clickHandler) {
        initializedPlot.over.removeEventListener('click', clickHandler);
      }
      if (initializedPlot && mouseDownHandler) {
        initializedPlot.over.removeEventListener('mousedown', mouseDownHandler, true);
      }
      shiftMouseUp?.();
    };
  }, [clearHover, clearTooltip, config]);

  useLayoutEffect(() => {
    sortedIndexesRef.current = undefined;
    filteredIndexesRef.current = undefined;
    tooltipValueStorageRef.current = undefined;
    clearTooltip();
  }, [clearTooltip, plan.source]);

  useLayoutEffect(() => {
    if (!pinned) {
      return;
    }
    const dismiss = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') {
        return;
      }
      if (event instanceof MouseEvent && event.target instanceof Node && tooltipRef.current?.contains(event.target)) {
        return;
      }
      clearTooltip();
    };
    document.addEventListener('mousedown', dismiss, true);
    document.addEventListener('keydown', dismiss, true);
    return () => {
      document.removeEventListener('mousedown', dismiss, true);
      document.removeEventListener('keydown', dismiss, true);
    };
  }, [clearTooltip, pinned]);

  if (!activeHover) {
    return null;
  }

  const getSeriesIndex = (rowIndex: number) =>
    effectiveMode === TooltipDisplayMode.Single ? activeHover.focusedSeries : indexes.at(rowIndex);
  const valueIndex = effectiveMode === TooltipDisplayMode.Single ? activeHover.focusedIndex : activeHover.cursorIndex;
  const timestamp = plan.source.xAt(valueIndex);

  return createPortal(
    <div
      ref={tooltipRef}
      className={styles.tooltip}
      style={{
        transform: getTooltipTransform(positionRef.current),
        pointerEvents: pinned ? 'all' : 'none',
      }}
    >
      <div className={styles.header}>
        <span>{dateTimeFormat(timestamp, { timeZone })}</span>
        {pinned && (
          <button
            type="button"
            className={styles.close}
            aria-label={t('timeseries.compact-tooltip.close', 'Close tooltip')}
            onClick={clearTooltip}
          >
            <Icon name="times" />
          </button>
        )}
      </div>
      <div ref={scrollRef} className={styles.rows} style={{ height: Math.min(maxHeight, rowCount * ROW_HEIGHT) }}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((row) => {
            const seriesIndex = getSeriesIndex(row.index);
            const value = plan.source.yAt(seriesIndex, valueIndex);
            const display = plan.getDisplay(seriesIndex)(value);
            const style = plan.source.styles[plan.source.columns.styleIds[seriesIndex]];
            return (
              <div
                key={seriesIndex}
                ref={virtualizer.measureElement}
                className={styles.row}
                style={{ transform: `translateY(${row.start}px)` }}
                data-index={row.index}
              >
                <VizTooltipRow
                  label={plan.getDisplayName(seriesIndex)}
                  value={display.text}
                  color={display.color ?? style.stroke}
                  isActive={seriesIndex === activeHover.focusedSeries}
                  isPinned={pinned}
                  isHiddenFromViz={plan.source.columns.visibility[seriesIndex] === 0}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    portal.current
  );
}

interface CompactTooltipIndexes {
  readonly length: number;
  at(index: number): number;
}

interface FilteredTooltipIndexes extends CompactTooltipIndexes {
  readonly storage: Uint32Array;
  readonly valueStorage: Float64Array;
}

interface SortedTooltipIndexes extends CompactTooltipIndexes {
  readonly storage: Uint32Array;
}

export function filterTooltipIndexes(
  indexes: CompactTooltipIndexes,
  source: Pick<CompactNativeRenderPlan['source'], 'seriesCount' | 'yAt'>,
  getStyle: CompactNativeRenderPlan['getStyle'],
  valueIndex: number,
  hideZeros: boolean,
  target?: Uint32Array,
  valueTarget?: Float64Array
): FilteredTooltipIndexes {
  const storage = target && target.length >= indexes.length ? target : new Uint32Array(indexes.length);
  const valueStorage =
    valueTarget && valueTarget.length >= source.seriesCount ? valueTarget : new Float64Array(source.seriesCount);
  let length = 0;
  for (let index = 0; index < indexes.length; index++) {
    const seriesIndex = indexes.at(index);
    const value = source.yAt(seriesIndex, valueIndex);
    valueStorage[seriesIndex] = value ?? Number.NaN;
    if (shouldShowTooltipValue(value, getStyle(seriesIndex).config.noValue, hideZeros)) {
      storage[length++] = seriesIndex;
    }
  }
  return { storage, valueStorage, length, at: (index) => storage[index] };
}

function shouldShowTooltipValue(value: number | null | undefined, noValue: unknown, hideZeros: boolean): boolean {
  return !((value == null && noValue == null) || (hideZeros && value === 0));
}

function buildTooltipIndexes(plan: CompactNativeRenderPlan): CompactTooltipIndexes {
  let hiddenCount = 0;
  for (let seriesIndex = 0; seriesIndex < plan.seriesCount; seriesIndex++) {
    if ((plan.columns.flags[seriesIndex] & CompactNativeSeriesFlag.HiddenFromTooltip) !== 0) {
      hiddenCount++;
    }
  }
  if (hiddenCount === 0) {
    return { length: plan.seriesCount, at: (index) => index };
  }

  const indexes = new Uint32Array(plan.seriesCount - hiddenCount);
  let length = 0;
  for (let seriesIndex = 0; seriesIndex < plan.seriesCount; seriesIndex++) {
    if ((plan.columns.flags[seriesIndex] & CompactNativeSeriesFlag.HiddenFromTooltip) === 0) {
      indexes[length++] = seriesIndex;
    }
  }
  return { length: indexes.length, at: (index) => indexes[index] };
}

export function sortTooltipIndexes(
  indexes: FilteredTooltipIndexes,
  sortOrder: SortOrder,
  target?: Uint32Array
): SortedTooltipIndexes {
  const storage = target && target.length >= indexes.length ? target : new Uint32Array(indexes.length);
  const sorted = storage.length === indexes.length ? storage : storage.subarray(0, indexes.length);
  for (let index = 0; index < indexes.length; index++) {
    sorted[index] = indexes.at(index);
  }

  if (sortOrder === SortOrder.None || indexes.length < 2) {
    return { storage, length: sorted.length, at: (index) => sorted[index] };
  }

  const direction = sortOrder === SortOrder.Descending ? -1 : 1;
  const values = indexes.valueStorage;
  sorted.sort((leftSeries, rightSeries) => {
    const left = values[leftSeries];
    const right = values[rightSeries];
    const leftMissing = Number.isNaN(left);
    const rightMissing = Number.isNaN(right);

    if (leftMissing || rightMissing) {
      return leftMissing === rightMissing ? leftSeries - rightSeries : leftMissing ? 1 : -1;
    }
    if (left! < right!) {
      return -direction;
    }
    if (left! > right!) {
      return direction;
    }
    return leftSeries - rightSeries;
  });

  return { storage, length: sorted.length, at: (index) => sorted[index] };
}

function getTooltipTransform(position: { left: number; top: number }): string {
  return `translate(${position.left}px, ${position.top}px)`;
}

const getStyles = (theme: import('@grafana/data').GrafanaTheme2, maxWidth?: number) => ({
  tooltip: css({
    position: 'fixed',
    left: 0,
    top: 0,
    zIndex: 10000,
    maxWidth,
    minWidth: 240,
    background: theme.colors.background.elevated,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    boxShadow: '0 4px 10px rgb(0 0 0 / 20%)',
    pointerEvents: 'none',
  }),
  header: css({ padding: '8px', fontWeight: 500, display: 'flex', justifyContent: 'space-between' }),
  close: css({
    border: 0,
    background: 'transparent',
    color: theme.colors.text.secondary,
    cursor: 'pointer',
  }),
  rows: css({ overflowY: 'auto', position: 'relative' }),
  row: css({ position: 'absolute', left: 0, top: 0, width: '100%', minHeight: ROW_HEIGHT }),
});
