import { memo, useLayoutEffect, useMemo, useState } from 'react';
import uPlot from 'uplot';

import { AbsoluteTimeRange } from '@grafana/data';
import { Trans } from '@grafana/i18n';
import { Button, UPlotConfigBuilder } from '@grafana/ui';
import { CompactNativeRenderPlan } from 'app/core/components/GraphNG/compactNativePlan';

interface CompactOutsideRangePluginProps {
  config: UPlotConfigBuilder;
  plan: CompactNativeRenderPlan;
  onChangeTimeRange: (timeRange: AbsoluteTimeRange) => void;
}

export const CompactOutsideRangePlugin = memo(({ config, plan, onChangeTimeRange }: CompactOutsideRangePluginProps) => {
  const [timeRange, setTimeRange] = useState<uPlot.Scale>();
  const bounds = useMemo(() => getDataBounds(plan), [plan]);

  useLayoutEffect(() => {
    config.addHook('setScale', (plot) => setTimeRange({ ...plot.scales.x }));
  }, [config]);

  if (!bounds || !timeRange?.time || timeRange.min == null || timeRange.max == null) {
    return null;
  }

  let [first, last] = bounds;
  if (first <= timeRange.max && last >= timeRange.min) {
    return null;
  }
  if (first === last) {
    const delta = timeRange.max - timeRange.min;
    first -= delta / 2;
    last += delta / 2;
  }

  return (
    <div
      style={{ position: 'absolute', top: '50%', transform: 'translateY(-50%)', width: '100%', textAlign: 'center' }}
    >
      <div>
        <div>
          <Trans i18nKey="timeseries.outside-range-plugin.data-outside-time-range">Data outside time range</Trans>
        </div>
        <Button
          onClick={() => onChangeTimeRange({ from: first, to: last })}
          variant="secondary"
          data-testid="time-series-zoom-to-data"
        >
          <Trans i18nKey="timeseries.outside-range-plugin.zoom-to-data">Zoom to data</Trans>
        </Button>
      </div>
    </div>
  );
});

CompactOutsideRangePlugin.displayName = 'CompactOutsideRangePlugin';

function getDataBounds(plan: CompactNativeRenderPlan): [number, number] | null {
  if (plan.source.pointCount === 0) {
    return null;
  }
  let first = plan.source.pointCount;
  let last = -1;
  for (let seriesIndex = 0; seriesIndex < plan.seriesCount; seriesIndex++) {
    if (plan.source.columns.visibility[seriesIndex] === 0) {
      continue;
    }
    first = Math.min(first, plan.source.nearestPresent(seriesIndex, 0, 1) ?? first);
    last = Math.max(last, plan.source.nearestPresent(seriesIndex, plan.source.pointCount - 1, -1) ?? last);
  }
  return last < 0 ? null : [plan.source.xAt(first), plan.source.xAt(last)];
}
