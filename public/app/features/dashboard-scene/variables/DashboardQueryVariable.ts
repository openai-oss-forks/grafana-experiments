import { tap } from 'rxjs';

import {
  QueryVariable,
  type CustomVariableValue,
  type VariableCustomFormatterFn,
  type VariableValue,
} from '@grafana/scenes';
import { VariableFormatID } from '@grafana/schema';
import { ALL_VARIABLE_TEXT } from 'app/features/variables/constants';

const PROMETHEUS_DATASOURCE_TYPE = 'prometheus';
const INITIAL_PROMETHEUS_ALL_VALUE = '.*';

/**
 * Prometheus can render an implicit All selection without enumerating its
 * label candidates. Retain normal candidate expansion after initial hydration.
 */
export class DashboardQueryVariable extends QueryVariable {
  private hasCompletedInitialOptionsHydration = false;

  public override validateAndUpdate() {
    return super.validateAndUpdate().pipe(
      tap({
        complete: () => {
          this.hasCompletedInitialOptionsHydration = true;
        },
      })
    );
  }

  public override getValue(fieldPath?: string): VariableValue {
    if (this.canUseInitialPrometheusAllValue()) {
      return initialPrometheusAllValue;
    }

    return super.getValue(fieldPath);
  }

  private canUseInitialPrometheusAllValue(): boolean {
    return (
      !this.hasCompletedInitialOptionsHydration &&
      this.state.datasource?.type === PROMETHEUS_DATASOURCE_TYPE &&
      this.hasAllValue() &&
      !this.state.allValue &&
      this.state.options.length === 0
    );
  }
}

const initialPrometheusAllValue: CustomVariableValue = {
  formatter(formatNameOrFn?: string | VariableCustomFormatterFn): string {
    return formatNameOrFn === VariableFormatID.Text ? ALL_VARIABLE_TEXT : INITIAL_PROMETHEUS_ALL_VALUE;
  },
};
