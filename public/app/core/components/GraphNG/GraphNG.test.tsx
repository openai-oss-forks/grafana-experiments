import {
  CompactTimeSeriesData,
  COMPACT_TIME_SERIES_FORMAT,
  createTheme,
  dateTime,
  FieldConfigOptionsRegistry,
} from '@grafana/data';
import { GraphDrawStyle } from '@grafana/schema';
import { CompactSeriesFlag, getCompactRenderController, UPlotConfigBuilder } from '@grafana/ui/internal';

import { GraphNGProps, GraphNGRenderer, GraphNGState } from './GraphNG';
import { CompactFieldConfigOptions } from './compactTypes';

const theme = createTheme();
const compactFieldConfig: CompactFieldConfigOptions = {
  fieldConfig: { defaults: {}, overrides: [] },
  fieldConfigRegistry: new FieldConfigOptionsRegistry(),
  replaceVariables: (value) => value,
  theme,
};

describe('GraphNGRenderer compact state ownership', () => {
  test('keeps the initial transparent compact shell non-interactive until its first completed frame', () => {
    const data = compactData();
    const renderer = createRenderer(graphProps(data, 100, 100));

    const initialShell = renderer.render();
    expect(initialShell?.props['aria-hidden']).toBe(true);
    expect(initialShell?.props.style).toMatchObject({ opacity: 0, pointerEvents: 'none' });

    completeCurrentFrame(renderer, 100, 100);

    const completedShell = renderer.render();
    expect(completedShell?.props['aria-hidden']).toBe(false);
    expect(completedShell?.props.style).toMatchObject({ opacity: 1, pointerEvents: undefined });
  });

  test('preserves ownership for a same-source zero-size update', () => {
    const first = compactData();
    const initialProps = graphProps(first, 100, 100);
    const renderer = createRenderer(initialProps);
    const initialPlan = renderer.state.compactPlan;

    updateRenderer(renderer, initialProps, graphProps(first, 0, 100));

    expect(renderer.state.compactPlan).toBe(initialPlan);
  });

  test('releases a replaced source while hidden and rebuilds it on reentry', () => {
    const first = compactData();
    const second = compactData();
    const initialProps = graphProps(first, 100, 100);
    const renderer = createRenderer(initialProps);
    const hiddenProps = graphProps(second, 0, 100);

    updateRenderer(renderer, initialProps, hiddenProps);
    expectGraphStateCleared(renderer.state);
    updateRenderer(renderer, hiddenProps, graphProps(second, 100, 100));

    expect(renderer.state.compactPlan?.data).toBe(second);
    expect(renderer.state.config).toBeDefined();
  });

  test('releases compact state when the input becomes empty', () => {
    const data = compactData();
    const initialProps = graphProps(data, 100, 100);
    const renderer = createRenderer(initialProps);

    updateRenderer(renderer, initialProps, graphProps(undefined, 100, 100));

    expectGraphStateCleared(renderer.state);
  });

  test('publishes refreshed compact plans with the current legend visibility', () => {
    const first = compactData();
    const second = compactData();
    const initialProps = graphProps(first, 100, 100);
    const renderer = createRenderer(initialProps);
    const firstPlan = renderer.state.compactPlan!;
    getCompactRenderController(firstPlan.source).setSeriesVisibility(0, false);

    updateRenderer(renderer, initialProps, graphProps(second, 100, 100));

    expect(renderer.state.compactPlan?.source.columns.visibility[0]).toBe(0);
  });

  test('publishes cumulative compact batches without rebuilding a compatible plot configuration', () => {
    const first = compactData(1);
    const second = compactData(2);
    const prepCompactConfig = jest.fn(() => new UPlotConfigBuilder('utc'));
    const initialProps = { ...graphProps(first, 100, 100), prepCompactConfig };
    const renderer = createRenderer(initialProps);
    const initialConfig = renderer.state.config;

    updateRenderer(renderer, initialProps, { ...graphProps(second, 100, 100), prepCompactConfig });

    expect(renderer.state.compactPlan?.data).toBe(second);
    expect(renderer.state.config).toBe(initialConfig);
  });

  test('retains the completed compact frame until a replacement request finishes drawing', () => {
    const first = compactData();
    const second = compactData();
    const initialProps = { ...graphProps(first, 100, 100), compactRequestKey: 'request-1' };
    const renderer = createRenderer(initialProps);
    const firstPlan = renderer.state.compactPlan!;
    completeCurrentFrame(renderer, 100, 100);

    const nextProps = { ...graphProps(second, 100, 100), compactRequestKey: 'request-2' };
    updateRenderer(renderer, initialProps, nextProps);
    const replacementSource = renderer.state.compactPlan!.source;

    expect(renderer.state.compactPlan?.data).toBe(second);
    expect(renderCompactPlot(renderer, 100, 100).props.data).toBe(firstPlan.source);
    expect(renderer.render()?.props).toMatchObject({ 'aria-busy': true, 'aria-hidden': false });

    expect(renderer['onCompactFrameReady'](replacementSource, renderer.state.config!, 100, 100)).toBe(false);
    expect(renderCompactPlot(renderer, 100, 100).props.data).toBe(firstPlan.source);

    renderer['onStagedCompactLayout'](renderer.state.compactLayoutKey!, 90, 80);
    expect(completeCurrentFrame(renderer, 90, 80)).toBe(true);
    expect(renderCompactPlot(renderer, 90, 80).props.data).toBe(replacementSource);
    expect(renderer.render()?.props['aria-busy']).toBe(false);
  });

  test('reuses capped legend geometry while a changed progressive final source draws', () => {
    const legend = {
      showLegend: true,
      displayMode: 'list',
      placement: 'bottom',
      calcs: [],
    } as GraphNGProps['legend'];
    const first = compactData(1, 1_000_000);
    const second = compactData(2, 1_000_000);
    const streamingProps = {
      ...graphProps(first, 100, 100),
      compactRequestKey: 'request-1',
      compactStreaming: true,
      legend,
    };
    const renderer = createRenderer(streamingProps);
    completeCurrentFrame(renderer, 100, 65);

    const finalProps = { ...streamingProps, compactSeries: second, compactStreaming: false };
    updateRenderer(renderer, streamingProps, finalProps);

    const pendingPlot = renderCompactPlot(renderer, 200, 100);
    expect(pendingPlot.props).toMatchObject({ width: 100, height: 65 });
    expect(pendingPlot.props.data.seriesCount).toBe(2);
    expect(pendingPlot.props.holdPreviousCompactFrame).toBe(true);

    expect(completeCurrentFrame(renderer, 100, 65)).toBe(true);
    expect(renderer.render()?.props['aria-busy']).toBe(false);
  });

  test('ignores completion from a compact plan that never reached the plot', () => {
    const first = compactData();
    const second = compactData();
    const third = compactData();
    const initialProps = { ...graphProps(first, 100, 100), compactRequestKey: 'request-1' };
    const renderer = createRenderer(initialProps);
    completeCurrentFrame(renderer, 100, 100);

    const secondProps = { ...graphProps(second, 100, 100), compactRequestKey: 'request-2' };
    updateRenderer(renderer, initialProps, secondProps);
    const stalePlan = renderer.state.compactPlan!;
    const staleConfig = renderer.state.config!;
    const requestFrame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    updateRenderer(renderer, secondProps, { ...secondProps, compactSeries: third, compactStreaming: true });
    const accepted = renderer['onCompactFrameReady'](stalePlan.source, staleConfig, 90, 80);

    expect(accepted).toBe(false);
    expect(renderer.render()?.props).toMatchObject({ 'aria-busy': true, 'aria-hidden': false });
    renderer.componentWillUnmount();
    requestFrame.mockRestore();
  });

  test('presents each completed active batch while a newer streaming batch is pending', () => {
    const first = compactData(1, 1_000_000);
    const second = compactData(1, 1_000_000);
    const initialProps = {
      ...graphProps(first, 100, 100),
      compactRequestKey: 'request-1',
      compactStreaming: true,
      structureRev: 1,
    };
    const renderer = createRenderer(initialProps);
    const firstPlan = renderer.state.compactPlan!;
    const firstConfig = renderer.state.config!;
    renderCompactPlot(renderer);

    let commitFrame: FrameRequestCallback | undefined;
    const requestFrame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      commitFrame = callback;
      return 1;
    });
    const secondProps = { ...initialProps, compactSeries: second, structureRev: 2 };
    updateRenderer(renderer, initialProps, secondProps);
    commitFrame?.(0);

    expect(renderer.state.compactPlan?.data).toBe(second);
    expect(renderer.render()?.props['aria-hidden']).toBe(true);

    const accepted = renderer['onCompactFrameReady'](firstPlan.source, firstConfig, 100, 80);

    expect(accepted).toBe(true);
    expect(renderer.render()?.props['aria-hidden']).toBe(false);
    expect(renderer.render()?.props['aria-busy']).toBe(true);
    requestFrame.mockRestore();
  });

  test('redraws progressive draw-style changes without invalidating legend geometry', () => {
    const first = compactData(1, 1_000_000);
    const second = compactData(2, 1_000_000);
    const legend = {
      showLegend: true,
      displayMode: 'list',
      placement: 'bottom',
      calcs: ['lastNotNull'],
    } as GraphNGProps['legend'];
    const initialProps = {
      ...graphProps(first, 100, 100),
      compactRequestKey: 'request-1',
      compactStreaming: true,
      legend,
    };
    const renderer = createRenderer(initialProps);
    completeCurrentFrame(renderer);
    const initialLayoutKey = renderer.state.compactLayoutKey;
    const barsFieldConfig: CompactFieldConfigOptions = {
      ...compactFieldConfig,
      capability: 'timeseries-bars',
      fieldConfigRegistry: new FieldConfigOptionsRegistry(() => [
        {
          id: 'custom.drawStyle',
          path: 'drawStyle',
          name: 'Draw style',
          isCustom: true,
          editor: () => null,
          override: () => null,
          process: (value) => value,
          shouldApply: () => true,
        },
      ]),
      fieldConfig: { defaults: { custom: { drawStyle: GraphDrawStyle.Bars } }, overrides: [] },
    };

    const barsProps = { ...initialProps, compactSeries: second, compactFieldConfig: barsFieldConfig };
    updateRenderer(renderer, initialProps, barsProps);

    expect(renderer.state.compactLayoutKey).toBe(initialLayoutKey);
    const barsPlot = renderCompactPlot(renderer);
    expect(barsPlot.props.data.columns.flags[0] & CompactSeriesFlag.Bars).not.toBe(0);
    expect(barsPlot.props.holdPreviousCompactFrame).toBe(true);
    expect(renderer.render()?.props['aria-busy']).toBe(true);

    completeCurrentFrame(renderer);
    expect(renderer.render()?.props['aria-busy']).toBe(false);

    updateRenderer(renderer, barsProps, initialProps);

    expect(renderer.state.compactLayoutKey).toBe(initialLayoutKey);
    const linesPlot = renderCompactPlot(renderer);
    expect(linesPlot.props.data.columns.flags[0] & CompactSeriesFlag.Bars).toBe(0);
    expect(linesPlot.props.data.columns.flags[0] & CompactSeriesFlag.DrawLine).not.toBe(0);
    expect(linesPlot.props.holdPreviousCompactFrame).toBe(true);
  });

  test('rejects a completed frame whose plot geometry predates the latest render', () => {
    const data = compactData();
    const initialProps = graphProps(data, 100, 100);
    const renderer = createRenderer(initialProps);
    const source = renderer.state.compactPlan!.source;
    const config = renderer.state.config!;
    renderCompactPlot(renderer, 100, 80);

    const resizedProps = graphProps(data, 200, 100);
    updateRenderer(renderer, initialProps, resizedProps);
    renderCompactPlot(renderer, 200, 80);

    expect(renderer['onCompactFrameReady'](source, config, 100, 80)).toBe(false);
    expect(renderer.render()?.props['aria-hidden']).toBe(true);
    expect(renderer['onCompactFrameReady'](source, config, 200, 80)).toBe(true);
    expect(renderer.render()?.props['aria-hidden']).toBe(false);
  });

  test('normalizes fractional layout geometry before validating a completed frame', () => {
    const data = compactData();
    const renderer = createRenderer(graphProps(data, 200, 100));

    const plot = renderCompactPlot(renderer, 199.75, 79.5);

    expect(plot.props).toMatchObject({ width: 199, height: 79 });
    expect(renderer['onCompactFrameReady'](renderer.state.compactPlan!.source, renderer.state.config!, 199, 79)).toBe(
      true
    );
    expect(renderer.render()?.props['aria-hidden']).toBe(false);
  });

  test('coalesces compatible streaming revisions to the newest source in one display frame', () => {
    const first = compactData(1);
    const second = compactData(1);
    const third = compactData(1);
    const prepCompactConfig = jest.fn(() => new UPlotConfigBuilder('utc'));
    const initialProps = {
      ...graphProps(first, 100, 100),
      compactStreaming: true,
      structureRev: 1,
      prepCompactConfig,
    };
    const renderer = createRenderer(initialProps);
    const initialConfig = renderer.state.config;
    let commitFrame: FrameRequestCallback | undefined;
    const requestFrame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      commitFrame = callback;
      return 1;
    });

    const secondProps = {
      ...graphProps(second, 100, 100),
      compactStreaming: true,
      structureRev: 2,
      prepCompactConfig,
    };
    const thirdProps = {
      ...graphProps(third, 100, 100),
      compactStreaming: true,
      structureRev: 3,
      prepCompactConfig,
    };
    updateRenderer(renderer, initialProps, secondProps);
    updateRenderer(renderer, secondProps, thirdProps);

    expect(renderer.state.compactPlan?.data).toBe(first);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    commitFrame?.(0);
    expect(renderer.state.compactPlan?.data).toBe(third);
    expect(renderer.state.config).toBe(initialConfig);
    expect(prepCompactConfig).toHaveBeenCalledTimes(1);
    requestFrame.mockRestore();
  });
});

function graphProps(compactSeries: CompactTimeSeriesData | undefined, width: number, height: number): GraphNGProps {
  return {
    frames: [],
    compactSeries,
    compactFieldConfig: compactSeries ? compactFieldConfig : undefined,
    width,
    height,
    timeRange: {
      from: dateTime(0),
      to: dateTime(1),
      raw: { from: dateTime(0), to: dateTime(1) },
    },
    timeZone: 'utc',
    legend: {} as GraphNGProps['legend'],
    theme,
    prepConfig: () => new UPlotConfigBuilder('utc'),
    prepCompactConfig: () => new UPlotConfigBuilder('utc'),
    renderLegend: () => null,
    replaceVariables: (value) => value,
  };
}

function compactData(seriesCount = 1, pointCount = 2): CompactTimeSeriesData {
  const buffer = new ArrayBuffer(Float64Array.BYTES_PER_ELEMENT * pointCount);
  new Float64Array(buffer).set([1, 2]);
  return {
    kind: 'compact-response-view',
    format: COMPACT_TIME_SERIES_FORMAT,
    buffer,
    axes: [{ start: 0, step: 1, count: pointCount }],
    series: Array.from({ length: seriesCount }, (_, index) => ({
      refId: 'A',
      valueName: `Value ${index}`,
      axisId: 0,
      labelRecordsOffset: 0,
      labelCount: 0,
      presenceByteOffset: 0,
      presenceByteLength: 0,
      presentCount: pointCount,
      valuesByteOffset: 0,
    })),
    metadata: {
      getLabel: () => undefined,
      forEachLabel: () => undefined,
      materializeLabels: () => undefined,
    },
    decodeStats: {
      responseBytes: 0,
      axisCount: 1,
      resultCount: seriesCount,
      stringCount: 0,
      stringBytes: 0,
      seriesCount,
    },
  };
}

function createRenderer(props: GraphNGProps): GraphNGRenderer {
  const renderer = new GraphNGRenderer(props);
  installSynchronousSetState(renderer);
  return renderer;
}

function installSynchronousSetState(renderer: GraphNGRenderer): void {
  renderer.setState = ((next: GraphNGState, callback?: () => void) => {
    renderer.state = { ...renderer.state, ...next };
    callback?.call(renderer);
  }) as GraphNGRenderer['setState'];
}

function updateRenderer(renderer: GraphNGRenderer, previous: GraphNGProps, next: GraphNGProps): void {
  Object.defineProperty(renderer, 'props', { configurable: true, value: next });
  renderer.componentDidUpdate(previous);
}

function renderCompactPlot(renderer: GraphNGRenderer, width = 100, height = 80) {
  const shell = renderer.render();
  return shell?.props.children[0].props.children(width, height);
}

function completeCurrentFrame(renderer: GraphNGRenderer, width = 100, height = 80): boolean {
  renderCompactPlot(renderer, width, height);
  return renderer['onCompactFrameReady'](renderer.state.compactPlan!.source, renderer.state.config!, width, height);
}

function expectGraphStateCleared(state: GraphNGState): void {
  expect(state.config).toBeUndefined();
  expect(state.compactPlan).toBeUndefined();
  expect(state.compactFieldConfig).toBeUndefined();
  expect(state.sourceFrames).toBeUndefined();
  expect(state.alignedFrame).toBeUndefined();
  expect(state.alignedData).toBeUndefined();
}
