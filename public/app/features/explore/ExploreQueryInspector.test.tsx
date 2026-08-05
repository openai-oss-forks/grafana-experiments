import { render, screen, fireEvent } from '@testing-library/react';
import { ComponentProps } from 'react';
import AutoSizer from 'react-virtualized-auto-sizer';
import { Observable } from 'rxjs';

import {
  COMPACT_TIME_SERIES_FORMAT,
  CompactTimeSeriesData,
  LoadingState,
  InternalTimeZones,
  getDefaultTimeRange,
} from '@grafana/data';
import { config } from '@grafana/runtime';
import { InspectorStream } from 'app/core/services/backend_srv';

import { ExploreQueryInspector } from './ExploreQueryInspector';

type ExploreQueryInspectorProps = ComponentProps<typeof ExploreQueryInspector>;

jest.mock('../inspector/styles', () => ({
  getPanelInspectorStyles: () => ({}),
  getPanelInspectorStyles2: () => ({}),
}));

jest.mock('app/core/services/backend_srv', () => ({
  backendSrv: {
    getInspectorStream: () =>
      new Observable((subscriber) => {
        subscriber.next(response());
        subscriber.next(response(true));
      }),
  },
}));

jest.mock('app/core/services/context_srv', () => ({
  contextSrv: {
    user: { orgId: 1 },
  },
}));

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  reportInteraction: () => null,
}));

jest.mock('react-virtualized-auto-sizer', () => {
  return {
    __esModule: true,
    default(props: ComponentProps<typeof AutoSizer>) {
      return <div>{props.children({ height: 1000, width: 1000, scaledHeight: 1000, scaledWidth: 1000 })}</div>;
    },
  };
});

const setup = (propOverrides = {}) => {
  const props: ExploreQueryInspectorProps = {
    exploreId: 'left',
    onClose: jest.fn(),
    timeZone: InternalTimeZones.utc,
    isMixed: false,
    queryResponse: {
      state: LoadingState.Done,
      series: [],
      timeRange: getDefaultTimeRange(),
      graphFrames: [],
      logsFrames: [],
      tableFrames: [],
      traceFrames: [],
      customFrames: [],
      nodeGraphFrames: [],
      flameGraphFrames: [],
      rawPrometheusFrames: [],
      graphResult: null,
      logsResult: null,
      tableResult: null,
      rawPrometheusResult: null,
    },
    runQueries: jest.fn(),
    ...propOverrides,
  };

  return render(<ExploreQueryInspector {...props} />);
};

const createCompactSeries = (count = 1) => {
  const buffer = new ArrayBuffer(16);
  new DataView(buffer).setFloat64(8, 71.2, true);
  const materializeLabels = jest.fn(() => ({ job: 'api' }));
  const compactSeries: CompactTimeSeriesData = {
    kind: 'compact-response-view',
    format: COMPACT_TIME_SERIES_FORMAT,
    buffer,
    axes: [{ start: 1704285124682, step: 1000, count: 1 }],
    series: Array.from({ length: count }, (_, index) => ({
      refId: 'A',
      valueName: `series-${index}`,
      axisId: 0,
      labelRecordsOffset: 0,
      labelCount: 1,
      presenceByteOffset: 0,
      presenceByteLength: 0,
      presentCount: 1,
      valuesByteOffset: 8,
    })),
    metadata: { getLabel: jest.fn(), forEachLabel: jest.fn(), materializeLabels },
    decodeStats: {
      responseBytes: 16,
      axisCount: 1,
      resultCount: 1,
      stringCount: 1,
      stringBytes: 1,
      seriesCount: count,
    },
  };

  return { compactSeries, materializeLabels };
};

describe('ExploreQueryInspector', () => {
  it('should render closable drawer component', () => {
    setup();
    expect(screen.getByLabelText(/close query inspector/i)).toBeInTheDocument();
  });
  it('should render 4 Tabs if queryResponse has no error', () => {
    setup();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
  });
  it('should render 5 Tabs if queryResponse has error', () => {
    setup({ queryResponse: { error: 'Bad gateway' } });
    expect(screen.getAllByRole('tab')).toHaveLength(5);
  });
  it('should display query data when click on expanding', () => {
    setup();
    fireEvent.click(screen.getByRole('tab', { name: /query/i }));
    fireEvent.click(screen.getByText(/expand all/i));
    expect(screen.getByText(/very unique test value/i)).toBeInTheDocument();
  });
  it('should display formatted data', () => {
    setup({
      queryResponse: {
        state: LoadingState.Done,
        series: [
          {
            refId: 'A',
            fields: [
              {
                name: 'time',
                type: 'time',
                typeInfo: {
                  frame: 'time.Time',
                  nullable: true,
                },
                config: {
                  interval: 30000,
                },
                values: [1704285124682, 1704285154682],
                entities: {},
              },
              {
                name: 'A-series',
                type: 'number',
                typeInfo: {
                  frame: 'float64',
                  nullable: true,
                },
                labels: {},
                config: {},
                values: [71.202732378676928, 72.348839082431916],
                entities: {},
              },
            ],
            length: 2,
          },
        ],
      },
    });

    fireEvent.click(screen.getByRole('tab', { name: /data/i }));
    // assert series values are formatted to 3 digits (xx.x or x.xx)
    expect(screen.getByText(/71.2/i)).toBeInTheDocument();
    expect(screen.getByText(/72.3/i)).toBeInTheDocument();
    // assert timestamps are formatted
    expect(screen.getByText(/2024-01-03 12:32:04.682/i)).toBeInTheDocument();
    expect(screen.getByText(/2024-01-03 12:32:34.682/i)).toBeInTheDocument();
  });

  it('materializes compact frames only when the Data tab is opened', () => {
    const { compactSeries, materializeLabels } = createCompactSeries();

    setup({
      queryResponse: {
        state: LoadingState.Done,
        series: [],
        timeRange: getDefaultTimeRange(),
        compactSeries,
      },
    });

    expect(materializeLabels).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: /data/i }));

    expect(materializeLabels).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/71.2/i)).toBeInTheDocument();
  });

  it('includes compact frames when ordinary frames are also present', () => {
    const { compactSeries, materializeLabels } = createCompactSeries();

    setup({
      queryResponse: {
        state: LoadingState.Done,
        timeRange: getDefaultTimeRange(),
        series: [
          {
            name: 'ordinary-series',
            refId: 'B',
            length: 1,
            fields: [
              { name: 'time', type: 'time', config: {}, values: [1704285124682] },
              { name: 'ordinary-value', type: 'number', config: {}, values: [42] },
            ],
          },
        ],
        compactSeries,
      },
    });

    fireEvent.click(screen.getByRole('tab', { name: /data/i }));

    expect(materializeLabels).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/ordinary-series/i)).toBeInTheDocument();
  });

  it('bounds compact inspection to the configured shared series limit', () => {
    const previousLimit = config.panelSeriesLimit;
    config.panelSeriesLimit = 1;
    const { compactSeries, materializeLabels } = createCompactSeries(3);

    try {
      setup({
        queryResponse: {
          state: LoadingState.Done,
          series: [],
          timeRange: getDefaultTimeRange(),
          compactSeries,
        },
      });

      fireEvent.click(screen.getByRole('tab', { name: /data/i }));

      expect(materializeLabels).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/71.2/i)).toBeInTheDocument();
    } finally {
      config.panelSeriesLimit = previousLimit;
    }
  });
});

const response = (hideFromInspector = false): InspectorStream => {
  return {
    response: {
      status: 1,
      statusText: '',
      ok: true,
      headers: new Headers(),
      redirected: false,
      type: 'basic',
      url: '',
      data: {
        test: {
          testKey: 'Very unique test value',
        },
      },
      config: {
        url: '',
        hideFromInspector,
      },
    },
    requestId: 'explore_left',
  };
};
