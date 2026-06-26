import { Component, createRef } from 'react';
import uPlot, { AlignedData, Options } from 'uplot';

import { getCompactRenderController, isCompactRenderSource } from './compactRenderer';
import { isCompactPlotSource, PlotProps } from './types';
import { pluginLog } from './utils';

import 'uplot/dist/uPlot.min.css';

function sameDims(prevProps: PlotProps, nextProps: PlotProps) {
  return (
    Math.floor(nextProps.width) === Math.floor(prevProps.width) &&
    Math.floor(nextProps.height) === Math.floor(prevProps.height)
  );
}

function sameData(prevProps: PlotProps, nextProps: PlotProps) {
  return nextProps.data === prevProps.data;
}

function sameConfig(prevProps: PlotProps, nextProps: PlotProps) {
  return nextProps.config === prevProps.config;
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

interface CompactCanvasSnapshot {
  canvas: HTMLCanvasElement;
}

/**
 * @internal
 * uPlot abstraction responsible for plot initialisation, setup and refresh
 * Receives a data frame that is x-axis aligned, as of https://github.com/leeoniya/uPlot/tree/master/docs#data-format
 * Exposes context for uPlot instance access
 */
export class UPlotChart extends Component<PlotProps, UPlotChartState, CompactCanvasSnapshot | null> {
  chartRoot = createRef<HTMLDivElement>();
  plotContainer = createRef<HTMLDivElement>();
  plotCanvasBBox = createRef<DOMRect>();
  plotInstance: uPlot | null = null;
  snapshotCanvas: HTMLCanvasElement | null = null;

  constructor(props: PlotProps) {
    super(props);
  }

  destroyPlot() {
    if (!this.plotInstance) {
      return;
    }

    this.plotInstance.destroy();
    this.plotInstance = null;
  }

  reinitPlot() {
    const { plotRef, width, height } = this.props;
    const compactData = isCompactPlotSource(this.props.data);

    this.destroyPlot();

    if (compactData ? !hasRenderableDimensions(this.props) : width === 0 && height === 0) {
      return;
    }

    if (!compactData) {
      this.props.config.addHook('setSize', (plot) => {
        const canvas = plot.over;
        if (!canvas) {
          return;
        }
      });
    }

    const baseConfig = this.props.config.getConfig();
    const config: Options = {
      width: Math.floor(this.props.width),
      height: Math.floor(this.props.height),
      ...baseConfig,
      hooks: compactData
        ? {
            ...baseConfig.hooks,
            draw: [...(baseConfig.hooks?.draw ?? []), this.onCompactDraw],
          }
        : baseConfig.hooks,
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
    }

    this.plotInstance = plot;
  }

  componentDidMount() {
    this.reinitPlot();
  }

  componentWillUnmount() {
    this.clearCompactSnapshot();
    this.destroyPlot();
  }

  getSnapshotBeforeUpdate(prevProps: PlotProps): CompactCanvasSnapshot | null {
    if (
      this.snapshotCanvas ||
      !isCompactPlotSource(this.props.data) ||
      !this.props.holdPreviousCompactFrame ||
      (prevProps.holdPreviousCompactFrame && sameData(prevProps, this.props) && sameConfig(prevProps, this.props))
    ) {
      return null;
    }
    return this.createCompactSnapshot();
  }

  componentDidUpdate(prevProps: PlotProps, _prevState: UPlotChartState, compactSnapshot: CompactCanvasSnapshot | null) {
    if (compactSnapshot) {
      this.mountCompactSnapshot(compactSnapshot);
    }
    const compactData = isCompactPlotSource(this.props.data);
    const previousCompactData = isCompactPlotSource(prevProps.data);
    if (compactData || previousCompactData) {
      if (!compactData || !this.props.holdPreviousCompactFrame) {
        this.clearCompactSnapshot();
      }
      if (compactData && !hasRenderableDimensions(this.props)) {
        if (this.plotInstance) {
          this.destroyPlot();
        }
        return;
      }

      if (
        !compactData ||
        !previousCompactData ||
        !this.plotInstance ||
        !hasRenderableDimensions(prevProps) ||
        !sameConfig(prevProps, this.props) ||
        !sameDataKind(prevProps, this.props)
      ) {
        this.reinitPlot();
        return;
      }

      if (!sameDims(prevProps, this.props)) {
        this.plotInstance.setSize({
          width: Math.floor(this.props.width),
          height: Math.floor(this.props.height),
        });
      }
      if (!sameData(prevProps, this.props)) {
        this.plotInstance.setCompactData!(this.props.data);
      }
      return;
    }

    if (!sameDims(prevProps, this.props)) {
      this.plotInstance?.setSize({
        width: Math.floor(this.props.width),
        height: Math.floor(this.props.height),
      });
    } else if (!sameConfig(prevProps, this.props)) {
      this.reinitPlot();
    } else if (!sameData(prevProps, this.props)) {
      this.plotInstance?.setData(this.props.data as AlignedData);
    }
  }

  render() {
    return (
      <div ref={this.chartRoot} style={{ position: 'relative' }}>
        <div ref={this.plotContainer} data-testid="uplot-main-div" />
        {this.props.children}
      </div>
    );
  }

  private onCompactDraw = (drawnPlot: uPlot) => {
    const source = this.props.data;
    if (!isCompactPlotSource(source) || drawnPlot.compactSource !== source) {
      return;
    }
    const config = this.props.config;
    const width = drawnPlot.width;
    const height = drawnPlot.height;
    queueMicrotask(() => {
      if (
        this.plotInstance === drawnPlot &&
        drawnPlot.compactSource === source &&
        this.props.data === source &&
        this.props.config === config &&
        Math.floor(this.props.width) === width &&
        Math.floor(this.props.height) === height &&
        this.plotInstance
      ) {
        this.props.onCompactFrameReady?.(source, config, width, height);
      }
    });
  };

  private createCompactSnapshot(): CompactCanvasSnapshot | null {
    const chartRoot = this.chartRoot.current;
    const plotContainer = this.plotContainer.current;
    const source = plotContainer?.querySelector('canvas');
    if (!chartRoot || !plotContainer || !source) {
      return null;
    }
    const snapshot = document.createElement('canvas');
    const context = snapshot.getContext('2d');
    if (!context) {
      return null;
    }
    const sourceRect = source.getBoundingClientRect();
    const rootRect = chartRoot.getBoundingClientRect();
    snapshot.width = source.width;
    snapshot.height = source.height;
    snapshot.style.position = 'absolute';
    snapshot.dataset.compactFrameSnapshot = 'true';
    snapshot.style.pointerEvents = 'none';
    snapshot.style.zIndex = '1';
    snapshot.style.left = `${sourceRect.left - rootRect.left}px`;
    snapshot.style.top = `${sourceRect.top - rootRect.top}px`;
    snapshot.style.width = `${sourceRect.width}px`;
    snapshot.style.height = `${sourceRect.height}px`;
    context.drawImage(source, 0, 0);
    return { canvas: snapshot };
  }

  private mountCompactSnapshot({ canvas }: CompactCanvasSnapshot) {
    const target = this.chartRoot.current;
    const plotContainer = this.plotContainer.current;
    if (!target || !plotContainer) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    target.appendChild(canvas);
    plotContainer.style.visibility = 'hidden';
    this.snapshotCanvas = canvas;
  }

  private clearCompactSnapshot() {
    if (this.snapshotCanvas) {
      this.snapshotCanvas.width = 0;
      this.snapshotCanvas.height = 0;
      this.snapshotCanvas.remove();
      this.snapshotCanvas = null;
    }
    if (this.plotContainer.current) {
      this.plotContainer.current.style.visibility = 'visible';
    }
  }
}
