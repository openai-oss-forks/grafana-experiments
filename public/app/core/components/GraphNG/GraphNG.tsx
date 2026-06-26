import * as React from 'react';
import { Component } from 'react';
import uPlot, { AlignedData } from 'uplot';

import {
  DataFrame,
  DataLinkPostProcessor,
  CompactTimeSeriesData,
  Field,
  FieldMatcherID,
  fieldMatchers,
  FieldType,
  getLinksSupplier,
  InterpolateFunction,
  TimeRange,
  TimeZone,
} from '@grafana/data';
import { DashboardCursorSync, LegendPlacement, VizLegendOptions } from '@grafana/schema';
import { Themeable2, VizLayout, VizLayoutLegendProps } from '@grafana/ui';
import {
  AxisProps,
  mayDrawCompactSourceProgressively,
  pluginLog,
  Renderers,
  ScaleProps,
  transferCompactVisibilityState,
  UPlotChart,
  UPlotConfigBuilder,
} from '@grafana/ui/internal';

import { GraphNGRendererGate } from './GraphNGRenderVisibility';
import {
  CompactNativeRenderPlan,
  createCompactNativeRenderPlan,
  hasCompatibleCompactNativeConfig,
} from './compactNativePlan';
import { CompactFieldConfigOptions } from './compactTypes';
import { GraphNGLegendEvent, XYFieldMatchers } from './types';
import { preparePlotFrame as defaultPreparePlotFrame } from './utils';

/**
 * @internal -- not a public API
 */
export type PropDiffFn<T extends Record<string, unknown> = {}> = (prev: T, next: T) => boolean;

export interface GraphNGProps extends Themeable2 {
  frames: DataFrame[];
  compactSeries?: CompactTimeSeriesData;
  compactFieldConfig?: CompactFieldConfigOptions;
  compactStreaming?: boolean;
  compactRequestKey?: string;
  structureRev?: number; // a number that will change when the frames[] structure changes
  width: number;
  height: number;
  timeRange: TimeRange;
  timeZone: TimeZone[] | TimeZone;
  legend: VizLegendOptions;
  fields?: XYFieldMatchers; // default will assume timeseries data
  renderers?: Renderers;
  tweakScale?: (opts: ScaleProps, forField: Field) => ScaleProps;
  tweakAxis?: (opts: AxisProps, forField: Field) => AxisProps;
  onLegendClick?: (event: GraphNGLegendEvent) => void;
  children?: (builder: UPlotConfigBuilder, alignedFrame: DataFrame, sourceFrames: DataFrame[]) => React.ReactNode;
  compactChildren?: (builder: UPlotConfigBuilder, plan: CompactNativeRenderPlan) => React.ReactNode;
  prepConfig: (
    alignedFrame: DataFrame,
    allFrames: DataFrame[],
    getTimeRange: () => TimeRange,
    annotationLanes?: number
  ) => UPlotConfigBuilder;
  prepCompactConfig?: (
    plan: CompactNativeRenderPlan,
    getTimeRange: () => TimeRange,
    annotationLanes?: number
  ) => UPlotConfigBuilder;
  propsToDiff?: Array<string | PropDiffFn>;
  preparePlotFrame?: (frames: DataFrame[], dimFields: XYFieldMatchers) => DataFrame | null;
  renderLegend: (config: UPlotConfigBuilder, frames: DataFrame[]) => React.ReactElement<VizLayoutLegendProps> | null;
  renderCompactLegend?: (
    config: UPlotConfigBuilder,
    plan: CompactNativeRenderPlan,
    legend: VizLegendOptions
  ) => React.ReactElement<VizLayoutLegendProps> | null;
  replaceVariables: InterpolateFunction;
  dataLinkPostProcessor?: DataLinkPostProcessor;
  cursorSync?: DashboardCursorSync;

  // Remove fields that are hidden from the visualization before rendering
  // The fields will still be available for other things like data links
  // this is a temporary hack that only works when:
  // 1. renderLegend (above) does not render <PlotLegend>
  // 2. does not have legend series toggle
  // 3. passes through all fields required for link/action gen (including those with hideFrom.viz)
  omitHideFromViz?: boolean;

  /**
   * needed for propsToDiff to re-init the plot & config
   * this is a generic approach to plot re-init, without having to specify which panel-level options
   * should cause invalidation. we can drop this in favor of something like panelOptionsRev that gets passed in
   * similar to structureRev. then we can drop propsToDiff entirely.
   */
  options?: Record<string, any>;

  // Annotation lanes count
  annotationLanes?: number;
}

function sameProps<T extends Record<string, unknown>>(
  prevProps: T,
  nextProps: T,
  propsToDiff: Array<string | PropDiffFn> = []
) {
  for (const propName of propsToDiff) {
    if (typeof propName === 'function') {
      if (!propName(prevProps, nextProps)) {
        return false;
      }
    } else if (nextProps[propName] !== prevProps[propName]) {
      return false;
    }
  }

  return true;
}

/**
 * @internal -- not a public API
 */
export interface GraphNGState {
  alignedFrame?: DataFrame;
  sourceFrames?: DataFrame[];
  alignedData?: AlignedData;
  config?: UPlotConfigBuilder;
  compactPlan?: CompactNativeRenderPlan;
  compactFieldConfig?: CompactFieldConfigOptions;
  compactLegend?: VizLegendOptions;
  compactSessionKey?: string;
  compactLayoutKey?: string;
  presentedCompactPlan?: CompactNativeRenderPlan;
  presentedCompactConfig?: UPlotConfigBuilder;
  presentedCompactLegend?: VizLegendOptions;
  presentedCompactSessionKey?: string;
  presentedCompactLayoutKey?: string;
  presentedCompactWidth?: number;
  presentedCompactHeight?: number;
  presentedCompactContainerWidth?: number;
  presentedCompactContainerHeight?: number;
  presentedCompactPlacement?: LegendPlacement;
  stagedCompactLayoutKey?: string;
  stagedCompactWidth?: number;
  stagedCompactHeight?: number;
  holdPreviousCompactFrame: boolean;
}

function emptyGraphState(): GraphNGState {
  return {
    alignedFrame: undefined,
    sourceFrames: undefined,
    alignedData: undefined,
    config: undefined,
    compactPlan: undefined,
    compactFieldConfig: undefined,
    compactLegend: undefined,
    compactSessionKey: undefined,
    compactLayoutKey: undefined,
    presentedCompactPlan: undefined,
    presentedCompactConfig: undefined,
    presentedCompactLegend: undefined,
    presentedCompactSessionKey: undefined,
    presentedCompactLayoutKey: undefined,
    presentedCompactWidth: undefined,
    presentedCompactHeight: undefined,
    presentedCompactContainerWidth: undefined,
    presentedCompactContainerHeight: undefined,
    presentedCompactPlacement: undefined,
    stagedCompactLayoutKey: undefined,
    stagedCompactWidth: undefined,
    stagedCompactHeight: undefined,
    holdPreviousCompactFrame: false,
  };
}

const defaultMatchers = {
  x: fieldMatchers.get(FieldMatcherID.firstTimeField).get({}),
  y: fieldMatchers.get(FieldMatcherID.byTypes).get(new Set([FieldType.number, FieldType.enum])),
};

function CompactLayoutSizeReporter({
  layoutKey,
  width,
  height,
  onSize,
}: {
  layoutKey: string;
  width: number;
  height: number;
  onSize: (layoutKey: string, width: number, height: number) => void;
}) {
  React.useLayoutEffect(() => onSize(layoutKey, width, height), [height, layoutKey, onSize, width]);
  return null;
}

/**
 * "Time as X" core component, expects ascending x
 */
export function GraphNG(props: GraphNGProps) {
  return (
    <GraphNGRendererGate suspendWhenInactive={props.compactSeries != null}>
      <GraphNGRenderer {...props} />
    </GraphNGRendererGate>
  );
}

export class GraphNGRenderer extends Component<GraphNGProps, GraphNGState> {
  private compactRevisionFrame?: number;
  private stagedLayoutReleaseFrame?: number;

  constructor(props: GraphNGProps) {
    super(props);
    const state = this.prepState(props);
    if (state.config && !state.alignedData && state.alignedFrame) {
      state.alignedData = this.prepareData(state.config, state.alignedFrame);
    }
    this.state = state;
  }

  getTimeRange = () => this.props.timeRange;

  prepState(props: GraphNGProps, withConfig = true): GraphNGState {
    const {
      frames,
      compactSeries,
      compactFieldConfig,
      fields = defaultMatchers,
      preparePlotFrame,
      replaceVariables,
      dataLinkPostProcessor,
    } = props;

    if (compactSeries) {
      if (props.width <= 0 || props.height <= 0) {
        return emptyGraphState();
      }
      if (!compactFieldConfig) {
        throw new Error('Compact GraphNG rendering requires field configuration');
      }
      if (!props.prepCompactConfig) {
        throw new Error('Compact GraphNG rendering requires descriptor-native plot configuration');
      }

      const canReusePlan =
        this.state?.compactPlan?.data === compactSeries && this.state.compactFieldConfig === compactFieldConfig;
      const plan = canReusePlan
        ? this.state.compactPlan!
        : createCompactNativeRenderPlan(compactSeries, compactFieldConfig);
      if (!canReusePlan && hasCompatibleCompactNativeConfig(plan, this.state?.compactPlan)) {
        transferCompactVisibilityState(this.state.compactPlan!.source, plan.source);
      }
      const config = withConfig
        ? props.prepCompactConfig(plan, this.getTimeRange, props.annotationLanes)
        : this.state?.config;

      return {
        alignedFrame: undefined,
        sourceFrames: undefined,
        alignedData: undefined,
        config,
        compactPlan: plan,
        compactFieldConfig,
        compactLegend: props.legend,
        compactSessionKey: this.getCompactSessionKey(props),
        compactLayoutKey: this.getCompactLayoutKey(props),
        presentedCompactPlan: this.state?.presentedCompactPlan,
        presentedCompactConfig: this.state?.presentedCompactConfig,
        presentedCompactLegend: this.state?.presentedCompactLegend,
        presentedCompactSessionKey: this.state?.presentedCompactSessionKey,
        presentedCompactLayoutKey: this.state?.presentedCompactLayoutKey,
        presentedCompactWidth: this.state?.presentedCompactWidth,
        presentedCompactHeight: this.state?.presentedCompactHeight,
        presentedCompactContainerWidth: this.state?.presentedCompactContainerWidth,
        presentedCompactContainerHeight: this.state?.presentedCompactContainerHeight,
        presentedCompactPlacement: this.state?.presentedCompactPlacement,
        stagedCompactLayoutKey: this.state?.stagedCompactLayoutKey,
        stagedCompactWidth: this.state?.stagedCompactWidth,
        stagedCompactHeight: this.state?.stagedCompactHeight,
        holdPreviousCompactFrame: this.state?.holdPreviousCompactFrame ?? false,
      };
    }

    const preparePlotFrameFn = preparePlotFrame ?? defaultPreparePlotFrame;

    const withLinks = frames.some((frame) => frame.fields.some((field) => (field.config.links?.length ?? 0) > 0));

    const alignedFrame = preparePlotFrameFn(
      frames,
      {
        ...fields,
        // if there are data links, keep all fields during join so they're index-matched
        y: withLinks ? () => true : fields.y,
      },
      props.timeRange
    );

    pluginLog('GraphNG', false, 'data aligned', alignedFrame);

    if (alignedFrame) {
      let alignedFrameFinal = alignedFrame;

      if (withLinks) {
        const timeZone = Array.isArray(this.props.timeZone) ? this.props.timeZone[0] : this.props.timeZone;

        // for links gen we need to use original frames but with the aligned/joined data values
        let linkFrames = frames.map((frame, frameIdx) => ({
          ...frame,
          fields: alignedFrame.fields.filter(
            (field, fieldIdx) => fieldIdx === 0 || field.state?.origin?.frameIndex === frameIdx
          ),
          length: alignedFrame.length,
        }));

        linkFrames.forEach((linkFrame, frameIndex) => {
          linkFrame.fields.forEach((field) => {
            field.getLinks = getLinksSupplier(
              linkFrame,
              field,
              {
                ...field.state?.scopedVars,
                __dataContext: {
                  value: {
                    data: linkFrames,
                    field: field,
                    frame: linkFrame,
                    frameIndex,
                  },
                },
              },
              replaceVariables,
              timeZone,
              dataLinkPostProcessor
            );
          });
        });

        // filter join field and fields.y
        alignedFrameFinal = {
          ...alignedFrame,
          fields: alignedFrame.fields.filter((field, i) => i === 0 || fields.y(field, alignedFrame, [alignedFrame])),
        };
      }

      if (props.omitHideFromViz) {
        const nonHiddenFields = alignedFrameFinal.fields.filter((field) => field.config.custom?.hideFrom?.viz !== true);
        alignedFrameFinal = {
          ...alignedFrameFinal,
          fields: nonHiddenFields,
          length: nonHiddenFields.length,
        };
      }

      let config = this.state?.config;

      if (withConfig) {
        config = props.prepConfig(alignedFrameFinal, this.props.frames, this.getTimeRange, this.props.annotationLanes);
        pluginLog('GraphNG', false, 'config prepared', config);
      }

      const state: GraphNGState = {
        alignedFrame: alignedFrameFinal,
        sourceFrames: frames,
        config,
        compactPlan: undefined,
        compactFieldConfig: undefined,
        compactLegend: undefined,
        compactSessionKey: undefined,
        compactLayoutKey: undefined,
        presentedCompactPlan: undefined,
        presentedCompactConfig: undefined,
        presentedCompactLegend: undefined,
        presentedCompactSessionKey: undefined,
        presentedCompactLayoutKey: undefined,
        presentedCompactWidth: undefined,
        presentedCompactHeight: undefined,
        presentedCompactContainerWidth: undefined,
        presentedCompactContainerHeight: undefined,
        presentedCompactPlacement: undefined,
        stagedCompactLayoutKey: undefined,
        stagedCompactWidth: undefined,
        stagedCompactHeight: undefined,
        holdPreviousCompactFrame: false,
      };

      pluginLog('GraphNG', false, 'data prepared', state.alignedData);
      return state;
    }

    return emptyGraphState();
  }

  componentDidUpdate(prevProps: GraphNGProps) {
    this.scheduleStagedLayoutRelease();
    const {
      frames,
      compactSeries,
      compactFieldConfig,
      compactRequestKey,
      compactStreaming,
      structureRev,
      timeZone,
      cursorSync,
      propsToDiff,
    } = this.props;

    const propsChanged = !sameProps(prevProps, this.props, propsToDiff);
    const compactInputChanged =
      compactSeries !== prevProps.compactSeries || compactFieldConfig !== prevProps.compactFieldConfig;
    const compactRequestChanged = compactRequestKey !== prevProps.compactRequestKey;
    const compactStreamingChanged = compactStreaming !== prevProps.compactStreaming;
    const legacyFramesChanged = !compactSeries && frames !== prevProps.frames;

    const pureStreamingCompactRevision =
      compactInputChanged &&
      compactSeries != null &&
      this.props.compactStreaming === true &&
      compactFieldConfig === prevProps.compactFieldConfig &&
      !propsChanged &&
      timeZone === prevProps.timeZone &&
      cursorSync === prevProps.cursorSync;

    if (pureStreamingCompactRevision) {
      this.scheduleCompactRevision();
      return;
    }

    this.cancelScheduledCompactRevision();

    if (
      legacyFramesChanged ||
      compactInputChanged ||
      compactRequestChanged ||
      compactStreamingChanged ||
      propsChanged ||
      timeZone !== prevProps.timeZone ||
      cursorSync !== prevProps.cursorSync ||
      (!this.state.config && this.props.width > 0 && this.props.height > 0)
    ) {
      let newState = this.prepState(this.props, false);

      const compactConfigChanged = !hasCompatibleCompactNativeConfig(newState.compactPlan, this.state.compactPlan);
      const shouldReconfig =
        this.state.config === undefined ||
        timeZone !== prevProps.timeZone ||
        cursorSync !== prevProps.cursorSync ||
        (!compactSeries && structureRev !== prevProps.structureRev) ||
        compactConfigChanged ||
        compactFieldConfig !== prevProps.compactFieldConfig ||
        (!compactSeries && !structureRev) ||
        propsChanged;

      if (newState.compactPlan || newState.alignedFrame) {
        if (shouldReconfig) {
          if (compactSeries) {
            if (!this.props.prepCompactConfig || !newState.compactPlan) {
              throw new Error('Compact GraphNG rendering requires descriptor-native plot configuration');
            }
            newState.config = this.props.prepCompactConfig(
              newState.compactPlan,
              this.getTimeRange,
              this.props.annotationLanes
            );
          } else {
            newState.config = this.props.prepConfig(
              newState.alignedFrame!,
              newState.sourceFrames!,
              this.getTimeRange,
              this.props.annotationLanes
            );
          }
          pluginLog('GraphNG', false, 'config recreated', newState.config);
        }

        if (!newState.compactPlan && !newState.alignedData) {
          if (!newState.config) {
            return;
          }
          if (!newState.alignedFrame) {
            return;
          }
          newState.alignedData = this.prepareData(newState.config, newState.alignedFrame);
        }
      }

      if (newState.compactPlan && newState.config) {
        newState = this.prepareCompactPresentation(newState);
      }

      this.setState(newState);
    }
  }

  componentWillUnmount() {
    this.cancelScheduledCompactRevision();
    this.cancelStagedLayoutRelease();
  }

  render() {
    const { width, height, children, compactChildren, renderLegend, renderCompactLegend, legend } = this.props;
    const {
      config,
      alignedData,
      compactPlan,
      compactLegend,
      compactSessionKey,
      compactLayoutKey,
      presentedCompactPlan,
      presentedCompactConfig,
      presentedCompactLegend,
      presentedCompactSessionKey,
      presentedCompactLayoutKey,
      stagedCompactLayoutKey,
      stagedCompactWidth,
      stagedCompactHeight,
      holdPreviousCompactFrame,
    } = this.state;

    if (!config) {
      return null;
    }

    if (compactPlan) {
      const visiblePlan = presentedCompactPlan ?? compactPlan;
      const visibleConfig = presentedCompactConfig ?? config;
      const currentLegendOptions = compactLegend ?? legend;
      const visibleLegendOptions = presentedCompactLegend ?? currentLegendOptions;
      const visibleSessionKey = presentedCompactLayoutKey ?? presentedCompactSessionKey ?? compactSessionKey ?? '';
      const legendSessionKey = `${visibleSessionKey}:${JSON.stringify(visibleLegendOptions)}`;
      const hasCompletedFrame = presentedCompactPlan != null && presentedCompactConfig != null;
      const requiresStagedLayout =
        holdPreviousCompactFrame && compactLayoutKey !== presentedCompactLayoutKey && compactLayoutKey != null;
      const hasStagedLayout =
        !requiresStagedLayout ||
        (stagedCompactLayoutKey === compactLayoutKey && stagedCompactWidth != null && stagedCompactHeight != null);
      const plotPlan = requiresStagedLayout && !hasStagedLayout ? visiblePlan : compactPlan;
      const plotConfig = requiresStagedLayout && !hasStagedLayout ? visibleConfig : config;
      const stagedWidth = stagedCompactLayoutKey === compactLayoutKey ? stagedCompactWidth : undefined;
      const stagedHeight = stagedCompactLayoutKey === compactLayoutKey ? stagedCompactHeight : undefined;
      const currentLegend = renderCompactLegend?.(config, compactPlan, currentLegendOptions) ?? null;
      return (
        <div
          aria-busy={holdPreviousCompactFrame || !hasCompletedFrame}
          aria-hidden={!hasCompletedFrame}
          style={{
            opacity: hasCompletedFrame ? 1 : 0,
            pointerEvents: !hasCompletedFrame || holdPreviousCompactFrame ? 'none' : undefined,
            position: 'relative',
            width,
            height,
          }}
        >
          <VizLayout
            width={width}
            height={height}
            legend={renderCompactLegend?.(visibleConfig, visiblePlan, visibleLegendOptions) ?? null}
            lockLegendSize
            legendSizeKey={legendSessionKey}
            mountBeforeLegendMeasure
            stableLegendSlot
          >
            {(vizWidth: number, vizHeight: number) => (
              <UPlotChart
                config={plotConfig}
                data={plotPlan.source}
                holdPreviousCompactFrame={holdPreviousCompactFrame}
                onCompactFrameReady={this.onCompactFrameReady}
                width={stagedWidth ?? vizWidth}
                height={stagedHeight ?? vizHeight}
              >
                {compactChildren ? compactChildren(plotConfig, plotPlan) : null}
              </UPlotChart>
            )}
          </VizLayout>
          {requiresStagedLayout && !hasStagedLayout && (
            <div
              aria-hidden="true"
              style={{ position: 'absolute', inset: 0, visibility: 'hidden', pointerEvents: 'none' }}
            >
              <VizLayout
                width={width}
                height={height}
                legend={currentLegend}
                lockLegendSize
                legendSizeKey={compactLayoutKey}
                mountBeforeLegendMeasure={compactPlan.source.seriesCount === 0}
                stableLegendSlot
              >
                {(stagedWidth: number, stagedHeight: number) => (
                  <CompactLayoutSizeReporter
                    layoutKey={compactLayoutKey}
                    width={stagedWidth}
                    height={stagedHeight}
                    onSize={this.onStagedCompactLayout}
                  />
                )}
              </VizLayout>
            </div>
          )}
        </div>
      );
    }

    if (!alignedData) {
      return null;
    }

    const alignedFrame = this.state.alignedFrame;
    const sourceFrames = this.state.sourceFrames;
    if (!alignedFrame || !sourceFrames) {
      return null;
    }

    return (
      <VizLayout width={width} height={height} legend={renderLegend(config, sourceFrames)}>
        {(vizWidth: number, vizHeight: number) => (
          <UPlotChart config={config} data={alignedData} width={vizWidth} height={vizHeight}>
            {children ? children(config, alignedFrame, sourceFrames) : null}
          </UPlotChart>
        )}
      </VizLayout>
    );
  }

  private prepareData(config: UPlotConfigBuilder, frame: DataFrame): AlignedData {
    if (!config.prepData) {
      throw new Error('GraphNG configuration is missing a data preparation function');
    }
    const data = config.prepData([frame]);
    if (data[0] === null) {
      throw new Error('GraphNG does not support faceted uPlot data');
    }
    return data;
  }

  private scheduleCompactRevision() {
    if (this.compactRevisionFrame !== undefined) {
      return;
    }
    this.compactRevisionFrame = window.requestAnimationFrame(() => {
      this.compactRevisionFrame = undefined;
      const compactSeries = this.props.compactSeries;
      if (!compactSeries) {
        return;
      }
      const newState = this.prepState(this.props, false);
      if (!newState.compactPlan) {
        return;
      }
      const compactConfigChanged = !hasCompatibleCompactNativeConfig(newState.compactPlan, this.state.compactPlan);
      if (compactConfigChanged || !newState.config) {
        if (!this.props.prepCompactConfig) {
          throw new Error('Compact GraphNG rendering requires descriptor-native plot configuration');
        }
        newState.config = this.props.prepCompactConfig(
          newState.compactPlan,
          this.getTimeRange,
          this.props.annotationLanes
        );
      }
      const presentationState = this.prepareCompactPresentation(newState);
      this.setState(presentationState);
    });
  }

  private cancelScheduledCompactRevision() {
    if (this.compactRevisionFrame !== undefined) {
      window.cancelAnimationFrame(this.compactRevisionFrame);
      this.compactRevisionFrame = undefined;
    }
  }

  private getCompactSessionKey(props: GraphNGProps): string {
    return props.compactRequestKey ?? `${props.timeRange.from.valueOf()}:${props.timeRange.to.valueOf()}`;
  }

  private getCompactGeometryKey(props: GraphNGProps): string {
    const { legend } = props;
    const topologyState = props.compactSeries?.series.length ? 'nonempty' : 'empty';
    const fieldConfig = JSON.stringify(props.compactFieldConfig?.fieldConfig ?? null);
    return `${this.getCompactSessionKey(props)}:${topologyState}:${JSON.stringify(legend)}:${fieldConfig}`;
  }

  private getCompactLayoutKey(props: GraphNGProps): string {
    return `${this.getCompactGeometryKey(props)}:${props.compactStreaming ? 'streaming' : 'final'}`;
  }

  private prepareCompactPresentation(nextState: GraphNGState): GraphNGState {
    const { compactPlan, config, compactSessionKey, compactLayoutKey } = nextState;
    if (!compactPlan || !config) {
      return nextState;
    }

    const previousPlan = this.state.presentedCompactPlan;
    const previousConfig = this.state.presentedCompactConfig;
    if (!previousPlan || !previousConfig) {
      return {
        ...nextState,
        presentedCompactPlan: undefined,
        presentedCompactConfig: undefined,
        presentedCompactLegend: undefined,
        presentedCompactSessionKey: undefined,
        presentedCompactLayoutKey: undefined,
        presentedCompactWidth: undefined,
        presentedCompactHeight: undefined,
        stagedCompactLayoutKey: undefined,
        stagedCompactWidth: undefined,
        stagedCompactHeight: undefined,
        holdPreviousCompactFrame: false,
      };
    }

    const layoutChanged = compactLayoutKey !== this.state.presentedCompactLayoutKey;
    const canReusePresentedGeometry = layoutChanged && this.canReusePresentedCompactGeometry(nextState, previousPlan);
    const sourceChanged = compactPlan.source !== previousPlan.source;
    const requiresCompletedDraw =
      (sourceChanged && mayDrawCompactSourceProgressively(compactPlan.source)) ||
      compactSessionKey !== this.state.compactSessionKey ||
      (layoutChanged && !canReusePresentedGeometry) ||
      config !== this.state.config;

    if (requiresCompletedDraw) {
      const reusePresentedDimensions =
        canReusePresentedGeometry &&
        this.state.presentedCompactWidth != null &&
        this.state.presentedCompactHeight != null;
      return {
        ...nextState,
        presentedCompactPlan: previousPlan,
        presentedCompactConfig: previousConfig,
        presentedCompactLegend: this.state.presentedCompactLegend,
        presentedCompactSessionKey: this.state.presentedCompactSessionKey,
        presentedCompactLayoutKey: this.state.presentedCompactLayoutKey,
        stagedCompactLayoutKey: reusePresentedDimensions
          ? compactLayoutKey
          : layoutChanged && this.state.stagedCompactLayoutKey !== compactLayoutKey
            ? undefined
            : this.state.stagedCompactLayoutKey,
        stagedCompactWidth: reusePresentedDimensions
          ? this.state.presentedCompactWidth
          : layoutChanged && this.state.stagedCompactLayoutKey !== compactLayoutKey
            ? undefined
            : this.state.stagedCompactWidth,
        stagedCompactHeight: reusePresentedDimensions
          ? this.state.presentedCompactHeight
          : layoutChanged && this.state.stagedCompactLayoutKey !== compactLayoutKey
            ? undefined
            : this.state.stagedCompactHeight,
        holdPreviousCompactFrame: true,
      };
    }

    return {
      ...nextState,
      presentedCompactPlan: compactPlan,
      presentedCompactConfig: config,
      presentedCompactLegend: nextState.compactLegend,
      presentedCompactSessionKey: compactSessionKey,
      presentedCompactLayoutKey: compactLayoutKey,
      presentedCompactContainerWidth: this.props.width,
      presentedCompactContainerHeight: this.props.height,
      presentedCompactPlacement: this.getCompactLegendPlacement(this.props),
      stagedCompactLayoutKey: undefined,
      stagedCompactWidth: undefined,
      stagedCompactHeight: undefined,
      holdPreviousCompactFrame: false,
    };
  }

  private canReusePresentedCompactGeometry(nextState: GraphNGState, previousPlan: CompactNativeRenderPlan): boolean {
    if (
      !nextState.compactPlan ||
      !nextState.compactLayoutKey ||
      !this.state.presentedCompactLayoutKey ||
      this.state.presentedCompactWidth == null ||
      this.state.presentedCompactHeight == null
    ) {
      return false;
    }

    const geometryKey = this.getCompactGeometryKey(this.props);
    if (
      this.state.presentedCompactLayoutKey !== `${geometryKey}:streaming` &&
      this.state.presentedCompactLayoutKey !== `${geometryKey}:final`
    ) {
      return false;
    }

    if (
      this.state.presentedCompactContainerWidth !== this.props.width ||
      this.state.presentedCompactContainerHeight !== this.props.height ||
      this.state.presentedCompactPlacement !== this.getCompactLegendPlacement(this.props)
    ) {
      return false;
    }

    if (nextState.compactPlan.source === previousPlan.source) {
      return true;
    }

    const legend = nextState.compactLegend ?? this.props.legend;
    if (!legend.showLegend) {
      return true;
    }

    const placement = this.getCompactLegendPlacement(this.props);
    if (placement === 'right') {
      return legend.width != null;
    }

    const legendHeight = this.props.height - this.state.presentedCompactHeight;
    return legendHeight >= this.props.height * 0.35 - 1;
  }

  private getCompactLegendPlacement(props: GraphNGProps) {
    return document.body.clientWidth < props.theme.breakpoints.values.lg ? 'bottom' : props.legend.placement;
  }

  private onStagedCompactLayout = (layoutKey: string, width: number, height: number) => {
    width = Math.floor(width);
    height = Math.floor(height);
    if (
      layoutKey !== this.state.compactLayoutKey ||
      layoutKey !== this.getCompactLayoutKey(this.props) ||
      (this.state.stagedCompactLayoutKey === layoutKey &&
        this.state.stagedCompactWidth === width &&
        this.state.stagedCompactHeight === height)
    ) {
      return;
    }
    this.setState(
      {
        stagedCompactLayoutKey: layoutKey,
        stagedCompactWidth: width,
        stagedCompactHeight: height,
      },
      () => {
        if (
          this.state.holdPreviousCompactFrame &&
          this.state.compactPlan === this.state.presentedCompactPlan &&
          this.state.config === this.state.presentedCompactConfig &&
          width === this.state.presentedCompactWidth &&
          height === this.state.presentedCompactHeight
        ) {
          this.commitCurrentCompactPresentation(width, height);
        }
      }
    );
  };

  private onCompactFrameReady = (
    source: uPlot.CompactPlotSource,
    readyConfig: UPlotConfigBuilder,
    width: number,
    height: number
  ) => {
    const {
      compactPlan,
      config,
      compactSessionKey,
      compactLayoutKey,
      presentedCompactPlan,
      presentedCompactConfig,
      presentedCompactLayoutKey,
      stagedCompactLayoutKey,
    } = this.state;
    const layoutChangePending = presentedCompactPlan != null && compactLayoutKey !== presentedCompactLayoutKey;
    if (
      !compactPlan ||
      !config ||
      compactPlan.source !== source ||
      compactPlan.data !== this.props.compactSeries ||
      config !== readyConfig ||
      compactSessionKey !== this.getCompactSessionKey(this.props) ||
      compactLayoutKey !== this.getCompactLayoutKey(this.props) ||
      (layoutChangePending && stagedCompactLayoutKey !== compactLayoutKey)
    ) {
      return;
    }
    if (
      presentedCompactPlan === compactPlan &&
      presentedCompactConfig === config &&
      !this.state.holdPreviousCompactFrame
    ) {
      const placement = this.getCompactLegendPlacement(this.props);
      if (
        width !== this.state.presentedCompactWidth ||
        height !== this.state.presentedCompactHeight ||
        this.props.width !== this.state.presentedCompactContainerWidth ||
        this.props.height !== this.state.presentedCompactContainerHeight ||
        placement !== this.state.presentedCompactPlacement
      ) {
        this.setState({
          presentedCompactWidth: width,
          presentedCompactHeight: height,
          presentedCompactContainerWidth: this.props.width,
          presentedCompactContainerHeight: this.props.height,
          presentedCompactPlacement: placement,
        });
      }
      return;
    }
    this.commitCurrentCompactPresentation(width, height);
  };

  private commitCurrentCompactPresentation(width: number, height: number) {
    const { compactPlan, config, compactSessionKey, compactLayoutKey } = this.state;
    if (!compactPlan || !config) {
      return;
    }
    this.setState({
      presentedCompactPlan: compactPlan,
      presentedCompactConfig: config,
      presentedCompactLegend: this.state.compactLegend,
      presentedCompactSessionKey: compactSessionKey,
      presentedCompactLayoutKey: compactLayoutKey,
      presentedCompactWidth: width,
      presentedCompactHeight: height,
      presentedCompactContainerWidth: this.props.width,
      presentedCompactContainerHeight: this.props.height,
      presentedCompactPlacement: this.getCompactLegendPlacement(this.props),
      holdPreviousCompactFrame: false,
    });
  }

  private scheduleStagedLayoutRelease() {
    if (
      this.state.holdPreviousCompactFrame ||
      !this.state.stagedCompactLayoutKey ||
      this.state.stagedCompactLayoutKey !== this.state.presentedCompactLayoutKey ||
      this.stagedLayoutReleaseFrame !== undefined
    ) {
      return;
    }
    this.stagedLayoutReleaseFrame = window.requestAnimationFrame(() => {
      this.stagedLayoutReleaseFrame = undefined;
      if (
        !this.state.holdPreviousCompactFrame &&
        this.state.stagedCompactLayoutKey === this.state.presentedCompactLayoutKey
      ) {
        this.setState({
          stagedCompactLayoutKey: undefined,
          stagedCompactWidth: undefined,
          stagedCompactHeight: undefined,
        });
      }
    });
  }

  private cancelStagedLayoutRelease() {
    if (this.stagedLayoutReleaseFrame !== undefined) {
      window.cancelAnimationFrame(this.stagedLayoutReleaseFrame);
      this.stagedLayoutReleaseFrame = undefined;
    }
  }
}
