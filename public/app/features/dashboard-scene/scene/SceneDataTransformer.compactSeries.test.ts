import {
  CompactTimeSeriesData,
  COMPACT_TIME_SERIES_FORMAT,
  DataFrame,
  getDefaultTimeRange,
  LoadingState,
  PanelData,
} from '@grafana/data';
import { SceneDataNode, SceneDataTransformer } from '@grafana/scenes';

describe('SceneDataTransformer compact response identity', () => {
  test('propagates successive compact responses through disabled transformations', () => {
    const series: DataFrame[] = [];
    const annotations: DataFrame[] = [];
    const first = compactData();
    const second = compactData();
    const source = new SceneDataNode({ data: panelData(first, series, annotations) });
    const transformer = new SceneDataTransformer({
      $data: source,
      transformations: [{ id: 'reduce', options: {}, disabled: true }],
    });
    const results: PanelData[] = [];
    const subscription = transformer.getResultsStream().subscribe(({ data }) => results.push(data));
    const deactivate = transformer.activate();

    source.setState({ data: panelData(second, series, annotations) });

    expect(results.map((result) => result.compactSeries)).toEqual([first, second]);

    deactivate();
    subscription.unsubscribe();
  });
});

function panelData(compactSeries: CompactTimeSeriesData, series: DataFrame[], annotations: DataFrame[]): PanelData {
  return {
    state: LoadingState.Done,
    series,
    annotations,
    compactSeries,
    timeRange: getDefaultTimeRange(),
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
