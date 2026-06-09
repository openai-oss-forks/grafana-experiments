import { css, cx } from '@emotion/css';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { dateTimeFormat, formattedValueToString, getFieldColorMode, TimeZone } from '@grafana/data';
import { t } from '@grafana/i18n';
import { DashboardCursorSync, LineStyle, SortOrder, TooltipDisplayMode } from '@grafana/schema';
import { getPortalContainer, useStyles2 } from '@grafana/ui';
import {
  CloseButton,
  ColorIndicator,
  ColorPlacement,
  getCompactHoverStageProbe,
  getCompactRenderController,
  useFixedVirtualWindow,
  VizTooltipHeader,
  VizTooltipRow,
  VizTooltipWrapper,
  type CompactCursorSnapshot,
} from '@grafana/ui/internal';
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
  cursorRevision: number;
  focusedIndex: number;
  focusedSeries: number;
  viaSync: boolean;
}

const ROW_HEIGHT = 24;
const VIRTUALIZE_THRESHOLD = 40;
const DEFAULT_VIRTUAL_HEIGHT = 400;
const VIRTUAL_OVERSCAN = 12;
const TOOLTIP_OFFSET = 10;
const VIEWPORT_SCROLLBAR_WIDTH = 16;
const MIN_ZOOM_DISTANCE = 5;
const COMPACT_TOOLTIP_PIN_CHANGE_EVENT = 'grafana-compact-tooltip-pin-change';
const COMPACT_TOOLTIP_PINNED_ATTRIBUTE = 'data-compact-tooltip-pinned';
const hoverStageProbe = getCompactHoverStageProbe();

export function CompactTooltipPlugin({
  config,
  plan,
  mode,
  sortOrder = SortOrder.None,
  hideZeros = false,
  maxHeight,
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
  const modeRef = useRef(mode);
  const syncModeRef = useRef(syncMode);
  const syncScopeRef = useRef(syncScope);
  const sourceRef = useRef(plan.source);
  const plotRef = useRef<import('uplot')>();
  const pinnedSnapshotRef = useRef<CompactCursorSnapshot>();
  const yZoomedRef = useRef(false);
  const sortedIndexesRef = useRef<Uint32Array>();
  const filteredIndexesRef = useRef<Uint32Array>();
  const positionRef = useRef({ left: 0, top: 0 });
  const sizeRef = useRef({ width: 0, height: 0 });
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
  modeRef.current = mode;
  syncModeRef.current = syncMode;
  syncScopeRef.current = syncScope;
  sourceRef.current = plan.source;
  const styles = useStyles2(getStyles, maxWidth);
  const baseIndexes = useMemo(() => buildTooltipIndexes(plan), [plan]);
  const activeHover = hover?.source === plan.source ? hover : null;
  const hoverSource = activeHover?.source;
  const hoverCursorIndex = activeHover?.cursorIndex;
  const hoverCursorRevision = activeHover?.cursorRevision;
  const effectiveMode = activeHover?.viaSync ? TooltipDisplayMode.Multi : mode;
  const cursorSnapshot = useMemo(() => {
    if (
      !hoverSource ||
      hoverCursorIndex == null ||
      hoverCursorRevision == null ||
      effectiveMode === TooltipDisplayMode.Single
    ) {
      return null;
    }
    const snapshot = pinned
      ? (pinnedSnapshotRef.current ?? null)
      : getCompactRenderController(hoverSource).getCursorSnapshot(hoverCursorIndex);
    if (snapshot && snapshot.revision < hoverCursorRevision) {
      throw new Error('Compact tooltip cursor snapshot is older than the rendered hover state');
    }
    return snapshot;
  }, [effectiveMode, hoverCursorIndex, hoverCursorRevision, hoverSource, pinned]);
  const tooltipSnapshot = useMemo(
    () =>
      cursorSnapshot
        ? {
            seriesCount: cursorSnapshot.seriesCount,
            valueAt: (seriesIndex: number) => resolveMultiTooltipValue(plan.source, cursorSnapshot, seriesIndex),
          }
        : null,
    [cursorSnapshot, plan.source]
  );
  const filteredTooltipIndexes = useMemo(() => {
    if (!tooltipSnapshot || hoverCursorIndex == null) {
      return null;
    }
    const filtered = filterTooltipIndexes(
      baseIndexes,
      tooltipSnapshot,
      plan.getStyle,
      hideZeros,
      filteredIndexesRef.current
    );
    filteredIndexesRef.current = filtered.storage;
    return filtered;
  }, [baseIndexes, hideZeros, hoverCursorIndex, plan.getStyle, tooltipSnapshot]);
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
      ? tooltipSnapshot
        ? tooltipSnapshot.valueAt(activeHover.focusedSeries)
        : activeHover.source.yAt(activeHover.focusedSeries, activeHover.focusedIndex)
      : undefined;
  const focusedValueVisible =
    activeHover?.focusedSeries != null && activeHover.focusedSeries >= 0
      ? shouldShowTooltipValue(focusedValue, plan.getStyle(activeHover.focusedSeries).config.noValue, hideZeros)
      : false;
  const focusedSeriesToPromote =
    effectiveMode === TooltipDisplayMode.Multi &&
    activeHover != null &&
    activeHover.focusedSeries >= 0 &&
    focusedValueVisible &&
    indexes.length > 1
      ? activeHover.focusedSeries
      : -1;
  const focusedSeriesPosition = useMemo(
    () => (focusedSeriesToPromote >= 0 ? findTooltipIndex(indexes, focusedSeriesToPromote) : -1),
    [focusedSeriesToPromote, indexes]
  );
  const showFocusedSeries = focusedSeriesPosition >= 0;
  const rowCount =
    effectiveMode === TooltipDisplayMode.Single
      ? activeHover && activeHover.focusedSeries >= 0 && focusedValueVisible
        ? 1
        : 0
      : indexes.length - (showFocusedSeries ? 1 : 0);
  const isVirtualized = rowCount > VIRTUALIZE_THRESHOLD;
  const virtualHeight = maxHeight ?? DEFAULT_VIRTUAL_HEIGHT;
  const virtualWindow = useFixedVirtualWindow({
    containerRef: scrollRef,
    count: rowCount,
    itemSize: ROW_HEIGHT,
    overscan: VIRTUAL_OVERSCAN,
    enabled: isVirtualized && activeHover != null,
    initialViewportSize: virtualHeight,
  });
  const isTooltipVisible = activeHover != null && (rowCount > 0 || showFocusedSeries);

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
      plotRef.current = plot;
      if (pinnedRef.current) {
        plot.root.setAttribute(COMPACT_TOOLTIP_PINNED_ATTRIBUTE, 'true');
      }
      plot.root.dispatchEvent(new CustomEvent(COMPACT_TOOLTIP_PIN_CHANGE_EVENT, { bubbles: true }));
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
          const multi = hoverRef.current.viaSync || modeRef.current !== TooltipDisplayMode.Single;
          pinnedSnapshotRef.current = multi
            ? copyCursorSnapshot(
                getCompactRenderController(sourceRef.current).getCursorSnapshot(hoverRef.current.cursorIndex)
              )
            : undefined;
          // uPlot's private lock is the same mechanism used by the legacy tooltip.
          // @ts-ignore
          plot.cursor._lock = true;
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
    config.addHook('destroy', (plot) => {
      if (initializedPlot !== plot) {
        return;
      }
      if (clickHandler) {
        plot.over.removeEventListener('click', clickHandler);
      }
      if (mouseDownHandler) {
        plot.over.removeEventListener('mousedown', mouseDownHandler, true);
      }
      // @ts-ignore
      plot.cursor._lock = false;
      plot.root.removeAttribute(COMPACT_TOOLTIP_PINNED_ATTRIBUTE);
      plot.root.dispatchEvent(new CustomEvent(COMPACT_TOOLTIP_PIN_CHANGE_EVENT, { bubbles: true }));
      initializedPlot = undefined;
      plotRef.current = undefined;
      pinnedSnapshotRef.current = undefined;
      shiftMouseUp?.();
      clearTooltip();
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
      if (viaSync && !isCompactTooltipPlotVisible(plot)) {
        if (hoverRef.current != null) {
          clearHover();
        }
        return;
      }
      const controller = getCompactRenderController(sourceRef.current);
      const snapshot =
        viaSync || modeRef.current !== TooltipDisplayMode.Single
          ? controller.getCursorSnapshot(index, plot)
          : undefined;
      if (viaSync && !snapshot) {
        if (hoverRef.current != null) {
          clearHover();
        }
        return;
      }

      positionRef.current.left = plot.rect.left + plot.cursor.left;
      positionRef.current.top = plot.rect.top + (plot.cursor.top ?? 0);
      if (tooltipRef.current) {
        tooltipRef.current.style.transform = getTooltipTransform(positionRef.current, sizeRef.current);
      }

      const nextHover = {
        source: sourceRef.current,
        cursorIndex: index,
        cursorRevision: !viaSync && modeRef.current === TooltipDisplayMode.Single ? 0 : snapshot!.revision,
        focusedIndex: cursor.dataIndex,
        focusedSeries: cursor.seriesIndex,
        viaSync,
      };
      const previousHover = hoverRef.current;
      if (
        previousHover?.source === nextHover.source &&
        previousHover.cursorIndex === nextHover.cursorIndex &&
        previousHover.cursorRevision === nextHover.cursorRevision &&
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
      if (initializedPlot) {
        // @ts-ignore
        initializedPlot.cursor._lock = false;
        initializedPlot.root.removeAttribute(COMPACT_TOOLTIP_PINNED_ATTRIBUTE);
        initializedPlot.root.dispatchEvent(new CustomEvent(COMPACT_TOOLTIP_PIN_CHANGE_EVENT, { bubbles: true }));
      }
      plotRef.current = undefined;
      shiftMouseUp?.();
    };
  }, [clearHover, clearTooltip, config]);

  useLayoutEffect(() => {
    const plot = plotRef.current;
    if (!plot) {
      return;
    }
    if (pinned) {
      plot.root.setAttribute(COMPACT_TOOLTIP_PINNED_ATTRIBUTE, 'true');
    } else {
      // @ts-ignore
      plot.cursor._lock = false;
      pinnedSnapshotRef.current = undefined;
      plot.root.removeAttribute(COMPACT_TOOLTIP_PINNED_ATTRIBUTE);
    }
    plot.root.dispatchEvent(new CustomEvent(COMPACT_TOOLTIP_PIN_CHANGE_EVENT, { bubbles: true }));
  }, [pinned]);

  useLayoutEffect(() => {
    clearTooltip();
  }, [clearTooltip, config]);

  useLayoutEffect(() => {
    sortedIndexesRef.current = undefined;
    filteredIndexesRef.current = undefined;
    pinnedSnapshotRef.current = undefined;
    clearTooltip();
  }, [clearTooltip, plan.source]);

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!tooltip) {
      return;
    }
    const updateSizeAndPosition = () => {
      const bounds = tooltip.getBoundingClientRect();
      sizeRef.current.width = bounds.width;
      sizeRef.current.height = bounds.height;
      tooltip.style.transform = getTooltipTransform(positionRef.current, sizeRef.current);
    };
    updateSizeAndPosition();
    const observer = new ResizeObserver(updateSizeAndPosition);
    observer.observe(tooltip);
    return () => observer.disconnect();
  }, [isTooltipVisible]);

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

  useLayoutEffect(() => {
    const dismissIfOffscreen = () => {
      const plot = plotRef.current;
      if (!pinnedRef.current && hoverRef.current != null && plot && !isCompactTooltipPlotVisible(plot)) {
        clearHover();
      }
    };
    window.addEventListener('resize', dismissIfOffscreen);
    window.addEventListener('scroll', dismissIfOffscreen, true);
    return () => {
      window.removeEventListener('resize', dismissIfOffscreen);
      window.removeEventListener('scroll', dismissIfOffscreen, true);
    };
  }, [clearHover]);

  if (!activeHover || (rowCount === 0 && !showFocusedSeries)) {
    return null;
  }

  const getSeriesIndex = (rowIndex: number) => {
    if (effectiveMode === TooltipDisplayMode.Single) {
      return activeHover.focusedSeries;
    }
    if (!showFocusedSeries) {
      return indexes.at(rowIndex);
    }
    return indexes.at(rowIndex < focusedSeriesPosition ? rowIndex : rowIndex + 1);
  };
  const valueIndex = effectiveMode === TooltipDisplayMode.Single ? activeHover.focusedIndex : activeHover.cursorIndex;
  const timestamp = plan.source.xAt(valueIndex);
  const rowsStyle = isVirtualized
    ? { height: virtualHeight, maxHeight: virtualHeight, minHeight: 0, overflowY: 'auto' as const }
    : maxHeight != null
      ? { maxHeight, overflowY: 'auto' as const }
      : undefined;
  const focusedSeriesRow = showFocusedSeries
    ? getTooltipRowModel(
        plan,
        activeHover.focusedSeries,
        focusedValue,
        plan.source.columns.visibility[activeHover.focusedSeries] === 0
      )
    : null;
  const renderRow = (rowIndex: number, virtualStart?: number) => {
    const seriesIndex = getSeriesIndex(rowIndex);
    const value =
      effectiveMode === TooltipDisplayMode.Single
        ? resolveTooltipValue(plan.source, seriesIndex, valueIndex)
        : filteredTooltipIndexes?.valueAt(seriesIndex);
    const row = getTooltipRowModel(plan, seriesIndex, value, plan.source.columns.visibility[seriesIndex] === 0);

    return (
      <div
        key={pinned ? seriesIndex : rowIndex}
        className={virtualStart == null ? undefined : styles.virtualRow}
        style={virtualStart == null ? undefined : { transform: `translateY(${virtualStart}px)` }}
        data-index={rowIndex}
        title={row.accessibleText}
        aria-label={row.accessibleText}
        role="listitem"
        aria-posinset={rowIndex + 1}
        aria-setsize={rowCount}
      >
        <VizTooltipRow
          label={row.displayName}
          value={row.formattedValue}
          color={row.color}
          colorIndicator={row.colorIndicator}
          colorPlacement={row.colorPlacement}
          isActive={seriesIndex === activeHover.focusedSeries}
          isPinned={pinned}
          lineStyle={row.lineStyle}
          isHiddenFromViz={row.isHiddenFromViz}
        />
      </div>
    );
  };

  return createPortal(
    <div
      ref={tooltipRef}
      className={cx(styles.tooltip, pinned && styles.pinned)}
      style={{
        transform: getTooltipTransform(positionRef.current, sizeRef.current),
        pointerEvents: pinned ? 'all' : 'none',
      }}
      aria-live="polite"
      aria-atomic="true"
    >
      {pinned && <CloseButton onClick={clearTooltip} />}
      <VizTooltipWrapper>
        <VizTooltipHeader item={{ label: '', value: dateTimeFormat(timestamp, { timeZone }) }} isPinned={pinned} />
        {focusedSeriesRow && (
          <div
            className={styles.focusedSeries}
            style={{ borderLeftColor: focusedSeriesRow.color }}
            title={focusedSeriesRow.accessibleText}
            aria-label={t('timeseries.compact-tooltip.focused-series-label', 'Focused series: {{series}}', {
              series: focusedSeriesRow.accessibleText,
            })}
            data-testid="compact-tooltip-focused-series"
            data-series-index={activeHover.focusedSeries}
          >
            <div className={styles.focusedSeriesHeading}>
              {t('timeseries.compact-tooltip.focused-series-heading', 'Focused series')}
            </div>
            <VizTooltipRow
              label={focusedSeriesRow.displayName}
              value={focusedSeriesRow.formattedValue}
              color={focusedSeriesRow.color}
              colorIndicator={focusedSeriesRow.colorIndicator}
              colorPlacement={focusedSeriesRow.colorPlacement}
              isActive
              isPinned={pinned}
              lineStyle={focusedSeriesRow.lineStyle}
              isHiddenFromViz={focusedSeriesRow.isHiddenFromViz}
              wrapLabel
            />
          </div>
        )}
        <div ref={scrollRef} className={styles.rows} style={rowsStyle} role="list">
          {isVirtualized ? (
            <div className={styles.virtualContent} style={{ height: virtualWindow.totalSize }}>
              {virtualWindow.virtualItems.map((row) => renderRow(row.index, row.start))}
            </div>
          ) : (
            Array.from({ length: rowCount }, (_, rowIndex) => renderRow(rowIndex))
          )}
        </div>
      </VizTooltipWrapper>
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
  valueAt(seriesIndex: number): number | null | undefined;
}

interface SortedTooltipIndexes extends CompactTooltipIndexes {
  readonly storage: Uint32Array;
}

interface TooltipRowModel {
  displayName: string;
  formattedValue: string;
  accessibleText: string;
  color: string;
  colorIndicator: ColorIndicator;
  colorPlacement: ColorPlacement;
  lineStyle: LineStyle | undefined;
  isHiddenFromViz: boolean;
}

const enum TooltipValueState {
  Undefined,
  Null,
  Number,
}

function copyCursorSnapshot(snapshot: CompactCursorSnapshot): CompactCursorSnapshot {
  const cursorIndex = snapshot.cursorIndex;
  const values = new Float64Array(snapshot.seriesCount);
  const states = new Uint8Array(snapshot.seriesCount);
  let dataIndexes: Int32Array | undefined;
  for (let seriesIndex = 0; seriesIndex < snapshot.seriesCount; seriesIndex++) {
    const value = snapshot.valueAt(seriesIndex);
    const dataIndex = snapshot.dataIndexAt(seriesIndex);
    if (dataIndex !== cursorIndex) {
      if (!dataIndexes) {
        dataIndexes = new Int32Array(snapshot.seriesCount);
        dataIndexes.fill(cursorIndex);
      }
      dataIndexes[seriesIndex] = dataIndex;
    }
    if (value === undefined) {
      states[seriesIndex] = TooltipValueState.Undefined;
    } else if (value === null) {
      states[seriesIndex] = TooltipValueState.Null;
    } else {
      states[seriesIndex] = TooltipValueState.Number;
      values[seriesIndex] = value;
    }
  }
  return {
    source: snapshot.source,
    seriesCount: snapshot.seriesCount,
    cursorIndex,
    timestamp: snapshot.timestamp,
    revision: snapshot.revision,
    valueAt: (seriesIndex) => {
      switch (states[seriesIndex]) {
        case TooltipValueState.Null:
          return null;
        case TooltipValueState.Number:
          return values[seriesIndex];
        default:
          return undefined;
      }
    },
    dataIndexAt: (seriesIndex) => dataIndexes?.[seriesIndex] ?? cursorIndex,
  };
}

export function isCompactTooltipPlotVisible(plot: import('uplot')): boolean {
  const width = window.innerWidth - VIEWPORT_SCROLLBAR_WIDTH;
  const height = window.innerHeight - VIEWPORT_SCROLLBAR_WIDTH;
  return plot.rect.bottom > 0 && plot.rect.top < height && plot.rect.right > 0 && plot.rect.left < width;
}

export function filterTooltipIndexes(
  indexes: CompactTooltipIndexes,
  snapshot: Pick<CompactCursorSnapshot, 'seriesCount' | 'valueAt'>,
  getStyle: CompactNativeRenderPlan['getStyle'],
  hideZeros: boolean,
  target?: Uint32Array
): FilteredTooltipIndexes {
  const startedAt = hoverStageProbe ? performance.now() : 0;
  const storage = target && target.length >= indexes.length ? target : new Uint32Array(indexes.length);
  let length = 0;
  for (let index = 0; index < indexes.length; index++) {
    const seriesIndex = indexes.at(index);
    const value = snapshot.valueAt(seriesIndex);
    if (shouldShowTooltipValue(value, getStyle(seriesIndex).config.noValue, hideZeros)) {
      storage[length++] = seriesIndex;
    }
  }
  const filtered = {
    storage,
    length,
    at: (index: number) => storage[index],
    valueAt: (seriesIndex: number) => snapshot.valueAt(seriesIndex),
  };
  hoverStageProbe?.record('tooltipFilter', {
    durationMs: performance.now() - startedAt,
    seriesVisits: indexes.length,
    visibleRows: length,
  });
  return filtered;
}

export function resolveTooltipValue(
  source: Pick<CompactNativeRenderPlan['source'], 'yAt' | 'nearestPresent'>,
  seriesIndex: number,
  valueIndex: number
) {
  const value = source.yAt(seriesIndex, valueIndex);
  if (value != null) {
    return value;
  }
  const nearestIndex = source.nearestPresent(seriesIndex, valueIndex, 0);
  return nearestIndex == null ? value : source.yAt(seriesIndex, nearestIndex);
}

export function resolveMultiTooltipValue(
  source: {
    yAt(seriesIndex: number, index: number): number | null | undefined;
  },
  snapshot: Pick<CompactCursorSnapshot, 'cursorIndex' | 'valueAt' | 'dataIndexAt'>,
  seriesIndex: number
) {
  const value = snapshot.valueAt(seriesIndex);
  if (value !== undefined) {
    return value;
  }
  const resolvedIndex = snapshot.dataIndexAt(seriesIndex);
  return resolvedIndex === snapshot.cursorIndex ? value : source.yAt(seriesIndex, resolvedIndex);
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

export function findTooltipIndex(indexes: CompactTooltipIndexes, seriesIndex: number): number {
  for (let index = 0; index < indexes.length; index++) {
    if (indexes.at(index) === seriesIndex) {
      return index;
    }
  }
  return -1;
}

function getTooltipRowModel(
  plan: CompactNativeRenderPlan,
  seriesIndex: number,
  value: number | null | undefined,
  isHiddenFromViz: boolean
): TooltipRowModel {
  const displayName = plan.getDisplayName(seriesIndex);
  const display = plan.getDisplay(seriesIndex)(value);
  const formattedValue = formattedValueToString(display);
  const planStyle = plan.getStyle(seriesIndex);
  const rendererStyle = plan.source.styles[plan.source.columns.styleIds[seriesIndex]];
  const isByValue = getFieldColorMode(planStyle.config.color?.mode).isByValue;
  return {
    displayName,
    formattedValue,
    accessibleText: `${displayName}: ${formattedValue}`,
    color: isByValue ? (display.color ?? rendererStyle.stroke) : rendererStyle.stroke,
    colorIndicator: isByValue ? ColorIndicator.value : ColorIndicator.series,
    colorPlacement: isByValue ? ColorPlacement.trailing : ColorPlacement.first,
    lineStyle: planStyle.config.custom?.lineStyle,
    isHiddenFromViz,
  };
}

export function sortTooltipIndexes(
  indexes: FilteredTooltipIndexes,
  sortOrder: SortOrder,
  target?: Uint32Array
): SortedTooltipIndexes {
  const startedAt = hoverStageProbe ? performance.now() : 0;
  const storage = target && target.length >= indexes.length ? target : new Uint32Array(indexes.length);
  const sorted = storage.length === indexes.length ? storage : storage.subarray(0, indexes.length);
  for (let index = 0; index < indexes.length; index++) {
    sorted[index] = indexes.at(index);
  }

  if (sortOrder === SortOrder.None || indexes.length < 2) {
    const result = { storage, length: sorted.length, at: (index: number) => sorted[index] };
    hoverStageProbe?.record('tooltipSort', {
      durationMs: performance.now() - startedAt,
      seriesVisits: sorted.length,
    });
    return result;
  }

  const direction = sortOrder === SortOrder.Descending ? -1 : 1;
  sorted.sort((leftSeries, rightSeries) => {
    const left = indexes.valueAt(leftSeries);
    const right = indexes.valueAt(rightSeries);
    const leftMissing = left == null || Number.isNaN(left);
    const rightMissing = right == null || Number.isNaN(right);

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

  const result = { storage, length: sorted.length, at: (index: number) => sorted[index] };
  hoverStageProbe?.record('tooltipSort', {
    durationMs: performance.now() - startedAt,
    seriesVisits: sorted.length,
  });
  return result;
}

export function getTooltipTransform(
  position: { left: number; top: number },
  size: { width: number; height: number },
  viewport = {
    width: window.innerWidth - VIEWPORT_SCROLLBAR_WIDTH,
    height: window.innerHeight - VIEWPORT_SCROLLBAR_WIDTH,
  }
): string {
  const placeLeft = position.left + size.width + TOOLTIP_OFFSET > viewport.width && position.left - size.width >= 0;
  const placeAbove = position.top + size.height + TOOLTIP_OFFSET > viewport.height && position.top - size.height >= 0;
  const shiftX = position.left + (placeLeft ? -TOOLTIP_OFFSET : TOOLTIP_OFFSET);
  const shiftY = position.top + (placeAbove ? -TOOLTIP_OFFSET : TOOLTIP_OFFSET);
  const reflectX = placeLeft ? ' translateX(-100%)' : '';
  const reflectY = placeAbove ? ' translateY(-100%)' : '';
  return `translateX(${shiftX}px)${reflectX} translateY(${shiftY}px)${reflectY}`;
}

const getStyles = (theme: import('@grafana/data').GrafanaTheme2, maxWidth?: number) => ({
  tooltip: css({
    top: 0,
    left: 0,
    zIndex: theme.zIndex.tooltip,
    whiteSpace: 'pre',
    background: theme.colors.background.elevated,
    borderRadius: theme.shape.radius.default,
    position: 'fixed',
    border: `1px solid ${theme.colors.border.weak}`,
    boxShadow: theme.shadows.z2,
    userSelect: 'text',
    maxWidth: maxWidth ?? 'none',
  }),
  pinned: css({
    boxShadow: theme.shadows.z3,
  }),
  rows: css({
    display: 'flex',
    flexDirection: 'column',
    flex: '0 1 auto',
    gap: 2,
    minHeight: 0,
    borderTop: `1px solid ${theme.colors.border.weak}`,
    padding: theme.spacing(1),
  }),
  focusedSeries: css({
    borderTop: `1px solid ${theme.colors.border.weak}`,
    borderLeft: `3px solid ${theme.colors.border.medium}`,
    background: theme.colors.background.secondary,
    padding: theme.spacing(1),
    whiteSpace: 'normal',
  }),
  focusedSeriesHeading: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    fontWeight: theme.typography.fontWeightMedium,
    lineHeight: 1,
    marginBottom: theme.spacing(0.75),
  }),
  virtualContent: css({
    flex: '0 0 auto',
    position: 'relative',
    width: '100%',
  }),
  virtualRow: css({
    height: ROW_HEIGHT,
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    top: 0,
    whiteSpace: 'nowrap',
    width: '100%',
  }),
});
