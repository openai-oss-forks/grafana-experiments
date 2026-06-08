function valueAt(resultIndex, seriesIndex, pointIndex, seed) {
  const seededSeries = seriesIndex + seed * 97;
  if ((seededSeries + pointIndex) % 251 === 0) {
    return 0;
  }
  if ((seededSeries * 17 + pointIndex) % 4093 === 0) {
    return 1_000_000;
  }
  return 50 + resultIndex * 10 + Math.sin((seededSeries * 3 + pointIndex) / 19) * 25;
}

export function buildJsonResponse({ refIds, seriesPerQuery, pointCount, from, to, gappedSeriesEvery, gapEvery, seed }) {
  const safeFrom = Number.isSafeInteger(from) ? from : Date.now() - pointCount * 60_000;
  const safeTo = Number.isSafeInteger(to) && to > safeFrom ? to : safeFrom + Math.max(1, pointCount - 1) * 60_000;
  const step = pointCount === 1 ? 60_000 : Math.max(1, Math.floor((safeTo - safeFrom) / (pointCount - 1)));
  const timestamps = Array.from({ length: pointCount }, (_, index) => safeFrom + step * index);
  const results = {};
  let globalSeriesIndex = 0;

  for (let resultIndex = 0; resultIndex < refIds.length; resultIndex++) {
    const refId = refIds[resultIndex];
    const frames = [];
    for (let localSeriesIndex = 0; localSeriesIndex < seriesPerQuery; localSeriesIndex++, globalSeriesIndex++) {
      const labels = {
        group: `group-${String(globalSeriesIndex % Math.min(64, seriesPerQuery)).padStart(2, '0')}`,
        series: `series-${String(globalSeriesIndex).padStart(7, '0')}`,
      };
      const values = Array.from({ length: pointCount }, (_, pointIndex) => {
        if (
          gappedSeriesEvery > 0 &&
          globalSeriesIndex % gappedSeriesEvery === 0 &&
          (pointIndex + globalSeriesIndex) % gapEvery === 0
        ) {
          return null;
        }
        return valueAt(resultIndex, globalSeriesIndex, pointIndex, seed);
      });
      frames.push({
        schema: {
          refId,
          fields: [
            { name: 'Time', type: 'time', typeInfo: { frame: 'time.Time', nullable: true } },
            {
              name: 'Value',
              type: 'number',
              typeInfo: { frame: 'float64', nullable: true },
              labels,
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
