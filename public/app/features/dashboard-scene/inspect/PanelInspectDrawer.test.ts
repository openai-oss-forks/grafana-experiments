import { CompactTimeSeriesData, DataQueryRequest, getDefaultTimeRange, LoadingState } from '@grafana/data';
import { SceneQueryRunner } from '@grafana/scenes';

import { DashboardSceneQueryRunner } from '../scene/DashboardSceneQueryRunner';

import { ensureInspectorQueryFormat } from './PanelInspectDrawer';

describe('ensureInspectorQueryFormat', () => {
  it('reruns compact data once without emitting a cancellation state', () => {
    const queryRunner = new SceneQueryRunner({ queries: [{ refId: 'A' }] });
    queryRunner.setState({
      data: {
        state: LoadingState.Done,
        series: [],
        timeRange: getDefaultTimeRange(),
        compactSeries: {} as CompactTimeSeriesData,
      },
    });
    const cancelQuery = jest.spyOn(queryRunner, 'cancelQuery').mockImplementation(() => {});
    const runQueries = jest.spyOn(queryRunner, 'runQueries').mockImplementation(() => {});

    ensureInspectorQueryFormat(queryRunner);

    expect(cancelQuery).not.toHaveBeenCalled();
    expect(runQueries).toHaveBeenCalledTimes(1);
  });

  it('reruns when a compact request is prepared before the first response', () => {
    const queryRunner = new DashboardSceneQueryRunner({ queries: [{ refId: 'A' }] });
    jest.spyOn(queryRunner, 'getLastPreparedRequest').mockReturnValue({
      requestId: 'compact-request',
      preferredQueryResultFormat: 'compact-v1',
    });
    const runQueries = jest.spyOn(queryRunner, 'runQueries').mockImplementation(() => {});

    ensureInspectorQueryFormat(queryRunner);

    expect(runQueries).toHaveBeenCalledTimes(1);
  });

  it('does not restart an active full-format request with stale compact data', () => {
    const queryRunner = new SceneQueryRunner({ queries: [{ refId: 'A' }] });
    queryRunner.setState({
      data: {
        state: LoadingState.Loading,
        series: [],
        timeRange: getDefaultTimeRange(),
        compactSeries: {} as CompactTimeSeriesData,
        request: { preferredQueryResultFormat: undefined } as DataQueryRequest,
      },
    });
    const runQueries = jest.spyOn(queryRunner, 'runQueries').mockImplementation(() => {});

    ensureInspectorQueryFormat(queryRunner);

    expect(runQueries).not.toHaveBeenCalled();
  });
});
