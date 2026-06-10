import * as React from 'react';
import { Component } from 'react';
import { AlignedData } from 'uplot';

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
import { DashboardCursorSync, VizLegendOptions } from '@grafana/schema';
import { Themeable2, VizLayout, VizLayoutLegendProps } from '@grafana/ui';
import { AxisProps, pluginLog, Renderers, ScaleProps, UPlotChart, UPlotConfigBuilder } from '@grafana/ui/internal';

import { GraphNGRendererGate } from './GraphNGRenderVisibility';
import {
  CompactNativeRenderPlan,
  createCompactNativeRenderPlan,
  hasSameCompactNativeTopology,
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
    plan: CompactNativeRenderPlan
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
}

function emptyGraphState(): GraphNGState {
  return {
    alignedFrame: undefined,
    sourceFrames: undefined,
    alignedData: undefined,
    config: undefined,
    compactPlan: undefined,
    compactFieldConfig: undefined,
  };
}

const defaultMatchers = {
  x: fieldMatchers.get(FieldMatcherID.firstTimeField).get({}),
  y: fieldMatchers.get(FieldMatcherID.byTypes).get(new Set([FieldType.number, FieldType.enum])),
};

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
      };

      pluginLog('GraphNG', false, 'data prepared', state.alignedData);
      return state;
    }

    return emptyGraphState();
  }

  componentDidUpdate(prevProps: GraphNGProps) {
    const { frames, compactSeries, compactFieldConfig, structureRev, timeZone, cursorSync, propsToDiff } = this.props;

    const propsChanged = !sameProps(prevProps, this.props, propsToDiff);
    const compactInputChanged =
      compactSeries !== prevProps.compactSeries || compactFieldConfig !== prevProps.compactFieldConfig;
    const legacyFramesChanged = !compactSeries && frames !== prevProps.frames;

    if (
      legacyFramesChanged ||
      compactInputChanged ||
      propsChanged ||
      timeZone !== prevProps.timeZone ||
      cursorSync !== prevProps.cursorSync ||
      (!this.state.config && this.props.width > 0 && this.props.height > 0)
    ) {
      let newState = this.prepState(this.props, false);

      const compactTopologyChanged = !hasSameCompactNativeTopology(newState.compactPlan, this.state.compactPlan);
      const shouldReconfig =
        this.state.config === undefined ||
        timeZone !== prevProps.timeZone ||
        cursorSync !== prevProps.cursorSync ||
        (!compactSeries && structureRev !== prevProps.structureRev) ||
        compactTopologyChanged ||
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

      this.setState(newState);
    }
  }

  render() {
    const { width, height, children, compactChildren, renderLegend, renderCompactLegend } = this.props;
    const { config, alignedData, compactPlan } = this.state;

    if (!config) {
      return null;
    }

    if (compactPlan) {
      return (
        <VizLayout width={width} height={height} legend={renderCompactLegend?.(config, compactPlan) ?? null}>
          {(vizWidth: number, vizHeight: number) => (
            <UPlotChart config={config} data={compactPlan.source} width={vizWidth} height={vizHeight}>
              {compactChildren ? compactChildren(config, compactPlan) : null}
            </UPlotChart>
          )}
        </VizLayout>
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
}
