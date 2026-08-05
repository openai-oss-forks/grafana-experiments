import { useCallback, useMemo, useState } from 'react';
import { useToggle } from 'react-use';

import {
  DataFrame,
  DataQueryRequest,
  CompactTimeSeriesData,
  EventBus,
  AbsoluteTimeRange,
  TimeZone,
  SplitOpen,
  LoadingState,
  ThresholdsConfig,
  TimeRange,
  getPanelDataSeriesCount,
  limitPanelDataSeries,
} from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { config } from '@grafana/runtime';
import { GraphThresholdsStyleConfig, PanelChrome, PanelChromeProps } from '@grafana/ui';
import { ExploreGraphStyle } from 'app/types/explore';

import { LimitedDataDisclaimer } from '../LimitedDataDisclaimer';
import { storeGraphStyle } from '../state/utils';

import { ExploreGraph } from './ExploreGraph';
import { ExploreGraphLabel } from './ExploreGraphLabel';
import { loadGraphStyle } from './utils';

interface Props extends Pick<PanelChromeProps, 'statusMessage'> {
  width: number;
  height: number;
  data: DataFrame[];
  compactSeries?: CompactTimeSeriesData;
  request?: DataQueryRequest;
  annotations?: DataFrame[];
  eventBus: EventBus;
  timeRange: TimeRange;
  timeZone: TimeZone;
  onChangeTime: (absoluteRange: AbsoluteTimeRange) => void;
  splitOpenFn: SplitOpen;
  loadingState: LoadingState;
  thresholdsConfig?: ThresholdsConfig;
  thresholdsStyle?: GraphThresholdsStyleConfig;
  queriesChangedIndexAtRun?: number;
}

export const GraphContainer = ({
  data,
  compactSeries,
  request,
  eventBus,
  height,
  width,
  timeRange,
  timeZone,
  annotations,
  onChangeTime,
  splitOpenFn,
  thresholdsConfig,
  thresholdsStyle,
  loadingState,
  statusMessage,
  queriesChangedIndexAtRun,
}: Props) => {
  const [showAllSeries, toggleShowAllSeries] = useToggle(false);
  const [graphStyle, setGraphStyle] = useState(loadGraphStyle);

  const onGraphStyleChange = useCallback((graphStyle: ExploreGraphStyle) => {
    storeGraphStyle(graphStyle);
    setGraphStyle(graphStyle);
  }, []);

  const graphData = useMemo(
    () => limitPanelDataSeries({ series: data, compactSeries }, config.panelSeriesLimit, showAllSeries),
    [compactSeries, data, showAllSeries]
  );
  const seriesCount = getPanelDataSeriesCount({ series: data, compactSeries });

  return (
    <PanelChrome
      title={t('graph.container.title', 'Graph')}
      titleItems={[
        !showAllSeries && config.panelSeriesLimit > 0 && config.panelSeriesLimit < seriesCount && (
          <LimitedDataDisclaimer
            key="disclaimer"
            toggleShowAllSeries={toggleShowAllSeries}
            info={
              <Trans i18nKey={'graph.container.show-only-series'}>
                Showing only {{ MAX_NUMBER_OF_TIME_SERIES: config.panelSeriesLimit }} series
              </Trans>
            }
            buttonLabel={<Trans i18nKey={'graph.container.show-all-series'}>Show all {{ length: seriesCount }}</Trans>}
            tooltip={t(
              'graph.container.content',
              'Rendering too many series in a single panel may impact performance and make data harder to read. Consider refining your queries.'
            )}
          />
        ),
      ].filter(Boolean)}
      width={width}
      height={height}
      loadingState={loadingState}
      statusMessage={statusMessage}
      actions={<ExploreGraphLabel graphStyle={graphStyle} onChangeGraphStyle={onGraphStyleChange} />}
    >
      {(innerWidth, innerHeight) => (
        <ExploreGraph
          graphStyle={graphStyle}
          data={graphData.series}
          compactSeries={graphData.compactSeries}
          request={request}
          height={innerHeight}
          width={innerWidth}
          timeRange={timeRange}
          onChangeTime={onChangeTime}
          timeZone={timeZone}
          annotations={annotations}
          splitOpenFn={splitOpenFn}
          loadingState={loadingState}
          thresholdsConfig={thresholdsConfig}
          thresholdsStyle={thresholdsStyle}
          eventBus={eventBus}
          queriesChangedIndexAtRun={queriesChangedIndexAtRun}
        />
      )}
    </PanelChrome>
  );
};
