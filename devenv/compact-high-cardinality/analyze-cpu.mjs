import fs from 'node:fs/promises';

const profilePath = process.argv[2];
if (!profilePath || process.argv.includes('--help')) {
  console.log(`Usage: node devenv/compact-high-cardinality/analyze-cpu.mjs <profile.cpuprofile>

Prints aggregate self time for the busiest functions. Set LIMIT to change the default top 30.`);
  process.exit(profilePath ? 0 : 1);
}

const profile = JSON.parse(await fs.readFile(profilePath, 'utf8'));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const groups = new Map();
let totalMicros = 0;
let idleMicros = 0;

for (let index = 0; index < profile.samples.length; index++) {
  const micros = profile.timeDeltas[index] ?? 0;
  const node = nodes.get(profile.samples[index]);
  const functionName = node?.callFrame?.functionName || '(anonymous)';
  const location = classifyUrl(node?.callFrame?.url ?? '');
  totalMicros += micros;
  if (functionName === '(idle)') {
    idleMicros += micros;
    continue;
  }
  const key = `${location}\0${functionName}`;
  groups.set(key, (groups.get(key) ?? 0) + micros);
}

const activeMicros = totalMicros - idleMicros;
const limit = Number(process.env.LIMIT ?? 30);
const rows = [...groups.entries()]
  .sort((left, right) => right[1] - left[1])
  .slice(0, limit)
  .map(([key, micros]) => {
    const [location, functionName] = key.split('\0');
    return {
      'self ms': round(micros / 1000),
      'active %': round((micros / activeMicros) * 100),
      location,
      function: functionName,
    };
  });

console.log(
  `Profile: ${profilePath}\nTotal: ${round(totalMicros / 1000)}ms, active: ${round(activeMicros / 1000)}ms, idle: ${round(idleMicros / 1000)}ms`
);
console.table(rows);

function classifyUrl(url) {
  if (!url) {
    return 'native';
  }
  if (url.includes('timeseriesPanel')) {
    return 'timeseries';
  }
  if (url.includes('/app.')) {
    return 'grafana-app';
  }
  return 'other';
}

function round(value) {
  return Math.round(value * 100) / 100;
}
