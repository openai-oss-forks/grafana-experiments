import { Component, createRef } from 'react';
import uPlot, { AlignedData, Options } from 'uplot';

import { getCompactRenderController, isCompactRenderSource } from './compactRenderer';
import { isCompactPlotSource, PlotProps } from './types';
import { pluginLog } from './utils';

import 'uplot/dist/uPlot.min.css';

function sameDims(prevProps: PlotProps, nextProps: PlotProps) {
  return nextProps.width === prevProps.width && nextProps.height === prevProps.height;
}

function sameData(prevProps: PlotProps, nextProps: PlotProps) {
  return nextProps.data === prevProps.data;
}

function sameDataKind(prevProps: PlotProps, nextProps: PlotProps) {
  if (isCompactPlotSource(prevProps.data) && isCompactPlotSource(nextProps.data)) {
    return isCompactRenderSource(prevProps.data) === isCompactRenderSource(nextProps.data);
  }
  return isCompactPlotSource(prevProps.data) === isCompactPlotSource(nextProps.data);
}

function hasRenderableDimensions(props: PlotProps) {
  return props.width > 0 && props.height > 0;
}

type UPlotChartState = {
  plot: uPlot | null;
};

/**
 * @internal
 * uPlot abstraction responsible for plot initialisation, setup and refresh
 * Receives a data frame that is x-axis aligned, as of https://github.com/leeoniya/uPlot/tree/master/docs#data-format
 * Exposes context for uPlot instance access
 */
export class UPlotChart extends Component<PlotProps, UPlotChartState> {
  plotContainer = createRef<HTMLDivElement>();
  plotCanvasBBox = createRef<DOMRect>();
  plotInstance: uPlot | null = null;
  plotRef: PlotProps['plotRef'];

  constructor(props: PlotProps) {
    super(props);
  }

  destroyPlot() {
    if (!this.plotInstance) {
      return;
    }

    this.plotInstance.destroy();
    this.plotInstance = null;
    this.plotRef?.(null);
    this.plotRef = undefined;
  }

  reinitPlot() {
    const { plotRef } = this.props;

    this.destroyPlot();

    if (!hasRenderableDimensions(this.props)) {
      return;
    }

    const config: Options = {
      width: Math.floor(this.props.width),
      height: Math.floor(this.props.height),
      ...this.props.config.getConfig(),
    };

    pluginLog('UPlot', false, 'Reinitializing plot', config);
    let plot: uPlot;
    if (isCompactPlotSource(this.props.data)) {
      if (!isCompactRenderSource(this.props.data)) {
        throw new Error('Compact plot data requires typed renderer columns');
      }
      plot = uPlot.compact(
        config,
        this.props.data,
        getCompactRenderController(this.props.data),
        this.plotContainer.current!
      );
    } else {
      plot = new uPlot(config, this.props.data as AlignedData, this.plotContainer.current!);
    }

    if (plotRef) {
      plotRef(plot);
      this.plotRef = plotRef;
    }

    this.plotInstance = plot;
  }

  componentDidMount() {
    this.reinitPlot();
  }

  componentWillUnmount() {
    this.destroyPlot();
  }

  componentDidUpdate(prevProps: PlotProps) {
    if (!hasRenderableDimensions(this.props)) {
      if (hasRenderableDimensions(prevProps)) {
        this.destroyPlot();
      }
      return;
    }

    if (
      !this.plotInstance ||
      !hasRenderableDimensions(prevProps) ||
      prevProps.config !== this.props.config ||
      !sameDataKind(prevProps, this.props)
    ) {
      this.reinitPlot();
      return;
    }

    const dimensionsChanged = !sameDims(prevProps, this.props);
    const dataChanged = !sameData(prevProps, this.props);

    if (dimensionsChanged) {
      this.plotInstance.setSize({
        width: Math.floor(this.props.width),
        height: Math.floor(this.props.height),
      });
    }

    if (dataChanged) {
      if (isCompactPlotSource(this.props.data)) {
        this.plotInstance.setCompactData!(this.props.data);
      } else {
        this.plotInstance.setData(this.props.data as AlignedData);
      }
    }
  }

  render() {
    return (
      <div style={{ position: 'relative' }}>
        <div ref={this.plotContainer} data-testid="uplot-main-div" />
        {this.props.children}
      </div>
    );
  }
}
