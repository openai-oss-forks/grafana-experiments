import { type DataQueryRequest, type DataSourceApi, type TimeRange } from '@grafana/data';
import { SceneQueryRunner, sceneGraph, type QueryRunnerState } from '@grafana/scenes';
import { resolveQueryIntervalWithStepSize } from 'app/features/query/utils/stepSize';

import { runWithSelectedQueryValues } from '../variables/DashboardVariableSet';

export interface DashboardSceneQueryRunnerState extends QueryRunnerState {
  stepSize?: string | null;
}

interface PreparedRequests {
  primary: DataQueryRequest;
  secondaries: DataQueryRequest[];
  processors: Map<string, unknown>;
}

/**
 * Dashboard panels can query from a persisted variable selection while an
 * initial refresh is still hydrating the dropdown candidates.
 */
export class DashboardSceneQueryRunner extends SceneQueryRunner {
  public constructor(initialState: DashboardSceneQueryRunnerState) {
    super(initialState);
    this.wrapPrepareRequests();
  }

  public override runQueries(): void {
    if (this.state._hasFetchedData) {
      super.runQueries();
      return;
    }

    runWithSelectedQueryValues(() => super.runQueries());
  }

  private wrapPrepareRequests() {
    const runner = this as unknown as {
      prepareRequests?: (timeRange: unknown, ds: DataSourceApi) => PreparedRequests;
    };
    const prepareRequests = runner.prepareRequests;

    if (!prepareRequests) {
      return;
    }

    runner.prepareRequests = (timeRange, ds) => {
      const prepared = prepareRequests.call(this, timeRange, ds);
      const resolvedMinInterval = this.getResolvedMinInterval(ds);

      this.applyStepSizeToRequest(prepared.primary, resolvedMinInterval);
      prepared.secondaries = prepared.secondaries.map((request) => {
        this.applyStepSizeToRequest(request, resolvedMinInterval);
        return request;
      });

      return prepared;
    };
  }

  private getResolvedMinInterval(ds: DataSourceApi): string | undefined {
    const state = this.state as DashboardSceneQueryRunnerState;
    return state.minInterval ? sceneGraph.interpolate(this, state.minInterval) : ds.interval;
  }

  private applyStepSizeToRequest(request: DataQueryRequest, minInterval: string | undefined) {
    const state = this.state as DashboardSceneQueryRunnerState;
    const norm = resolveQueryIntervalWithStepSize({
      range: request.range as TimeRange,
      maxDataPoints: request.maxDataPoints ?? 500,
      minInterval,
      stepSize: state.stepSize,
    });

    request.scopedVars = Object.assign({}, request.scopedVars, {
      __interval: { text: norm.interval, value: norm.interval },
      __interval_ms: { text: norm.intervalMs.toString(), value: norm.intervalMs },
    });
    request.interval = norm.interval;
    request.intervalMs = norm.intervalMs;
    request.maxDataPoints = norm.maxDataPoints;
    request.stepSize = state.stepSize;
    request.minInterval = minInterval;
  }
}
