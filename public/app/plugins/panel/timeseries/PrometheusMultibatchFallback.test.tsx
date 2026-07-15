import { render, waitFor } from '@testing-library/react';
import { lastValueFrom } from 'rxjs';

import {
  CoreApp,
  createTheme,
  DataQueryRequest,
  DataSourceInstanceSettings,
  dateTime,
  Field,
  FieldType,
  LoadingState,
  preProcessPanelData,
} from '@grafana/data';
import { PrometheusCacheLevel, PrometheusDatasource, PromOptions, PromQuery } from '@grafana/prometheus';
import { config, TemplateSrv } from '@grafana/runtime';
import { LegendDisplayMode } from '@grafana/schema';
import { UnthemedTimeSeries } from 'app/core/components/TimeSeries/TimeSeries';

import { prepareGraphableFields } from './utils';

const MULTIBATCH_CONTENT_TYPE = 'application/com.openai.prometheus.multibatch; version=1';

describe('Prometheus multibatch JSON fallback rendering', () => {
  const originalFetch = global.fetch;
  const originalMultiBatchToggle = config.featureToggles.prometheusMultiBatchStreaming;
  const originalPublicDashboardToken = config.publicDashboardAccessToken;

  afterEach(() => {
    global.fetch = originalFetch;
    config.featureToggles.prometheusMultiBatchStreaming = originalMultiBatchToggle;
    config.publicDashboardAccessToken = originalPublicDashboardToken;
  });

  it('renders a type-1 QueryData JSON fallback from a compact-v1 multibatch request', async () => {
    config.featureToggles.prometheusMultiBatchStreaming = true;
    config.publicDashboardAccessToken = undefined;

    const target: PromQuery = {
      datasource: { type: 'prometheus', uid: 'prometheus' },
      expr: 'up',
      instant: false,
      range: true,
      refId: 'A',
    };
    const range = {
      from: dateTime(0),
      to: dateTime(60_000),
      raw: { from: dateTime(0), to: dateTime(60_000) },
    };
    const request: DataQueryRequest<PromQuery> = {
      app: CoreApp.Dashboard,
      interval: '1m',
      intervalMs: 60_000,
      maxDataPoints: 100,
      panelPluginId: 'timeseries',
      preferredQueryResultFormat: 'compact-v1',
      range,
      requestId: 'prometheus-multibatch-json-fallback',
      scopedVars: {},
      startTime: 0,
      targets: [target],
      timezone: 'utc',
    };
    const queryDataPayload = JSON.stringify({
      results: {
        A: {
          frames: [
            {
              schema: {
                fields: [
                  { name: 'Time', type: 'time' },
                  { config: { displayNameFromDS: 'api' }, labels: { job: 'api' }, name: 'Value', type: 'number' },
                ],
                name: 'up',
                refId: 'A',
              },
              data: {
                values: [
                  [0, 60_000],
                  [1, 2],
                ],
              },
            },
          ],
        },
      },
    });
    const responseBody = multibatchJSONFallback(queryDataPayload);
    const fetchMock = jest.fn().mockResolvedValue({
      body: readableBody(responseBody),
      headers: new Headers({ 'content-type': MULTIBATCH_CONTENT_TYPE }),
      ok: true,
      status: 200,
      text: jest.fn(),
    });
    global.fetch = fetchMock;

    const datasource = new PrometheusDatasource(
      {
        access: 'proxy',
        jsonData: {
          cacheLevel: PrometheusCacheLevel.Low,
          customQueryParameters: '',
        },
        name: 'Prometheus',
        type: 'prometheus',
        uid: 'prometheus',
        url: 'http://prometheus',
      } as DataSourceInstanceSettings<PromOptions>,
      { replace: (value: string) => value } as unknown as TemplateSrv
    );

    const response = await lastValueFrom(datasource.query(request));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/datasources/uid/prometheus/resources/api/v1/query_range');
    expect(fetchMock.mock.calls[0][1].headers).toEqual(
      expect.objectContaining({
        Accept: expect.stringContaining('application/com.openai.prometheus.multibatch'),
        'X-Grafana-Query-Format': 'compact-v1',
      })
    );
    expect(response.state).toBe(LoadingState.Done);
    expect(response.compactSeries).toBeUndefined();
    expect(response.data).toHaveLength(1);
    expect(response.data[0].fields.map((field: Field) => field.type)).toEqual([FieldType.time, FieldType.number]);
    expect(response.data[0].fields[0].values).toEqual([0, 60_000]);
    expect(response.data[0].fields[1].values).toEqual([1, 2]);

    if (response.state === undefined) {
      throw new Error('Missing Prometheus response state');
    }

    const panelData = preProcessPanelData({
      annotations: [],
      request,
      series: response.data,
      state: response.state,
      timeRange: range,
    });
    const theme = createTheme();
    const frames = prepareGraphableFields(panelData.series, theme, range);
    expect(frames).not.toBeNull();

    const { container } = render(
      <UnthemedTimeSeries
        frames={frames!}
        height={240}
        legend={{
          calcs: [],
          displayMode: LegendDisplayMode.List,
          placement: 'bottom',
          showLegend: false,
        }}
        replaceVariables={(value) => value}
        theme={theme}
        timeRange={range}
        timeZone="utc"
        width={400}
      />
    );

    await waitFor(() => expect(container.querySelector('canvas')).not.toBeNull());
  });
});

function multibatchJSONFallback(payload: string): Uint8Array {
  const payloadBytes = new TextEncoder().encode(payload);
  const bytes = new Uint8Array(24 + payloadBytes.byteLength);
  bytes.set(new TextEncoder().encode('MBRH'), 0);
  bytes[4] = 1;
  bytes.set(new TextEncoder().encode('MBBF'), 12);
  bytes[16] = 1;
  bytes[17] = 1;
  bytes[18] = 1;
  new DataView(bytes.buffer).setUint32(20, payloadBytes.byteLength, false);
  bytes.set(payloadBytes, 24);
  return bytes;
}

function readableBody(chunk: Uint8Array): ReadableStream<Uint8Array> {
  let consumed = false;
  return {
    getReader() {
      return {
        read: async () => {
          if (consumed) {
            return { done: true, value: undefined };
          }
          consumed = true;
          return { done: false, value: chunk };
        },
        releaseLock: jest.fn(),
      };
    },
  } as unknown as ReadableStream<Uint8Array>;
}
