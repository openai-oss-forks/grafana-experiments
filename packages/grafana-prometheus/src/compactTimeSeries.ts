import {
  COMPACT_TIME_SERIES_FORMAT,
  CompactTimeSeriesAxis,
  CompactTimeSeriesData,
  CompactTimeSeriesMetadata,
  CompactTimeSeriesNotice,
  CompactTimeSeriesSeries,
  DataFrame,
  FieldType,
  Labels,
} from '@grafana/data';

export function materializeCompactTimeSeries(compact: CompactTimeSeriesData): DataFrame[] {
  const view = new DataView(compact.buffer);
  const bytes = new Uint8Array(compact.buffer);
  return compact.series.map((series) => {
    const axis = compact.axes[series.axisId];
    const times = new Array<number>(axis.count);
    const values = new Array<number | null>(axis.count);
    let packedIndex = 0;
    for (let index = 0; index < axis.count; index++) {
      times[index] = axis.start + axis.step * index;
      const present =
        series.presenceByteLength === 0 || (bytes[series.presenceByteOffset + (index >> 3)] & (1 << (index & 7))) !== 0;
      if (!present) {
        values[index] = null;
        continue;
      }
      values[index] = view.getFloat64(series.valuesByteOffset + packedIndex * Float64Array.BYTES_PER_ELEMENT, true);
      packedIndex++;
    }
    return {
      name: series.frameName,
      refId: series.refId,
      meta: series.meta,
      length: axis.count,
      fields: [
        { name: 'Time', type: FieldType.time, config: { interval: axis.step }, values: times },
        {
          name: series.valueName,
          type: FieldType.number,
          config: series.displayNameFromDS ? { displayNameFromDS: series.displayNameFromDS } : {},
          labels: compact.metadata.materializeLabels(series),
          values,
        },
      ],
    };
  });
}

export function combineCompactTimeSeries(
  compactSeriesList: Array<CompactTimeSeriesData | undefined>
): CompactTimeSeriesData | undefined {
  const compactSeries = compactSeriesList.filter((series): series is CompactTimeSeriesData => Boolean(series));
  if (compactSeries.length === 0) {
    return undefined;
  }
  if (compactSeries.length === 1) {
    return compactSeries[0];
  }

  const bufferOffsets: number[] = [];
  let combinedByteLength = 0;
  for (const series of compactSeries) {
    combinedByteLength = alignToEightBytes(combinedByteLength);
    bufferOffsets.push(combinedByteLength);
    combinedByteLength += series.buffer.byteLength;
  }

  const combinedBuffer = new ArrayBuffer(combinedByteLength);
  const combinedBytes = new Uint8Array(combinedBuffer);
  const combinedAxes: CompactTimeSeriesAxis[] = [];
  const combinedSeries: CompactTimeSeriesSeries[] = [];
  const combinedNotices: CompactTimeSeriesNotice[] = [];
  const sourceBySeries = new Map<
    CompactTimeSeriesSeries,
    { metadata: CompactTimeSeriesMetadata; series: CompactTimeSeriesSeries }
  >();
  let axisOffset = 0;
  let resultCount = 0;
  let stringCount = 0;
  let stringBytes = 0;

  compactSeries.forEach((source, index) => {
    const bufferOffset = bufferOffsets[index];
    combinedBytes.set(new Uint8Array(source.buffer), bufferOffset);
    combinedAxes.push(...source.axes);
    resultCount += source.decodeStats.resultCount;
    stringCount += source.decodeStats.stringCount;
    stringBytes += source.decodeStats.stringBytes;

    for (const sourceSeries of source.series) {
      const shiftedSeries: CompactTimeSeriesSeries = {
        ...sourceSeries,
        axisId: sourceSeries.axisId + axisOffset,
        labelRecordsOffset: sourceSeries.labelRecordsOffset + bufferOffset,
        presenceByteOffset: sourceSeries.presenceByteOffset + bufferOffset,
        valuesByteOffset: sourceSeries.valuesByteOffset + bufferOffset,
      };
      combinedSeries.push(shiftedSeries);
      sourceBySeries.set(shiftedSeries, { metadata: source.metadata, series: sourceSeries });
    }

    if (source.notices) {
      combinedNotices.push(...source.notices);
    }
    axisOffset += source.axes.length;
  });

  const metadata: CompactTimeSeriesMetadata = {
    getLabel: (series, name) => {
      const source = sourceBySeries.get(series);
      return source?.metadata.getLabel(source.series, name);
    },
    forEachLabel: (series, callback) => {
      const source = sourceBySeries.get(series);
      source?.metadata.forEachLabel(source.series, callback);
    },
    materializeLabels: (series, additional?: Labels) => {
      const source = sourceBySeries.get(series);
      return source?.metadata.materializeLabels(source.series, additional);
    },
  };

  return {
    kind: 'compact-response-view',
    format: COMPACT_TIME_SERIES_FORMAT,
    buffer: combinedBuffer,
    axes: combinedAxes,
    series: combinedSeries,
    metadata,
    notices: combinedNotices.length > 0 ? combinedNotices : undefined,
    decodeStats: {
      responseBytes: combinedBuffer.byteLength,
      axisCount: combinedAxes.length,
      resultCount,
      stringCount,
      stringBytes,
      seriesCount: combinedSeries.length,
    },
  };
}

function alignToEightBytes(value: number): number {
  return (value + 7) & ~7;
}
