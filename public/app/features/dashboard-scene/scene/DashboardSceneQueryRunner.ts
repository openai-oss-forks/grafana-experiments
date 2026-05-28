import { SceneQueryRunner } from '@grafana/scenes';

import { runWithSelectedQueryValues } from '../variables/DashboardVariableSet';

/**
 * Dashboard panels can query from a persisted variable selection while an
 * initial refresh is still hydrating the dropdown candidates.
 */
export class DashboardSceneQueryRunner extends SceneQueryRunner {
  public override runQueries(): void {
    if (this.state._hasFetchedData) {
      super.runQueries();
      return;
    }

    runWithSelectedQueryValues(() => super.runQueries());
  }
}
