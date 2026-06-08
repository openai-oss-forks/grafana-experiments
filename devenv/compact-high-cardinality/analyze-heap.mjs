import fs from 'node:fs/promises';

const snapshotPath = process.argv[2];
if (!snapshotPath || process.argv.includes('--help')) {
  console.log(`Usage: node devenv/compact-high-cardinality/analyze-heap.mjs <dashboard.heapsnapshot>

Prints strong retaining-parent trees for ArrayBuffer backing stores larger than MIN_BUFFER_MB (default: 1).
Limits each tree to MAX_PARENT_LINES (default: 200) and MAX_PARENT_DEPTH (default: 6).`);
  process.exit(snapshotPath ? 0 : 1);
}

const minBufferBytes = Number(process.env.MIN_BUFFER_MB ?? 1) * 1024 * 1024;
const maxParentLines = readPositiveInteger('MAX_PARENT_LINES', 200);
const maxParentDepth = readPositiveInteger('MAX_PARENT_DEPTH', 6);
const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
const { meta } = snapshot.snapshot;
const nodes = snapshot.nodes;
const edges = snapshot.edges;
const strings = snapshot.strings;
const nodeFields = indexFields(meta.node_fields);
const edgeFields = indexFields(meta.edge_fields);
const nodeFieldCount = meta.node_fields.length;
const edgeFieldCount = meta.edge_fields.length;
const nodeTypes = meta.node_types[nodeFields.type];
const edgeTypes = meta.edge_types[edgeFields.type];
const nodeCount = nodes.length / nodeFieldCount;
const edgeStarts = new Uint32Array(nodeCount + 1);

let edgeOffset = 0;
for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex++) {
  edgeStarts[nodeIndex] = edgeOffset;
  edgeOffset += nodes[nodeIndex * nodeFieldCount + nodeFields.edge_count] * edgeFieldCount;
}
edgeStarts[nodeCount] = edgeOffset;
const strongParents = buildStrongParentIndex();

const targets = [];
for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex++) {
  const node = readNode(nodeIndex);
  if (node.name.includes('JSArrayBufferData') && node.selfSize >= minBufferBytes) {
    targets.push(node);
  }
}
targets.sort((left, right) => right.selfSize - left.selfSize);

console.log(`Snapshot: ${snapshotPath}`);
console.log(`Nodes: ${nodeCount.toLocaleString()}, large ArrayBuffer stores: ${targets.length}`);
for (const target of targets) {
  console.log(`\n${formatNode(target)}`);
  const state = { lines: 0, truncated: false };
  printParentTree(target.index, 0, new Set([target.index]), state);
  if (state.truncated) {
    console.log(`  ... retaining tree truncated after ${maxParentLines} lines`);
  }
}

function printParentTree(childIndex, depth, visited, state) {
  if (depth >= maxParentDepth || state.lines >= maxParentLines) {
    state.truncated ||= state.lines >= maxParentLines;
    return;
  }
  const parents = findStrongParents(childIndex)
    .sort((left, right) => parentPriority(right) - parentPriority(left))
    .slice(0, depth < 3 ? 12 : 6);
  for (const parent of parents) {
    if (state.lines >= maxParentLines) {
      state.truncated = true;
      return;
    }
    const prefix = `${'  '.repeat(depth + 1)}<- ${parent.edgeType}:${parent.edgeName} `;
    console.log(`${prefix}${formatNode(parent.node)}`);
    state.lines++;
    if (
      !visited.has(parent.node.index) &&
      parent.node.type !== 'synthetic' &&
      parent.node.name !== '(GC roots)' &&
      parent.node.name !== '(Internalized strings)'
    ) {
      visited.add(parent.node.index);
      printParentTree(parent.node.index, depth + 1, visited, state);
      visited.delete(parent.node.index);
    }
  }
}

function findStrongParents(childIndex) {
  const parents = [];
  for (let position = strongParents.starts[childIndex]; position < strongParents.starts[childIndex + 1]; position++) {
    const cursor = strongParents.edgeOffsets[position];
    const edgeType = edgeTypes[edges[cursor + edgeFields.type]];
    const rawName = edges[cursor + edgeFields.name_or_index];
    parents.push({
      node: readNode(strongParents.nodeIndexes[position]),
      edgeType,
      edgeName: edgeType === 'element' || edgeType === 'hidden' ? String(rawName) : strings[rawName],
    });
  }
  return parents;
}

function buildStrongParentIndex() {
  const counts = new Uint32Array(nodeCount);
  let strongEdgeCount = 0;
  forEachStrongEdge((_parentIndex, _cursor, childIndex) => {
    counts[childIndex]++;
    strongEdgeCount++;
  });

  const starts = new Uint32Array(nodeCount + 1);
  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex++) {
    starts[nodeIndex + 1] = starts[nodeIndex] + counts[nodeIndex];
  }

  const nodeIndexes = new Uint32Array(strongEdgeCount);
  const edgeOffsets = new Uint32Array(strongEdgeCount);
  const writeOffsets = starts.slice(0, nodeCount);
  forEachStrongEdge((parentIndex, cursor, childIndex) => {
    const position = writeOffsets[childIndex]++;
    nodeIndexes[position] = parentIndex;
    edgeOffsets[position] = cursor;
  });
  return { starts, nodeIndexes, edgeOffsets };
}

function forEachStrongEdge(visitor) {
  for (let parentIndex = 0; parentIndex < nodeCount; parentIndex++) {
    for (let cursor = edgeStarts[parentIndex]; cursor < edgeStarts[parentIndex + 1]; cursor += edgeFieldCount) {
      if (edgeTypes[edges[cursor + edgeFields.type]] === 'weak') {
        continue;
      }
      visitor(parentIndex, cursor, edges[cursor + edgeFields.to_node] / nodeFieldCount);
    }
  }
}

function parentPriority(parent) {
  let score = 0;
  if (parent.edgeType === 'property' || parent.edgeType === 'context') {
    score += 100;
  } else if (parent.edgeType === 'internal') {
    score += 60;
  }
  if (parent.node.type === 'object' || parent.node.type === 'closure') {
    score += 40;
  }
  if (/Compact|Scene|Panel|Query|Graph|Data|Buffer|View|Array/i.test(parent.node.name)) {
    score += 20;
  }
  if (/buffer|source|data|state|value|result|response/i.test(parent.edgeName)) {
    score += 20;
  }
  return score;
}

function readNode(index) {
  const offset = index * nodeFieldCount;
  return {
    index,
    id: nodes[offset + nodeFields.id],
    type: nodeTypes[nodes[offset + nodeFields.type]],
    name: strings[nodes[offset + nodeFields.name]],
    selfSize: nodes[offset + nodeFields.self_size],
    detachedness: nodes[offset + nodeFields.detachedness],
  };
}

function formatNode(node) {
  return `${node.type} ${JSON.stringify(node.name)} id=${node.id} self=${formatBytes(node.selfSize)}${
    node.detachedness ? ` detached=${node.detachedness}` : ''
  }`;
}

function indexFields(fields) {
  return Object.fromEntries(fields.map((field, index) => [field, index]));
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${bytes}B`;
}

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}
