import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIND_MAP_STORAGE_KEY,
  addMindMapConnection,
  addMindMapNode,
  createStoredMindMap,
  deleteMindMap,
  loadMindMaps,
  parseMindMapGraph,
  removeMindMapConnection,
  removeMindMapNode,
  renameMindMap,
  saveMindMaps,
  updateMindMapNode,
  upsertMindMap,
  type MindMapStorage,
} from './mindMaps';

function fixture() {
  return {
    title: 'Cell Biology',
    centralNodeId: 'cell',
    nodes: [
      { id: 'cell', label: 'Cell Biology', explanation: 'Study of cells.', level: 0 },
      { id: 'membrane', label: 'Cell membrane', explanation: 'Controls passage into and out of the cell.', level: 1, parentId: 'cell' },
      { id: 'nucleus', label: 'Nucleus', explanation: 'Contains genetic material.', level: 1, parentId: 'cell' },
      { id: 'dna', label: 'DNA', explanation: 'Stores genetic instructions.', level: 2, parentId: 'nucleus' },
    ],
    edges: [
      { id: 'e1', source: 'cell', target: 'membrane', label: 'contains', kind: 'branch' },
      { id: 'e2', source: 'cell', target: 'nucleus', label: 'contains', kind: 'branch' },
      { id: 'e3', source: 'nucleus', target: 'dna', label: 'contains', kind: 'branch' },
      { id: 'e4', source: 'membrane', target: 'nucleus', label: 'interacts with', kind: 'related' },
    ],
  };
}

test('validates graph structure, labels, depth and connections before layout', () => {
  const graph = parseMindMapGraph(fixture());
  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.nodes.find((node) => node.id === graph.centralNodeId)?.x, 900);
  assert.ok(graph.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)));
  assert.throws(() => parseMindMapGraph({ ...fixture(), nodes: [...fixture().nodes, { ...fixture().nodes[1], id: 'dup' }] }), /duplicate concepts/i);
  assert.throws(() => parseMindMapGraph({ ...fixture(), edges: fixture().edges.filter((edge) => edge.id !== 'e3') }), /hierarchy/i);
  assert.throws(() => parseMindMapGraph({ ...fixture(), edges: [{ id: 'bad', source: 'cell', target: 'missing', kind: 'related' }] }), /invalid or duplicate connection/i);
});

test('mind maps save, load, rename, upsert, delete, and survive corrupt storage', () => {
  let stored: string | null = null;
  const storage: MindMapStorage = { getItem: (key) => key === MIND_MAP_STORAGE_KEY ? stored : null, setItem: (_key, value) => { stored = value; } };
  const map = createStoredMindMap(parseMindMapGraph(fixture()), 'Chapter 4 notes.pdf', 'workspace', 1000, 'map-1');
  map.nodes[1].x += 83;
  assert.equal(saveMindMaps(storage, [map]), true);
  assert.deepEqual(loadMindMaps(storage), [map]);
  const renamed = renameMindMap(upsertMindMap([], map), map.id, 'Cells', 2000);
  assert.equal(renamed[0].title, 'Cells');
  assert.equal(deleteMindMap(renamed, map.id).length, 0);
  stored = 'broken';
  assert.deepEqual(loadMindMaps(storage), []);
  assert.equal(saveMindMaps({ getItem: () => null, setItem: () => { throw new Error('quota'); } }, [map]), false);
});

test('editing adds, updates, and removes nodes with their descendants and connections', () => {
  const initial = createStoredMindMap(parseMindMapGraph(fixture()), 'Chapter 4', 'notes', 1000, 'map-2');
  const withNode = addMindMapNode(initial, 'membrane', 'Transport proteins', 'Move selected molecules across the membrane.');
  const added = withNode.nodes.find((node) => node.label === 'Transport proteins');
  assert.ok(added);
  assert.equal(added?.level, 2);
  assert.equal(withNode.edges.filter((edge) => edge.kind === 'branch').length, withNode.nodes.length - 1);
  const edited = added ? updateMindMapNode(withNode, added.id, { label: 'Transport channels' }) : withNode;
  assert.equal(edited.nodes.find((node) => node.id === added?.id)?.label, 'Transport channels');
  const withRelated = addMindMapConnection(edited, 'membrane', 'dna', 'protects');
  const related = withRelated.edges.find((edge) => edge.kind === 'related' && edge.label === 'protects');
  assert.ok(related);
  const withoutRelated = related ? removeMindMapConnection(withRelated, related.id) : withRelated;
  assert.equal(withoutRelated.edges.some((edge) => edge.label === 'protects'), false);
  const removed = removeMindMapNode(withoutRelated, 'nucleus');
  assert.equal(removed.nodes.some((node) => node.id === 'dna'), false);
  assert.equal(removed.edges.some((edge) => edge.source === 'nucleus' || edge.target === 'nucleus'), false);
  assert.equal(removeMindMapNode(removed, removed.centralNodeId).nodes.length, removed.nodes.length);
});
