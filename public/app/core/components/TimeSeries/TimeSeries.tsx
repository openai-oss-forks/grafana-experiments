import { Component } from 'react';

import { DataFrame, TimeRange } from '@grafana/data';
import { VizLegendOptions } from '@grafana/schema';
import { withTheme2 } from '@grafana/ui';
import { hasVisibleLegendSeries, PlotLegend, UPlotConfigBuilder } from '@grafana/ui/internal';

import { GraphNG, GraphNGProps, PropDiffFn } from '../GraphNG/GraphNG';
import { CompactNativeRenderPlan } from '../GraphNG/compactNativePlan';

import { CompactPlotLegend } from './CompactPlotLegend';
import { getXAxisConfig, prepareCompactPlotConfigBuilder, preparePlotConfigBuilder } from './utils';

const propsToDiff: Array<string | PropDiffFn> = [
  'legend',
  'options',
  'annotationLanes',
  'theme',
  'highlightSeriesOnHover',
];

type TimeSeriesProps = Omit<GraphNGProps, 'prepConfig' | 'propsToDiff' | 'renderLegend'> & {
  highlightSeriesOnHover?: boolean;
};

export class UnthemedTimeSeries extends Component<TimeSeriesProps> {
  prepConfig = (
    alignedFrame: DataFrame,
    allFrames: DataFrame[],
    getTimeRange: () => TimeRange,
    annotationLanes?: number
  ) => {
    const { theme, timeZone, options, renderers, tweakAxis, tweakScale, highlightSeriesOnHover } = this.props;

    const config = preparePlotConfigBuilder({
      frame: alignedFrame,
      theme,
      timeZones: Array.isArray(timeZone) ? timeZone : [timeZone],
      getTimeRange,
      allFrames,
      renderers,
      tweakScale,
      tweakAxis,
      hoverProximity: options?.tooltip?.hoverProximity,
      orientation: options?.orientation,
      xAxisConfig: getXAxisConfig(annotationLanes),
    });
    config.setFocus({ alpha: highlightSeriesOnHover ? 0.3 : 1 });
    return config;
  };

  prepCompactConfig = (plan: CompactNativeRenderPlan, getTimeRange: () => TimeRange, annotationLanes?: number) => {
    const { theme, timeZone, options } = this.props;
    const compactXAxisConfig = options?.compactXAxisConfig;
    const compactValueAxisConfig = options?.compactValueAxisConfig;
    const compactPadding = options?.compactPadding;
    const groupedBarTickSpacing = options?.compactGroupedBarTickSpacing;

    return prepareCompactPlotConfigBuilder({
      plan,
      theme,
      timeZones: Array.isArray(timeZone) ? timeZone : [timeZone],
      getTimeRange,
      hoverProximity: options?.tooltip?.hoverProximity,
      orientation: options?.orientation,
      xAxisConfig: { ...getXAxisConfig(annotationLanes), ...compactXAxisConfig },
      valueAxisConfig: compactValueAxisConfig,
      padding: compactPadding,
      groupedBarTickSpacing,
    });
  };

  renderCompactLegend = (config: UPlotConfigBuilder, plan: CompactNativeRenderPlan, legend: VizLegendOptions) => {
    if (!legend?.showLegend) {
      return null;
    }
    return <CompactPlotLegend config={config} plan={plan} {...legend} />;
  };

  renderLegend = (config: UPlotConfigBuilder, frames: DataFrame[]) => {
    const { legend } = this.props;

    if (!config || (legend && !legend.showLegend) || !hasVisibleLegendSeries(config, frames)) {
      return null;
    }

    return <PlotLegend data={frames} config={config} {...legend} />;
  };

  render() {
    return (
      <GraphNG
        {...this.props}
        prepConfig={this.prepConfig}
        prepCompactConfig={this.prepCompactConfig}
        propsToDiff={propsToDiff}
        renderLegend={this.renderLegend}
        renderCompactLegend={this.renderCompactLegend}
      />
    );
  }
}

export const TimeSeries = withTheme2(UnthemedTimeSeries);
TimeSeries.displayName = 'TimeSeries';
