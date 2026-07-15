import {
  type DataQueryRequest,
  type DataSourceApi,
  resolveQueryIntervalWithStepSize,
  type TimeRange,
} from '@grafana/data';
import { SceneQueryRunner, sceneGraph, type QueryRunnerState } from '@grafana/scenes';

import { runWithSelectedQueryValues } from '../variables/DashboardVariableSet';

export interface DashboardSceneQueryRunnerState extends QueryRunnerState {
  stepSize?: string | null;
}

interface PreparedRequests {
  primary: DataQueryRequest;
  secondaries: DataQueryRequest[];
  processors: Map<string, unknown>;
}

type PreparedRequestSnapshot = Pick<DataQueryRequest, 'requestId' | 'preferredQueryResultFormat'>;

/**
 * Dashboard panels can query from a persisted variable selection while an
 * initial refresh is still hydrating the dropdown candidates.
 */
export class DashboardSceneQueryRunner extends SceneQueryRunner {
  private lastPreparedRequest?: PreparedRequestSnapshot;
  private runQueriesRevision = 0;

  public constructor(initialState: DashboardSceneQueryRunnerState) {
    super(initialState);
    this.wrapPrepareRequests();
    this.addActivationHandler(() => () => {
      this.lastPreparedRequest = undefined;
    });
  }

  public override runQueries(): void {
    this.runQueriesRevision++;
    if (this.state._hasFetchedData) {
      super.runQueries();
      return;
    }

    runWithSelectedQueryValues(() => super.runQueries());
  }

  public getLastPreparedRequest(): Readonly<PreparedRequestSnapshot> | undefined {
    return this.lastPreparedRequest;
  }

  public getRunQueriesRevision(): number {
    return this.runQueriesRevision;
  }

  public override cancelQuery(): void {
    this.lastPreparedRequest = undefined;
    super.cancelQuery();
  }

  private wrapPrepareRequests() {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- SceneQueryRunner keeps request preparation private.
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

      if (ds.meta?.mixed) {
        prepared.primary.preferredQueryResultFormat = undefined;
        for (const request of prepared.secondaries) {
          request.preferredQueryResultFormat = undefined;
        }
      }

      this.applyStepSizeToRequest(prepared.primary, resolvedMinInterval);
      prepared.secondaries = prepared.secondaries.map((request) => {
        this.applyStepSizeToRequest(request, resolvedMinInterval);
        return request;
      });
      this.lastPreparedRequest = {
        requestId: prepared.primary.requestId,
        preferredQueryResultFormat: prepared.primary.preferredQueryResultFormat,
      };

      return prepared;
    };
  }

  private getResolvedMinInterval(ds: DataSourceApi): string | undefined {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- The base runner state omits subclass state fields.
    const state = this.state as DashboardSceneQueryRunnerState;
    return state.minInterval ? sceneGraph.interpolate(this, state.minInterval) : ds.interval;
  }

  private applyStepSizeToRequest(request: DataQueryRequest, minInterval: string | undefined) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- The base runner state omits subclass state fields.
    const state = this.state as DashboardSceneQueryRunnerState;
    const norm = resolveQueryIntervalWithStepSize({
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Prepared dashboard requests always have an evaluated range.
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
