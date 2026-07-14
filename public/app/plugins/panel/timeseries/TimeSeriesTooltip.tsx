import { css } from '@emotion/css';
import { ReactNode } from 'react';

import {
  DataFrame,
  Field,
  FieldType,
  formattedValueToString,
  GrafanaTheme2,
  InterpolateFunction,
  LinkModel,
  usePluginContext,
} from '@grafana/data';
import { t } from '@grafana/i18n';
import { SortOrder, TooltipDisplayMode } from '@grafana/schema';
import { useStyles2 } from '@grafana/ui';
import {
  VizTooltipContent,
  VizTooltipFooter,
  VizTooltipHeader,
  VizTooltipRow,
  VizTooltipWrapper,
  getContentItems,
  VizTooltipItem,
  AdHocFilterModel,
  FilterByGroupedLabelsModel,
} from '@grafana/ui/internal';

import { getFieldActions } from '../status-history/utils';

import { isTooltipScrollable } from './utils';

// exemplar / annotation / time region hovering?
// add annotation UI / alert dismiss UI?

export interface TimeSeriesTooltipProps {
  // aligned series frame
  series: DataFrame;

  // aligned fields that are not series
  _rest?: Field[];

  // hovered points
  dataIdxs: Array<number | null>;
  // closest/hovered series
  seriesIdx?: number | null;
  mode?: TooltipDisplayMode;
  sortOrder?: SortOrder;

  isPinned: boolean;

  annotate?: () => void;
  maxHeight?: number;

  replaceVariables?: InterpolateFunction;
  dataLinks: LinkModel[];
  hideZeros?: boolean;
  adHocFilters?: AdHocFilterModel[];
  filterByGroupedLabels?: FilterByGroupedLabelsModel;
  canExecuteActions?: boolean;
  compareDiffMs?: number[];
  highlightSeriesOnHover?: boolean;
}

export const TimeSeriesTooltip = ({
  series,
  _rest,
  dataIdxs,
  seriesIdx,
  mode = TooltipDisplayMode.Single,
  sortOrder = SortOrder.None,
  isPinned,
  annotate,
  maxHeight,
  replaceVariables = (str) => str,
  dataLinks,
  hideZeros,
  adHocFilters,
  canExecuteActions,
  compareDiffMs,
  filterByGroupedLabels,
  highlightSeriesOnHover = false,
}: TimeSeriesTooltipProps) => {
  const pluginContext = usePluginContext();
  const styles = useStyles2(getStyles);

  const xField = series.fields[0];
  let xVal = xField.values[dataIdxs[0]!];

  if (compareDiffMs != null && xField.type === FieldType.time) {
    xVal += compareDiffMs[seriesIdx ?? 1];
  }

  const xDisp = formattedValueToString(xField.display!(xVal));

  const contentItems = getContentItems(
    series.fields,
    xField,
    dataIdxs,
    seriesIdx,
    mode,
    sortOrder,
    (field) => field.type === FieldType.number || field.type === FieldType.enum,
    hideZeros,
    _rest
  );
  const focusedItem =
    highlightSeriesOnHover && mode === TooltipDisplayMode.Multi && contentItems.length > 1
      ? contentItems.find((item) => item.isActive)
      : undefined;
  const regularItems = focusedItem ? contentItems.filter((item) => item !== focusedItem) : contentItems;

  let footer: ReactNode;

  if (seriesIdx != null) {
    const field = series.fields[seriesIdx];
    const hasOneClickLink = dataLinks.some((dataLink) => dataLink.oneClick === true);

    if (isPinned || hasOneClickLink) {
      const visualizationType = pluginContext?.meta?.id ?? 'timeseries';
      const dataIdx = dataIdxs[seriesIdx]!;
      const actions = canExecuteActions
        ? getFieldActions(series, field, replaceVariables, dataIdx, visualizationType)
        : [];

      footer = (
        <VizTooltipFooter
          dataLinks={dataLinks}
          actions={actions}
          annotate={annotate}
          adHocFilters={adHocFilters}
          filterByGroupedLabels={filterByGroupedLabels}
        />
      );
    }
  }

  const headerItem: VizTooltipItem = {
    label: xField.type === FieldType.time ? '' : (xField.state?.displayName ?? xField.name),
    value: xDisp,
  };

  return (
    <VizTooltipWrapper>
      {headerItem != null && <VizTooltipHeader item={headerItem} isPinned={isPinned} />}
      {focusedItem && (
        <div
          className={styles.focusedSeries}
          style={{ borderLeftColor: focusedItem.color }}
          aria-label={t('timeseries.tooltip.focused-series-label', 'Focused series: {{series}}', {
            series: `${focusedItem.label}: ${focusedItem.value}`,
          })}
          data-testid="timeseries-tooltip-focused-series"
        >
          <div className={styles.focusedSeriesHeading}>
            {t('timeseries.tooltip.focused-series-heading', 'Focused series')}
          </div>
          <VizTooltipRow {...focusedItem} isActive isPinned={isPinned} wrapLabel />
        </div>
      )}
      <VizTooltipContent
        items={regularItems}
        isPinned={isPinned}
        scrollable={isTooltipScrollable({ mode, maxHeight })}
        maxHeight={maxHeight}
      />
      {footer}
    </VizTooltipWrapper>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  focusedSeries: css({
    borderTop: `1px solid ${theme.colors.border.weak}`,
    borderLeft: `3px solid ${theme.colors.border.medium}`,
    background: theme.colors.background.secondary,
    padding: theme.spacing(1),
    whiteSpace: 'normal',
  }),
  focusedSeriesHeading: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    fontWeight: theme.typography.fontWeightMedium,
    lineHeight: 1,
    marginBottom: theme.spacing(0.75),
  }),
});
