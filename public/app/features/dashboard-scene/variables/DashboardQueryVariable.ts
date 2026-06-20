import { isEqual } from 'lodash';
import { tap } from 'rxjs';

import { stringToJsRegex } from '@grafana/data';
import {
  QueryVariable,
  type CustomVariableValue,
  type MultiValueVariableState,
  type VariableCustomFormatterFn,
  type VariableValue,
  type VariableValueOption,
  type VariableValueSingle,
} from '@grafana/scenes';
import { VariableFormatID } from '@grafana/schema';
import { ALL_VARIABLE_TEXT, ALL_VARIABLE_VALUE } from 'app/features/variables/constants';

import { DashboardVariableSet } from './DashboardVariableSet';

const PROMETHEUS_DATASOURCE_TYPE = 'prometheus';
const INITIAL_PROMETHEUS_ALL_VALUE = '.*';
const REGEX_SYNTAX = /[\\^$*+?()[\]{}|]/;

/**
 * Opts a dashboard into retaining regex-like custom query-variable values that
 * are not exact members of the variable's refreshed options.
 */
export const PRESERVE_CUSTOM_REGEX_VALUES_DASHBOARD_TAG = 'preserve-custom-regex-values';

/**
 * Prometheus can render an implicit All selection without enumerating its
 * label candidates. Retain normal candidate expansion after initial hydration.
 */
export class DashboardQueryVariable extends QueryVariable {
  private hasCompletedInitialOptionsHydration = false;

  public override validateAndUpdate() {
    return super.validateAndUpdate().pipe(
      tap({
        next: () => {
          this.hasCompletedInitialOptionsHydration = true;
        },
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

  protected override interceptStateUpdateAfterValidation(stateUpdate: Partial<MultiValueVariableState>): void {
    const skipNextValidation = this.skipNextValidation;
    super.interceptStateUpdateAfterValidation(stateUpdate);

    if (skipNextValidation || this.state.allowCustomValue === false || !this.shouldPreserveCustomRegexValues()) {
      return;
    }

    const currentValue = this.state.value;
    if (isAllValue(currentValue)) {
      return;
    }

    const options = stateUpdate.options ?? [];
    if (Array.isArray(currentValue)) {
      this.preserveMultiValueRegexes(stateUpdate, currentValue, options);
    } else if (!hasMatchingOption(currentValue, this.state.text, options) && isValidRegexLikeValue(currentValue)) {
      stateUpdate.value = currentValue;
      stateUpdate.text = this.state.text;
    }
  }

  private preserveMultiValueRegexes(
    stateUpdate: Partial<MultiValueVariableState>,
    currentValues: VariableValueSingle[],
    options: VariableValueOption[]
  ): void {
    const currentTexts = Array.isArray(this.state.text) ? this.state.text : [this.state.text];
    const values: VariableValueSingle[] = [];
    const texts: VariableValueSingle[] = [];
    let hasCustomRegex = false;

    currentValues.forEach((value, index) => {
      const exactOption = options.find((option) => option.value === value);
      if (exactOption) {
        values.push(exactOption.value);
        texts.push(exactOption.label);
      } else if (isValidRegexLikeValue(value)) {
        hasCustomRegex = true;
        values.push(value);
        texts.push(currentTexts[index] ?? value);
      }
    });

    if (!hasCustomRegex) {
      return;
    }

    stateUpdate.value = isEqual(values, currentValues) ? currentValues : values;
    stateUpdate.text = isEqual(texts, currentTexts) ? this.state.text : texts;
  }

  private shouldPreserveCustomRegexValues(): boolean {
    if (!(this.parent instanceof DashboardVariableSet)) {
      return false;
    }

    const dashboardState = this.parent.parent?.state;
    if (!dashboardState || !('tags' in dashboardState) || !Array.isArray(dashboardState.tags)) {
      return false;
    }

    return dashboardState.tags.includes(PRESERVE_CUSTOM_REGEX_VALUES_DASHBOARD_TAG);
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

function isAllValue(value: VariableValue): boolean {
  return value === ALL_VARIABLE_VALUE || (Array.isArray(value) && value[0] === ALL_VARIABLE_VALUE);
}

function hasMatchingOption(value: VariableValueSingle, text: VariableValue, options: VariableValueOption[]): boolean {
  return options.some((option) => option.value === value || option.label === text);
}

function isValidRegexLikeValue(value: VariableValueSingle): value is string {
  if (
    typeof value !== 'string' ||
    value === ALL_VARIABLE_VALUE ||
    (!value.startsWith('/') && !REGEX_SYNTAX.test(value))
  ) {
    return false;
  }

  try {
    stringToJsRegex(value);
    return true;
  } catch {
    return false;
  }
}

const initialPrometheusAllValue: CustomVariableValue = {
  formatter(formatNameOrFn?: string | VariableCustomFormatterFn): string {
    return formatNameOrFn === VariableFormatID.Text ? ALL_VARIABLE_TEXT : INITIAL_PROMETHEUS_ALL_VALUE;
  },
};
