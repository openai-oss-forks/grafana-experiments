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

  it.each([
    ['compact-v1', 1],
    [undefined, 0],
  ] as const)('handles a prepared %s request before the first response', (preferredQueryResultFormat, runCount) => {
    const queryRunner = new DashboardSceneQueryRunner({ queries: [{ refId: 'A' }] });
    jest.spyOn(queryRunner, 'getLastPreparedRequest').mockReturnValue({
      requestId: 'prepared-request',
      preferredQueryResultFormat,
    });
    const runQueries = jest.spyOn(queryRunner, 'runQueries').mockImplementation(() => {});

    ensureInspectorQueryFormat(queryRunner);

    expect(runQueries).toHaveBeenCalledTimes(runCount);
  });

  it.each([
    ['active', true, 0],
    ['inactive', false, 1],
  ] as const)('handles an %s unprepared dashboard request', (_name, active, runCount) => {
    const queryRunner = new DashboardSceneQueryRunner({ queries: [{ refId: 'A' }] });
    const runQueries = jest.spyOn(queryRunner, 'runQueries').mockImplementation(() => {});
    const deactivate = active ? queryRunner.activate() : undefined;
    runQueries.mockClear();

    ensureInspectorQueryFormat(queryRunner);

    expect(runQueries).toHaveBeenCalledTimes(runCount);
    deactivate?.();
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
