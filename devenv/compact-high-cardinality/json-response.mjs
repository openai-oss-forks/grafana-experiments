import { generatedAxis, generatedSeriesMetadata, generatedValueAt } from './generated-series.mjs';

export function buildJsonResponse({
  refIds,
  queries,
  seriesPerQuery,
  pointCount,
  from,
  to,
  gappedSeriesEvery,
  gapEvery,
  seed,
}) {
  const axis = generatedAxis(pointCount, from, to);
  const timestamps = Array.from({ length: pointCount }, (_, index) => axis.start + axis.step * index);
  const queryByRefId = new Map((queries ?? []).map((query) => [query.refId, query]));
  const results = {};
  let globalSeriesIndex = 0;

  for (let resultIndex = 0; resultIndex < refIds.length; resultIndex++) {
    const refId = refIds[resultIndex];
    const query = queryByRefId.get(refId);
    const frames = [];
    for (let localSeriesIndex = 0; localSeriesIndex < seriesPerQuery; localSeriesIndex++, globalSeriesIndex++) {
      const { labels, displayNameFromDS } = generatedSeriesMetadata(query, refId, globalSeriesIndex);
      const values = Array.from({ length: pointCount }, (_, pointIndex) => {
        if (
          gappedSeriesEvery > 0 &&
          globalSeriesIndex % gappedSeriesEvery === 0 &&
          (pointIndex + globalSeriesIndex) % gapEvery === 0
        ) {
          return null;
        }
        return generatedValueAt(resultIndex, globalSeriesIndex, pointIndex, seed);
      });
      frames.push({
        schema: {
          refId,
          meta: {
            type: 'timeseries-multi',
            typeVersion: [0, 1],
            custom: { resultType: 'matrix' },
            preferredVisualisationType: 'graph',
          },
          fields: [
            { name: 'Time', type: 'time', typeInfo: { frame: 'time.Time', nullable: true } },
            {
              name: 'Value',
              type: 'number',
              typeInfo: { frame: 'float64', nullable: true },
              labels,
              ...(displayNameFromDS ? { config: { displayNameFromDS } } : undefined),
            },
          ],
        },
        data: { values: [timestamps, values] },
      });
    }
    results[refId] = { status: 200, frames };
  }

  return JSON.stringify({ results });
}
