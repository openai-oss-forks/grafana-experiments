const LEGEND_LABEL_PATTERN = /\{\{\s*(.+?)\s*\}\}/g;
const BY_GROUPING_PATTERN = /\bby\s*\(([^)]*)\)/g;

export function generatedValueAt(resultIndex, seriesIndex, pointIndex, seed) {
  const seededSeries = seriesIndex + seed * 97;
  if ((seededSeries + pointIndex) % 251 === 0) {
    return 0;
  }
  if ((seededSeries * 17 + pointIndex) % 4093 === 0) {
    return 1_000_000;
  }
  return 50 + resultIndex * 10 + Math.sin((seededSeries * 3 + pointIndex) / 19) * 25;
}

export function generatedAxis(pointCount, from, to) {
  const start = Number.isSafeInteger(from) ? from : Date.now() - pointCount * 60_000;
  const end = Number.isSafeInteger(to) && to > start ? to : start + Math.max(1, pointCount - 1) * 60_000;
  const step = pointCount === 1 ? 60_000 : Math.max(1, Math.floor((end - start) / (pointCount - 1)));
  return { start, step, count: pointCount };
}

export function generatedSeriesMetadata(query, refId, seriesIndex) {
  const labelNames = collectLabelNames(query);
  const labels = {};
  for (const labelName of labelNames.length > 0 ? labelNames : ['series']) {
    labels[labelName] = generatedLabelValue(labelName, seriesIndex);
  }

  return {
    labels,
    displayNameFromDS: generatedDisplayName(query?.legendFormat, labels, refId),
  };
}

function collectLabelNames(query) {
  const names = [];
  const seen = new Set();
  const add = (name) => {
    const normalized = name.trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      names.push(normalized);
    }
  };

  if (typeof query?.legendFormat === 'string' && query.legendFormat !== '__auto') {
    for (const match of query.legendFormat.matchAll(LEGEND_LABEL_PATTERN)) {
      add(match[1]);
    }
  }
  if (typeof query?.expr === 'string') {
    for (const match of query.expr.matchAll(BY_GROUPING_PATTERN)) {
      for (const name of match[1].split(',')) {
        add(name);
      }
    }
  }
  return names;
}

function generatedLabelValue(labelName, seriesIndex) {
  if (labelName === 'env') {
    return 'prod';
  }
  const prefix = labelName.replaceAll(/[^a-zA-Z0-9_.-]/g, '_') || 'label';
  return `${prefix}-${String(seriesIndex).padStart(4, '0')}`;
}

function generatedDisplayName(legendFormat, labels, refId) {
  if (typeof legendFormat === 'string' && legendFormat !== '' && legendFormat !== '__auto') {
    return legendFormat.replace(LEGEND_LABEL_PATTERN, (_, name) => labels[name.trim()] ?? '');
  }
  if (legendFormat === '__auto') {
    return undefined;
  }
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0 ? refId : `{${entries.map(([name, value]) => `${name}="${value}"`).join(', ')}}`;
}
