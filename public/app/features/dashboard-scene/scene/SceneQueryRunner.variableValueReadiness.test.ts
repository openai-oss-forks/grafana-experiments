import { Subject, of } from 'rxjs';

import { DataQueryRequest, DataSourceApi, LoadingState } from '@grafana/data';
import {
  EmbeddedScene,
  QueryVariable,
  SceneCanvasText,
  SceneTimeRange,
  sceneGraph,
  VariableValueOption,
} from '@grafana/scenes';

import { DashboardQueryVariable } from '../variables/DashboardQueryVariable';
import { DashboardVariableSet } from '../variables/DashboardVariableSet';

import { DashboardSceneQueryRunner } from './DashboardSceneQueryRunner';

const runRequestMock = jest.fn().mockImplementation((ds: DataSourceApi, request: DataQueryRequest) => {
  return of({
    state: LoadingState.Done,
    series: [],
    timeRange: request.range,
  });
});

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getRunRequest: () => runRequestMock,
  getDataSourceSrv: () => ({
    get: jest.fn().mockResolvedValue({
      uid: 'ds-1',
      type: 'test',
      getRef: () => ({ uid: 'ds-1', type: 'test' }),
    }),
  }),
}));

describe('DashboardSceneQueryRunner query-variable value readiness', () => {
  beforeEach(() => {
    runRequestMock.mockClear();
  });

  it('queries immediately when candidate hydration has a persisted selected value', async () => {
    const { deactivate } = activateSceneWithHydratingVariable({ value: 'prod', text: 'prod' });

    await waitForTasks();
    expect(runRequestMock).toHaveBeenCalledTimes(1);

    deactivate();
  });

  it('queries again when candidate hydration replaces the selected value', async () => {
    const { completeHydration, deactivate } = activateSceneWithHydratingVariable({ value: 'missing', text: 'missing' });

    await waitForTasks();
    expect(runRequestMock).toHaveBeenCalledTimes(1);

    completeHydration([{ value: 'prod', label: 'prod' }]);
    await waitForTasks();
    expect(runRequestMock).toHaveBeenCalledTimes(2);

    deactivate();
  });

  it.each([
    { name: 'an empty selection', state: { value: '', text: '' } },
    { name: 'implicit All expansion', state: { value: '$__all', text: 'All', includeAll: true } },
  ])('waits for candidates before querying with $name', async ({ state }) => {
    const { completeHydration, deactivate } = activateSceneWithHydratingVariable(state);

    await waitForTasks();
    expect(runRequestMock).not.toHaveBeenCalled();

    completeHydration([{ value: 'prod', label: 'prod' }]);
    await waitForTasks();
    expect(runRequestMock).toHaveBeenCalledTimes(1);

    deactivate();
  });

  it('can query an All selection with a custom interpolation value before candidates arrive', async () => {
    const { deactivate } = activateSceneWithHydratingVariable({
      value: '$__all',
      text: 'All',
      includeAll: true,
      allValue: '.*',
    });

    await waitForTasks();
    expect(runRequestMock).toHaveBeenCalledTimes(1);

    deactivate();
  });

  it('queries Prometheus panels with implicit All while candidate options are unresolved', async () => {
    const { variable, runner, completeHydration, deactivate } = activateSceneWithHydratingVariable({
      value: '$__all',
      text: 'All',
      includeAll: true,
      datasource: { uid: 'prometheus', type: 'prometheus' },
    });

    await waitForTasks();
    expect(runRequestMock).toHaveBeenCalledTimes(1);
    expect(sceneGraph.interpolate(runner, 'up{cluster=~"$cluster"}')).toBe('up{cluster=~".*"}');
    expect(sceneGraph.interpolate(runner, '$cluster', undefined, 'text')).toBe('All');

    completeHydration([{ value: 'prod', label: 'prod' }]);
    await waitForTasks();
    expect(variable.getValue()).toEqual(['prod']);
    expect(sceneGraph.interpolate(runner, 'up{cluster=~"$cluster"}')).toBe('up{cluster=~"prod"}');

    deactivate();
  });

  it('keeps the initial Prometheus implicit All value after candidate hydration is canceled', async () => {
    const { variable, runner, deactivate } = activateSceneWithHydratingVariable({
      value: '$__all',
      text: 'All',
      includeAll: true,
      datasource: { uid: 'prometheus', type: 'prometheus' },
    });

    await waitForTasks();
    variable.validateAndUpdate().subscribe().unsubscribe();
    expect(sceneGraph.interpolate(runner, 'up{cluster=~"$cluster"}')).toBe('up{cluster=~".*"}');

    deactivate();
  });

  it('returns to empty implicit All expansion after an empty Prometheus hydration result', async () => {
    const { variable, completeHydration, deactivate } = activateSceneWithHydratingVariable({
      value: '$__all',
      text: 'All',
      includeAll: true,
      datasource: { uid: 'prometheus', type: 'prometheus' },
    });

    await waitForTasks();
    completeHydration([]);
    await waitForTasks();
    expect(variable.getValue()).toEqual([]);

    deactivate();
  });

  it('queries before a chain of Prometheus implicit All variables completes hydration', async () => {
    const first = createUnresolvedPrometheusAllVariable('cluster', { refId: 'cluster' });
    const second = createUnresolvedPrometheusAllVariable('pod', 'label_values(up{cluster=~"$cluster"}, pod)');
    stubCandidateHydration(first);
    stubCandidateHydration(second);
    const { runner, deactivate } = activateRunner([first, second], 'up{cluster=~"$cluster",pod=~"$pod"}');

    await waitForTasks();
    expect(first.state.loading).toBe(true);
    expect(second.state.loading).not.toBe(true);
    expect(runRequestMock).toHaveBeenCalledTimes(1);
    expect(sceneGraph.interpolate(runner, 'up{cluster=~"$cluster",pod=~"$pod"}')).toBe('up{cluster=~".*",pod=~".*"}');

    deactivate();
  });

  it('keeps dependent dropdown hydration ordered while querying its selected value', async () => {
    const first = new QueryVariable({
      name: 'cluster',
      value: 'prod',
      text: 'prod',
      query: { refId: 'cluster' },
      datasource: { uid: 'ds-1' },
    });
    const second = new QueryVariable({
      name: 'pod',
      value: 'pod-a',
      text: 'pod-a',
      query: 'pods.$cluster',
      datasource: { uid: 'ds-1' },
    });
    const completeFirst = stubCandidateHydration(first);
    const completeSecond = stubCandidateHydration(second);
    const { deactivate } = activateRunner([first, second], 'up{pod="$pod"}');

    await waitForTasks();
    expect(first.state.loading).toBe(true);
    expect(second.state.loading).not.toBe(true);
    expect(runRequestMock).toHaveBeenCalledTimes(1);

    completeFirst([{ value: 'prod', label: 'prod' }]);
    await waitForTasks();
    expect(second.state.loading).toBe(true);
    expect(runRequestMock).toHaveBeenCalledTimes(1);

    completeSecond([{ value: 'pod-a', label: 'pod-a' }]);
    await waitForTasks();
    expect(runRequestMock).toHaveBeenCalledTimes(2);

    deactivate();
  });

  it('waits for candidate hydration after the panel has fetched data once', async () => {
    const { runner, deactivate } = activateSceneWithHydratingVariable({ value: 'prod', text: 'prod' });

    await waitForTasks();
    runner.runQueries();
    await waitForTasks();

    expect(runRequestMock).toHaveBeenCalledTimes(1);
    expect(runner.state.data?.state).toBe(LoadingState.Loading);
    deactivate();
  });
});

function activateSceneWithHydratingVariable(state: Partial<QueryVariable['state']>) {
  const variable = new DashboardQueryVariable({
    name: 'cluster',
    query: { refId: 'variable' },
    datasource: { uid: 'ds-1' },
    ...state,
  });
  const completeHydration = stubCandidateHydration(variable);
  const { runner, deactivate } = activateRunner([variable], 'up{cluster="$cluster"}');

  return { variable, runner, completeHydration, deactivate };
}

function stubCandidateHydration(variable: QueryVariable | DashboardQueryVariable) {
  const candidateResults = new Subject<VariableValueOption[]>();
  jest.spyOn(variable, 'getValueOptions').mockImplementation(() => {
    variable.setState({ loading: true });
    return candidateResults;
  });

  return (options: VariableValueOption[]) => {
    candidateResults.next(options);
    candidateResults.complete();
  };
}

function activateRunner(variables: Array<QueryVariable | DashboardQueryVariable>, expr: string) {
  const runner = new DashboardSceneQueryRunner({
    datasource: { uid: 'ds-1' },
    queries: [{ refId: 'A', expr }],
  });
  const scene = new EmbeddedScene({
    $data: runner,
    $timeRange: new SceneTimeRange({ from: 'now-1h', to: 'now' }),
    $variables: new DashboardVariableSet({ variables }),
    body: new SceneCanvasText({ text: '' }),
  });
  return { runner, deactivate: scene.activate() };
}

async function waitForTasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createUnresolvedPrometheusAllVariable(name: string, query: QueryVariable['state']['query']) {
  return new DashboardQueryVariable({
    name,
    value: '$__all',
    text: 'All',
    includeAll: true,
    query,
    datasource: { uid: 'prometheus', type: 'prometheus' },
  });
}
