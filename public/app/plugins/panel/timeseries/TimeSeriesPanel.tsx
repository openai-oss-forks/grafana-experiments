import { useMemo, useState } from 'react';

import {
  CompactTimeSeriesData,
  PanelProps,
  DataFrameType,
  DashboardCursorSync,
  DataFrame,
  alignTimeRangeCompareData,
  shouldAlignTimeCompare,
  useDataLinksContext,
  FieldConfigSource,
  FieldType,
  LoadingState,
} from '@grafana/data';
import { config, getPluginImportUtils, PanelDataErrorView } from '@grafana/runtime';
import { TooltipDisplayMode, VizOrientation } from '@grafana/schema';
import {
  EventBusPlugin,
  KeyboardPlugin,
  TooltipPlugin2,
  XAxisInteractionAreaPlugin,
  usePanelContext,
  useTheme2,
} from '@grafana/ui';
import { FILTER_OUT_OPERATOR, TimeRange2, TooltipHoverMode } from '@grafana/ui/internal';
import { TimeSeries } from 'app/core/components/TimeSeries/TimeSeries';
import { getEffectiveCursorSync } from 'app/core/utils/cursorSync';
import {
  getCompactTimeSeriesCapability,
  isCompactTimeSeriesPanelConfigurationSupported,
} from 'app/features/query/state/compactQueryPolicy';

import { CompactTooltipPlugin } from './CompactTooltipPlugin';
import { TimeSeriesTooltip } from './TimeSeriesTooltip';
import { Options } from './panelcfg.gen';
import { AnnotationsPlugin2 } from './plugins/AnnotationsPlugin2';
import { CompactOutsideRangePlugin } from './plugins/CompactOutsideRangePlugin';
import { ExemplarsPlugin, getVisibleLabels } from './plugins/ExemplarsPlugin';
import { OutsideRangePlugin } from './plugins/OutsideRangePlugin';
import { ThresholdControlsPlugin } from './plugins/ThresholdControlsPlugin';
import { getXAnnotationFrames } from './plugins/utils';
import { getPrepareTimeseriesSuggestion } from './suggestions';
import { getGroupedFilters, getTimezones, prepareGraphableFields } from './utils';

interface TimeSeriesPanelProps extends PanelProps<Options> {}

export function getRenderableCompactSeries(
  compactSeries: CompactTimeSeriesData | undefined,
  fieldConfig: FieldConfigSource,
  options: Options,
  hasFullFormatRequest = false
): CompactTimeSeriesData | undefined {
  return compactSeries &&
    compactSeries.series.length > 0 &&
    !hasFullFormatRequest &&
    isCompactTimeSeriesPanelConfigurationSupported({
      fieldConfig,
      legendCalcs: Array.isArray(options.legend?.calcs) ? options.legend.calcs : undefined,
      panelOptions: options,
    })
    ? compactSeries
    : undefined;
}

export const TimeSeriesPanel = ({
  data,
  timeRange,
  timeZone,
  width,
  height,
  options,
  fieldConfig,
  onChangeTimeRange,
  replaceVariables,
  id,
}: TimeSeriesPanelProps) => {
  const {
    sync,
    eventsScope,
    canAddAnnotations,
    onThresholdsChange,
    canEditThresholds,
    showThresholds,
    eventBus,
    canExecuteActions,
    getFiltersBasedOnGrouping,
    onAddAdHocFilters,
  } = usePanelContext();

  const { dataLinkPostProcessor } = useDataLinksContext();
  const theme = useTheme2();

  const userCanExecuteActions = useMemo(() => canExecuteActions?.() ?? false, [canExecuteActions]);
  const hasFullFormatRequest = data.request != null && data.request.preferredQueryResultFormat !== 'compact-v1';
  const compactSeries = getRenderableCompactSeries(data.compactSeries, fieldConfig, options, hasFullFormatRequest);
  const hasCompactSeries = Boolean(compactSeries);
  // Vertical orientation is not available for users through config.
  // It is simplified version of horizontal time series panel and it does not support all plugins.
  const isVerticallyOriented = options.orientation === VizOrientation.Vertical;
  const { frames, compareDiffMs } = useMemo(() => {
    if (compactSeries) {
      return { frames: [] };
    }
    let frames = prepareGraphableFields(data.series, theme, timeRange);
    if (frames != null) {
      let compareDiffMs: number[] = [0];

      frames.forEach((frame: DataFrame) => {
        const diffMs = frame.meta?.timeCompare?.diffMs ?? 0;

        frame.fields.forEach((field) => {
          if (field.type !== FieldType.time) {
            compareDiffMs.push(diffMs);
          }
        });

        if (diffMs !== 0) {
          // Check if the compared frame needs time alignment
          // Apply alignment when time ranges match (no shift applied yet)
          const needsAlignment = shouldAlignTimeCompare(frame, frames, timeRange);

          if (needsAlignment) {
            alignTimeRangeCompareData(frame, diffMs, config.theme2);
          }
        }
      });

      return { frames, compareDiffMs };
    }

    return { frames };
  }, [compactSeries, data.series, theme, timeRange]);

  const compactFieldConfig = useMemo(() => {
    if (!hasCompactSeries) {
      return undefined;
    }
    const plugin = getPluginImportUtils().getPanelPluginFromCache('timeseries');
    if (!plugin) {
      throw new Error('Timeseries panel plugin is not loaded');
    }
    return {
      fieldConfig,
      fieldConfigRegistry: plugin.fieldConfigRegistry,
      replaceVariables,
      theme,
      timeZone,
      dataLinkPostProcessor,
      cursorMode: options.tooltip.mode,
      highlightSeriesOnHover: options.highlightSeriesOnHover !== false,
      capability: getCompactTimeSeriesCapability(fieldConfig),
    };
  }, [
    dataLinkPostProcessor,
    fieldConfig,
    hasCompactSeries,
    options.highlightSeriesOnHover,
    options.tooltip.mode,
    replaceVariables,
    theme,
    timeZone,
  ]);

  const timezones = useMemo(() => getTimezones(options.timezone, timeZone), [options.timezone, timeZone]);
  const suggestions = useMemo(() => {
    if (frames?.length && frames.every((df) => df.meta?.type === DataFrameType.TimeSeriesLong)) {
      const s = getPrepareTimeseriesSuggestion(id);
      return {
        message: 'Long data must be converted to wide',
        suggestions: s ? [s] : undefined,
      };
    }
    return undefined;
  }, [frames, id]);

  const enableAnnotationCreation = Boolean(canAddAnnotations && canAddAnnotations());
  const [newAnnotationRange, setNewAnnotationRange] = useState<TimeRange2 | null>(null);
  const cursorSync = getEffectiveCursorSync(sync?.());

  if ((!frames && !compactSeries) || suggestions) {
    return (
      <PanelDataErrorView
        panelId={id}
        message={suggestions?.message}
        fieldConfig={fieldConfig}
        data={data}
        needsTimeField={true}
        needsNumberField={true}
        suggestions={suggestions?.suggestions}
      />
    );
  }

  return (
    <TimeSeries
      frames={frames ?? []}
      compactSeries={compactSeries}
      compactFieldConfig={compactFieldConfig}
      compactStreaming={Boolean(compactSeries && data.state === LoadingState.Streaming)}
      compactRequestKey={data.request?.requestId}
      structureRev={data.structureRev}
      timeRange={timeRange}
      timeZone={timezones}
      width={width}
      height={height}
      legend={options.legend}
      options={options}
      highlightSeriesOnHover={options.highlightSeriesOnHover !== false}
      replaceVariables={replaceVariables}
      dataLinkPostProcessor={dataLinkPostProcessor}
      cursorSync={cursorSync}
      annotationLanes={options.annotations?.multiLane ? getXAnnotationFrames(data.annotations).length : undefined}
      compactChildren={(uplotConfig, plan) => (
        <>
          {!options.disableKeyboardEvents && <KeyboardPlugin config={uplotConfig} />}
          {cursorSync !== DashboardCursorSync.Off && (
            <EventBusPlugin config={uplotConfig} eventBus={eventBus} compact />
          )}
          <XAxisInteractionAreaPlugin config={uplotConfig} queryZoom={onChangeTimeRange} />
          <CompactTooltipPlugin
            config={uplotConfig}
            plan={plan}
            mode={options.tooltip.mode}
            sortOrder={options.tooltip.sort}
            hideZeros={options.tooltip.hideZeros}
            maxHeight={options.tooltip.maxHeight}
            maxWidth={options.tooltip.maxWidth}
            syncMode={cursorSync}
            syncScope={eventsScope}
            timeZone={timeZone}
            queryZoom={onChangeTimeRange}
            onAnnotationRange={
              enableAnnotationCreation
                ? (range) => {
                    setNewAnnotationRange(range);
                  }
                : undefined
            }
          />
          {!isVerticallyOriented && (
            <>
              <AnnotationsPlugin2
                replaceVariables={replaceVariables}
                multiLane={options.annotations?.multiLane}
                annotations={data.annotations ?? []}
                config={uplotConfig}
                timeZone={timeZone}
                newRange={newAnnotationRange}
                setNewRange={setNewAnnotationRange}
              />
              <CompactOutsideRangePlugin config={uplotConfig} plan={plan} onChangeTimeRange={onChangeTimeRange} />
              {data.annotations && (
                <ExemplarsPlugin
                  config={uplotConfig}
                  exemplars={data.annotations}
                  timeZone={timeZone}
                  maxHeight={options.tooltip.maxHeight}
                  maxWidth={options.tooltip.maxWidth}
                />
              )}
              {((canEditThresholds && onThresholdsChange) || showThresholds) && (
                <ThresholdControlsPlugin
                  config={uplotConfig}
                  fieldConfig={fieldConfig}
                  onThresholdsChange={canEditThresholds ? onThresholdsChange : undefined}
                />
              )}
            </>
          )}
        </>
      )}
    >
      {(uplotConfig, alignedFrame, sourceFrames) => {
        return (
          <>
            {!options.disableKeyboardEvents && <KeyboardPlugin config={uplotConfig} />}
            {cursorSync !== DashboardCursorSync.Off && (
              <EventBusPlugin config={uplotConfig} eventBus={eventBus} frame={alignedFrame} />
            )}
            <XAxisInteractionAreaPlugin config={uplotConfig} queryZoom={onChangeTimeRange} />
            {options.tooltip.mode !== TooltipDisplayMode.None && (
              <TooltipPlugin2
                config={uplotConfig}
                hoverMode={
                  options.tooltip.mode === TooltipDisplayMode.Single ? TooltipHoverMode.xOne : TooltipHoverMode.xAll
                }
                queryZoom={onChangeTimeRange}
                clientZoom={true}
                syncMode={cursorSync}
                syncScope={eventsScope}
                getDataLinks={(seriesIdx, dataIdx) =>
                  alignedFrame.fields[seriesIdx].getLinks?.({ valueRowIndex: dataIdx }) ?? []
                }
                render={(u, dataIdxs, seriesIdx, isPinned = false, dismiss, timeRange2, viaSync, dataLinks) => {
                  if (enableAnnotationCreation && timeRange2 != null) {
                    setNewAnnotationRange(timeRange2);
                    dismiss();
                    return;
                  }

                  const annotate = () => {
                    let xVal = u.posToVal(u.cursor.left!, 'x');

                    setNewAnnotationRange({ from: xVal, to: xVal });
                    dismiss();
                  };

                  const groupingFilters =
                    seriesIdx !== null && config.featureToggles.perPanelFiltering && getFiltersBasedOnGrouping
                      ? getGroupedFilters(alignedFrame, seriesIdx, getFiltersBasedOnGrouping)
                      : [];

                  return (
                    // not sure it header time here works for annotations, since it's taken from nearest datapoint index
                    <TimeSeriesTooltip
                      series={alignedFrame}
                      dataIdxs={dataIdxs}
                      seriesIdx={seriesIdx}
                      mode={viaSync ? TooltipDisplayMode.Multi : options.tooltip.mode}
                      sortOrder={options.tooltip.sort}
                      hideZeros={options.tooltip.hideZeros}
                      isPinned={isPinned}
                      annotate={enableAnnotationCreation ? annotate : undefined}
                      maxHeight={options.tooltip.maxHeight}
                      replaceVariables={replaceVariables}
                      dataLinks={dataLinks}
                      filterByGroupedLabels={
                        config.featureToggles.perPanelFiltering && groupingFilters.length && onAddAdHocFilters
                          ? {
                              onFilterForGroupedLabels: () => onAddAdHocFilters(groupingFilters),
                              onFilterOutGroupedLabels: () =>
                                onAddAdHocFilters(
                                  groupingFilters.map((item) => ({ ...item, operator: FILTER_OUT_OPERATOR }))
                                ),
                            }
                          : undefined
                      }
                      canExecuteActions={userCanExecuteActions}
                      compareDiffMs={compareDiffMs}
                      highlightSeriesOnHover={options.highlightSeriesOnHover !== false}
                    />
                  );
                }}
                maxWidth={options.tooltip.maxWidth}
              />
            )}
            {!isVerticallyOriented && (
              <>
                <AnnotationsPlugin2
                  replaceVariables={replaceVariables}
                  multiLane={options.annotations?.multiLane}
                  annotations={data.annotations ?? []}
                  config={uplotConfig}
                  timeZone={timeZone}
                  newRange={newAnnotationRange}
                  setNewRange={setNewAnnotationRange}
                />
                <OutsideRangePlugin config={uplotConfig} onChangeTimeRange={onChangeTimeRange} />
                {data.annotations && (
                  <ExemplarsPlugin
                    visibleSeries={getVisibleLabels(uplotConfig, sourceFrames)}
                    config={uplotConfig}
                    exemplars={data.annotations}
                    timeZone={timeZone}
                    maxHeight={options.tooltip.maxHeight}
                    maxWidth={options.tooltip.maxWidth}
                  />
                )}
                {((canEditThresholds && onThresholdsChange) || showThresholds) && (
                  <ThresholdControlsPlugin
                    config={uplotConfig}
                    fieldConfig={fieldConfig}
                    onThresholdsChange={canEditThresholds ? onThresholdsChange : undefined}
                  />
                )}
              </>
            )}
          </>
        );
      }}
    </TimeSeries>
  );
};
