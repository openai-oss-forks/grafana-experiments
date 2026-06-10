import {
  CompactTimeSeriesData,
  COMPACT_TIME_SERIES_FORMAT,
  createTheme,
  dateTime,
  FieldConfigOptionsRegistry,
} from '@grafana/data';
import { UPlotConfigBuilder } from '@grafana/ui/internal';

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

function compactData(): CompactTimeSeriesData {
  return {
    kind: 'compact-response-view',
    format: COMPACT_TIME_SERIES_FORMAT,
    buffer: new ArrayBuffer(0),
    axes: [],
    series: [],
    metadata: {
      getLabel: () => undefined,
      forEachLabel: () => undefined,
      materializeLabels: () => undefined,
    },
    decodeStats: {
      responseBytes: 0,
      axisCount: 0,
      resultCount: 0,
      stringCount: 0,
      stringBytes: 0,
      seriesCount: 0,
    },
  };
}

function installSynchronousSetState(renderer: GraphNGRenderer): void {
  renderer.setState = ((next: GraphNGState) => {
    renderer.state = { ...renderer.state, ...next };
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
