import {
  CompactTimeSeriesData,
  COMPACT_TIME_SERIES_FORMAT,
  createTheme,
  dateTime,
  FieldConfigOptionsRegistry,
} from '@grafana/data';
import { getCompactRenderController, UPlotConfigBuilder } from '@grafana/ui/internal';

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
    const renderer = new GraphNGRenderer(graphProps(data, 100, 100));
    installSynchronousSetState(renderer);

    const initialShell = renderer.render();
    expect(initialShell?.props['aria-hidden']).toBe(true);
    expect(initialShell?.props.style).toMatchObject({ opacity: 0, pointerEvents: 'none' });

    renderer['onCompactFrameReady'](renderer.state.compactPlan!.source, renderer.state.config!, 100, 100);

    const completedShell = renderer.render();
    expect(completedShell?.props['aria-hidden']).toBe(false);
    expect(completedShell?.props.style).toMatchObject({ opacity: 1, pointerEvents: undefined });
  });

  test('clears a replaced compact source while non-renderable and rebuilds the latest source on reentry', () => {
    const first = compactData();
    const second = compactData();
    const initialProps = graphProps(first, 100, 100);
    const renderer = new GraphNGRenderer(initialProps);
    installSynchronousSetState(renderer);

    expect(renderer.state.compactPlan?.data).toBe(first);

    const hiddenProps = graphProps(second, 0, 100);
    updateRenderer(renderer, initialProps, hiddenProps);
    expectGraphStateCleared(renderer.state);

    const visibleProps = graphProps(second, 100, 100);
    updateRenderer(renderer, hiddenProps, visibleProps);
    expect(renderer.state.compactPlan?.data).toBe(second);
    expect(renderer.state.config).toBeDefined();
  });

  test('preserves the current compact plan across a temporary same-source zero-size update', () => {
    const data = compactData();
    const initialProps = graphProps(data, 100, 100);
    const renderer = new GraphNGRenderer(initialProps);
    installSynchronousSetState(renderer);
    const plan = renderer.state.compactPlan;

    updateRenderer(renderer, initialProps, graphProps(data, 0, 100));

    expect(renderer.state.compactPlan).toBe(plan);
  });

  test('clears compact state when the input becomes empty', () => {
    const data = compactData();
    const initialProps = graphProps(data, 100, 100);
    const renderer = new GraphNGRenderer(initialProps);
    installSynchronousSetState(renderer);

    updateRenderer(renderer, initialProps, graphProps(undefined, 100, 100));

    expectGraphStateCleared(renderer.state);
  });

  test('publishes refreshed compact plans with the current legend visibility', () => {
    const first = compactData();
    const second = compactData();
    const initialProps = graphProps(first, 100, 100);
    const renderer = new GraphNGRenderer(initialProps);
    installSynchronousSetState(renderer);
    const firstPlan = renderer.state.compactPlan!;
    getCompactRenderController(firstPlan.source).setSeriesVisibility(0, false);

    updateRenderer(renderer, initialProps, graphProps(second, 100, 100));

    expect(renderer.state.compactPlan?.source.columns.visibility[0]).toBe(0);
    expect(renderer.state.compactPlan?.source.visibilityState.overrides.size).toBe(1);
  });

  test('publishes cumulative compact batches without rebuilding a compatible plot configuration', () => {
    const first = compactData(1);
    const second = compactData(2);
    const prepCompactConfig = jest.fn(() => new UPlotConfigBuilder('utc'));
    const initialProps = { ...graphProps(first, 100, 100), prepCompactConfig };
    const renderer = new GraphNGRenderer(initialProps);
    installSynchronousSetState(renderer);
    const initialConfig = renderer.state.config;

    updateRenderer(renderer, initialProps, { ...graphProps(second, 100, 100), prepCompactConfig });

    expect(renderer.state.compactPlan?.data).toBe(second);
    expect(renderer.state.config).toBe(initialConfig);
    expect(prepCompactConfig).toHaveBeenCalledTimes(1);
  });

  test('retains the completed compact frame until a replacement request finishes drawing', () => {
    const first = compactData();
    const second = compactData();
    const initialProps = { ...graphProps(first, 100, 100), compactRequestKey: 'request-1' };
    const renderer = new GraphNGRenderer(initialProps);
    installSynchronousSetState(renderer);
    const firstPlan = renderer.state.compactPlan!;
    const firstConfig = renderer.state.config!;
    renderer['onCompactFrameReady'](firstPlan.source, firstConfig, 100, 100);

    const nextProps = { ...graphProps(second, 100, 100), compactRequestKey: 'request-2' };
    updateRenderer(renderer, initialProps, nextProps);

    expect(renderer.state.compactPlan?.data).toBe(second);
    expect(renderer.state.presentedCompactPlan).toBe(firstPlan);
    expect(renderer.state.holdPreviousCompactFrame).toBe(true);

    renderer['onCompactFrameReady'](renderer.state.compactPlan!.source, renderer.state.config!, 100, 100);
    expect(renderer.state.presentedCompactPlan).toBe(firstPlan);

    renderer['onStagedCompactLayout'](renderer.state.compactLayoutKey!, 90, 80);
    renderer['onCompactFrameReady'](renderer.state.compactPlan!.source, renderer.state.config!, 90, 80);
    expect(renderer.state.presentedCompactPlan).toBe(renderer.state.compactPlan);
    expect(renderer.state.presentedCompactSessionKey).toBe('request-2');
    expect(renderer.state.holdPreviousCompactFrame).toBe(false);
  });

  test('does not present a completed draw after a newer streaming revision is ingested', () => {
    const first = compactData();
    const second = compactData();
    const third = compactData();
    const initialProps = { ...graphProps(first, 100, 100), compactRequestKey: 'request-1' };
    const renderer = new GraphNGRenderer(initialProps);
    installSynchronousSetState(renderer);
    renderer['onCompactFrameReady'](renderer.state.compactPlan!.source, renderer.state.config!, 100, 100);
    const firstPlan = renderer.state.presentedCompactPlan;

    const secondProps = { ...graphProps(second, 100, 100), compactRequestKey: 'request-2' };
    updateRenderer(renderer, initialProps, secondProps);
    renderer['onStagedCompactLayout'](renderer.state.compactLayoutKey!, 90, 80);
    const secondPlan = renderer.state.compactPlan!;
    const secondConfig = renderer.state.config!;

    const requestFrame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    const thirdProps = {
      ...graphProps(third, 100, 100),
      compactRequestKey: 'request-2',
      compactStreaming: true,
    };
    updateRenderer(renderer, secondProps, thirdProps);
    renderer['onCompactFrameReady'](secondPlan.source, secondConfig, 90, 80);

    expect(renderer.state.presentedCompactPlan).toBe(firstPlan);
    expect(renderer.state.holdPreviousCompactFrame).toBe(true);
    renderer.componentWillUnmount();
    requestFrame.mockRestore();
  });

  test('does not stage a duplicate legend when streaming completes with stable topology', () => {
    const data = compactData(1, 1_000_000);
    const streamingProps = {
      ...graphProps(data, 100, 100),
      compactRequestKey: 'request-1',
      compactStreaming: true,
    };
    const renderer = new GraphNGRenderer(streamingProps);
    installSynchronousSetState(renderer);
    renderer['onCompactFrameReady'](renderer.state.compactPlan!.source, renderer.state.config!, 90, 80);
    const streamingLayoutKey = renderer.state.compactLayoutKey;

    const finalProps = { ...streamingProps, compactStreaming: false };
    updateRenderer(renderer, streamingProps, finalProps);

    expect(renderer.state.compactLayoutKey).not.toBe(streamingLayoutKey);
    expect(renderer.state.holdPreviousCompactFrame).toBe(false);
    expect(renderer.state.presentedCompactLayoutKey).toBe(renderer.state.compactLayoutKey);
    expect(renderer.state.stagedCompactLayoutKey).toBeUndefined();
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
    const renderer = new GraphNGRenderer(streamingProps);
    installSynchronousSetState(renderer);
    renderer['onCompactFrameReady'](renderer.state.compactPlan!.source, renderer.state.config!, 100, 65);

    const finalProps = { ...streamingProps, compactSeries: second, compactStreaming: false };
    updateRenderer(renderer, streamingProps, finalProps);

    expect(renderer.state.holdPreviousCompactFrame).toBe(true);
    expect(renderer.state.stagedCompactLayoutKey).toBe(renderer.state.compactLayoutKey);
    expect(renderer.state.stagedCompactWidth).toBe(100);
    expect(renderer.state.stagedCompactHeight).toBe(65);
    expect(renderer.render()?.props.children[1]).toBe(false);

    renderer['onCompactFrameReady'](renderer.state.compactPlan!.source, renderer.state.config!, 100, 65);
    expect(renderer.state.holdPreviousCompactFrame).toBe(false);
    expect(renderer.state.presentedCompactPlan?.data).toBe(second);
    expect(renderer.state.presentedCompactPlan?.seriesCount).toBe(2);
  });

  test('remeasures final legend geometry when the panel dimensions change', () => {
    const legend = {
      showLegend: true,
      displayMode: 'list',
      placement: 'bottom',
      calcs: [],
    } as GraphNGProps['legend'];
    const first = compactData(1, 1_000_000);
    const second = compactData(1, 1_000_000);
    const streamingProps = {
      ...graphProps(first, 100, 100),
      compactRequestKey: 'request-1',
      compactStreaming: true,
      legend,
    };
    const renderer = new GraphNGRenderer(streamingProps);
    installSynchronousSetState(renderer);
    renderer['onCompactFrameReady'](renderer.state.compactPlan!.source, renderer.state.config!, 100, 65);

    const finalProps = {
      ...streamingProps,
      ...graphProps(second, 200, 200),
      compactRequestKey: 'request-1',
      compactStreaming: false,
      legend,
    };
    updateRenderer(renderer, streamingProps, finalProps);

    expect(renderer.state.holdPreviousCompactFrame).toBe(true);
    expect(renderer.state.stagedCompactLayoutKey).toBeUndefined();
    expect(renderer.render()?.props.children[1]).toBeTruthy();
  });

  test('keeps pure resize out of the staged layout transaction', () => {
    const data = compactData();
    const initialProps = { ...graphProps(data, 100, 100), compactRequestKey: 'request-1' };
    const renderer = new GraphNGRenderer(initialProps);
    installSynchronousSetState(renderer);
    renderer['onCompactFrameReady'](renderer.state.compactPlan!.source, renderer.state.config!, 100, 80);
    const initialLayoutKey = renderer.state.compactLayoutKey;

    const resizedProps = { ...initialProps, width: 200, height: 200 };
    updateRenderer(renderer, initialProps, resizedProps);

    expect(renderer.state.compactLayoutKey).toBe(initialLayoutKey);
    expect(renderer.state.holdPreviousCompactFrame).toBe(false);
    renderer['onCompactFrameReady'](renderer.state.compactPlan!.source, renderer.state.config!, 200, 160);
    expect(renderer.state.presentedCompactWidth).toBe(200);
    expect(renderer.state.presentedCompactHeight).toBe(160);
    expect(renderer.state.presentedCompactContainerWidth).toBe(200);
    expect(renderer.state.presentedCompactContainerHeight).toBe(200);
    expect(renderer.state.holdPreviousCompactFrame).toBe(false);
  });

  test('remeasures legend geometry when compact field overrides change its shape', () => {
    const data = compactData();
    const initialProps = { ...graphProps(data, 100, 100), compactRequestKey: 'request-1' };
    const renderer = new GraphNGRenderer(initialProps);
    installSynchronousSetState(renderer);
    renderer['onCompactFrameReady'](renderer.state.compactPlan!.source, renderer.state.config!, 100, 80);
    const initialLayoutKey = renderer.state.compactLayoutKey;
    const changedFieldConfig: CompactFieldConfigOptions = {
      ...compactFieldConfig,
      fieldConfig: {
        defaults: { displayName: 'A substantially longer legend label' },
        overrides: [],
      },
    };

    const nextProps = { ...initialProps, compactFieldConfig: changedFieldConfig };
    updateRenderer(renderer, initialProps, nextProps);

    expect(renderer.state.compactLayoutKey).not.toBe(initialLayoutKey);
    expect(renderer.state.holdPreviousCompactFrame).toBe(true);
    expect(renderer.state.stagedCompactLayoutKey).toBeUndefined();
    expect(renderer.render()?.props.children[1]).toBeTruthy();
  });

  test('retains presented legend options while replacement options are staged', () => {
    const hiddenLegend = {
      showLegend: false,
      displayMode: 'list',
      placement: 'bottom',
    } as GraphNGProps['legend'];
    const visibleLegend = { ...hiddenLegend, showLegend: true };
    const first = compactData();
    const second = compactData();
    const initialProps = { ...graphProps(first, 100, 100), legend: hiddenLegend };
    const renderer = new GraphNGRenderer(initialProps);
    installSynchronousSetState(renderer);
    renderer['onCompactFrameReady'](renderer.state.compactPlan!.source, renderer.state.config!, 100, 100);

    const nextProps = { ...graphProps(second, 100, 100), legend: visibleLegend };
    updateRenderer(renderer, initialProps, nextProps);

    expect(renderer.state.compactLegend).toBe(visibleLegend);
    expect(renderer.state.presentedCompactLegend).toBe(hiddenLegend);
    expect(renderer.state.holdPreviousCompactFrame).toBe(true);
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
    const renderer = new GraphNGRenderer(initialProps);
    installSynchronousSetState(renderer);
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

function expectGraphStateCleared(state: GraphNGState): void {
  expect(state.config).toBeUndefined();
  expect(state.compactPlan).toBeUndefined();
  expect(state.compactFieldConfig).toBeUndefined();
  expect(state.sourceFrames).toBeUndefined();
  expect(state.alignedFrame).toBeUndefined();
  expect(state.alignedData).toBeUndefined();
}
