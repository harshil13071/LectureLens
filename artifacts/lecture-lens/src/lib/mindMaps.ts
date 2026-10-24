export const MIND_MAP_STORAGE_KEY = 'lecturelens-mind-maps-v1';
export const MAX_MIND_MAPS = 50;
export const MAX_MIND_MAP_NODES = 60;
export const MAX_MIND_MAP_EDGES = 100;
export const MIND_MAP_VIEWBOX = { width: 1800, height: 1400 };

export interface MindMapNode {
  id: string;
  label: string;
  explanation: string;
  level: number;
  parentId?: string;
  x: number;
  y: number;
}

export interface MindMapEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  kind: 'branch' | 'related';
}

export interface MindMapGraph {
  title: string;
  centralNodeId: string;
  nodes: MindMapNode[];
  edges: MindMapEdge[];
}

export interface StoredMindMap extends MindMapGraph {
  id: string;
  sourceTitle: string;
  sourceMode: 'workspace' | 'paste' | 'notes' | 'topic';
  createdAt: number;
  updatedAt: number;
}

export interface MindMapStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const boundedString = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
export const normalizeMindMapLabel = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function parseMindMapGraph(value: unknown, arrange = true): MindMapGraph {
  if (!isRecord(value) || !boundedString(value.title, 160) || !boundedString(value.centralNodeId, 48) || !Array.isArray(value.nodes) || value.nodes.length < 3 || value.nodes.length > MAX_MIND_MAP_NODES || !Array.isArray(value.edges) || value.edges.length > MAX_MIND_MAP_EDGES) {
    throw new Error('The AI returned an invalid mind map. Please try generating it again.');
  }
  const nodes: MindMapNode[] = value.nodes.map((raw) => {
    if (!isRecord(raw) || !boundedString(raw.id, 48) || !boundedString(raw.label, 80) || typeof raw.explanation !== 'string' || raw.explanation.length > 320 || !Number.isInteger(raw.level) || Number(raw.level) < 0 || Number(raw.level) > 4 || (raw.parentId !== undefined && !boundedString(raw.parentId, 48))) {
      throw new Error('The AI returned an invalid concept. Please try generating the map again.');
    }
    return {
      id: raw.id.trim(), label: raw.label.trim(), explanation: raw.explanation.trim(), level: Number(raw.level),
      ...(typeof raw.parentId === 'string' ? { parentId: raw.parentId.trim() } : {}),
      x: typeof raw.x === 'number' && Number.isFinite(raw.x) ? raw.x : 0,
      y: typeof raw.y === 'number' && Number.isFinite(raw.y) ? raw.y : 0,
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const labels = nodes.map((node) => normalizeMindMapLabel(node.label));
  if (nodeById.size !== nodes.length || new Set(labels).size !== labels.length) throw new Error('The AI returned duplicate concepts. Please try again with different study material.');
  const center = nodeById.get(value.centralNodeId);
  if (!center || center.level !== 0 || center.parentId || nodes.filter((node) => node.level === 0).length !== 1) throw new Error('The AI response did not contain exactly one central concept.');

  const edges: MindMapEdge[] = value.edges.map((raw) => {
    if (!isRecord(raw) || !boundedString(raw.id, 64) || !boundedString(raw.source, 48) || !boundedString(raw.target, 48) || (raw.label !== undefined && (typeof raw.label !== 'string' || raw.label.length > 80)) || !['branch', 'related'].includes(String(raw.kind))) {
      throw new Error('The AI returned an invalid concept connection.');
    }
    return { id: raw.id.trim(), source: raw.source.trim(), target: raw.target.trim(), ...(typeof raw.label === 'string' && raw.label.trim() ? { label: raw.label.trim() } : {}), kind: raw.kind as MindMapEdge['kind'] };
  });
  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target) || edge.source === edge.target || edgeIds.has(edge.id)) throw new Error('The mind map contains an invalid or duplicate connection.');
    const pair = edge.kind + ':' + edge.source + ':' + edge.target;
    if (pairs.has(pair)) throw new Error('The mind map contains duplicate connections.');
    edgeIds.add(edge.id);
    pairs.add(pair);
  }
  const branchEdges = edges.filter((edge) => edge.kind === 'branch');
  if (branchEdges.length !== nodes.length - 1) throw new Error('The mind map hierarchy is incomplete.');
  for (const node of nodes) {
    if (node.id === center.id) continue;
    const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
    if (!parent || node.level !== parent.level + 1 || !branchEdges.some((edge) => edge.source === parent.id && edge.target === node.id)) throw new Error('The mind map hierarchy is invalid.');
  }
  const graph = { title: value.title.trim(), centralNodeId: center.id, nodes, edges };
  return arrange ? layoutMindMap(graph) : graph;
}

export function layoutMindMap(graph: MindMapGraph): MindMapGraph {
  const centerX = MIND_MAP_VIEWBOX.width / 2;
  const centerY = MIND_MAP_VIEWBOX.height / 2;
  const children = new Map<string, MindMapNode[]>();
  for (const node of graph.nodes) if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const leafCount = (node: MindMapNode): number => {
    const descendants = children.get(node.id) ?? [];
    return descendants.length ? descendants.reduce((sum, child) => sum + leafCount(child), 0) : 1;
  };
  const position = (node: MindMapNode, start: number, end: number): void => {
    if (node.level === 0) { node.x = centerX; node.y = centerY; }
    else {
      const angle = (start + end) / 2;
      const radius = 145 * node.level;
      node.x = centerX + Math.cos(angle) * radius;
      node.y = centerY + Math.sin(angle) * radius;
    }
    const descendants = children.get(node.id) ?? [];
    const total = descendants.reduce((sum, child) => sum + leafCount(child), 0);
    let cursor = start;
    for (const child of descendants) {
      const next = cursor + (end - start) * leafCount(child) / total;
      position(child, cursor, next);
      cursor = next;
    }
  };
  const center = graph.nodes.find((node) => node.id === graph.centralNodeId);
  if (!center) return graph;
  position(center, -Math.PI, Math.PI);
  return graph;
}

export function createStoredMindMap(graph: MindMapGraph, sourceTitle: string, sourceMode: StoredMindMap['sourceMode'], now = Date.now(), id = 'map-' + now + '-' + Math.random().toString(36).slice(2, 9)): StoredMindMap {
  return { ...graph, id, sourceTitle: sourceTitle.trim().slice(0, 160) || 'Study material', sourceMode, createdAt: now, updatedAt: now };
}

export function parseStoredMindMaps(value: unknown): StoredMindMap[] {
  if (!Array.isArray(value)) return [];
  const results: StoredMindMap[] = [];
  for (const raw of value.slice(0, MAX_MIND_MAPS)) {
    if (!isRecord(raw) || !boundedString(raw.id, 100) || typeof raw.sourceTitle !== 'string' || !['workspace', 'paste', 'notes', 'topic'].includes(String(raw.sourceMode))) continue;
    try {
      const graph = parseMindMapGraph(raw, false);
      const now = Date.now();
      results.push({ ...graph, id: raw.id, sourceTitle: raw.sourceTitle.slice(0, 160), sourceMode: raw.sourceMode as StoredMindMap['sourceMode'], createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : now, updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now });
    } catch {
      // Ignore corrupt saved entries and keep valid maps available.
    }
  }
  return results;
}

export function loadMindMaps(storage: MindMapStorage): StoredMindMap[] {
  try { const raw = storage.getItem(MIND_MAP_STORAGE_KEY); return raw ? parseStoredMindMaps(JSON.parse(raw) as unknown) : []; } catch { return []; }
}

export function saveMindMaps(storage: MindMapStorage, maps: StoredMindMap[]): boolean {
  try { storage.setItem(MIND_MAP_STORAGE_KEY, JSON.stringify(parseStoredMindMaps(maps))); return true; } catch { return false; }
}

export function upsertMindMap(maps: StoredMindMap[], map: StoredMindMap): StoredMindMap[] {
  return [map, ...maps.filter((item) => item.id !== map.id)].slice(0, MAX_MIND_MAPS);
}

export function renameMindMap(maps: StoredMindMap[], id: string, title: string, now = Date.now()): StoredMindMap[] {
  const name = title.trim().slice(0, 160);
  return name ? maps.map((map) => map.id === id ? { ...map, title: name, updatedAt: now } : map) : maps;
}

export function deleteMindMap(maps: StoredMindMap[], id: string): StoredMindMap[] {
  return maps.filter((map) => map.id !== id);
}

export function updateMindMapNode(map: StoredMindMap, id: string, changes: Partial<Pick<MindMapNode, 'label' | 'explanation' | 'x' | 'y'>>): StoredMindMap {
  if (changes.label && map.nodes.some((node) => node.id !== id && normalizeMindMapLabel(node.label) === normalizeMindMapLabel(changes.label!))) return map;
  return { ...map, updatedAt: Date.now(), nodes: map.nodes.map((node) => node.id === id ? { ...node, ...changes } : node) };
}

export function addMindMapNode(map: StoredMindMap, parentId: string, label: string, explanation: string): StoredMindMap {
  const parent = map.nodes.find((node) => node.id === parentId);
  if (!parent || map.nodes.length >= MAX_MIND_MAP_NODES || parent.level >= 4 || !label.trim() || map.nodes.some((node) => normalizeMindMapLabel(node.label) === normalizeMindMapLabel(label))) return map;
  const id = 'node-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const node: MindMapNode = { id, label: label.trim().slice(0, 80), explanation: explanation.trim().slice(0, 320), level: parent.level + 1, parentId, x: parent.x + 120, y: parent.y + 80 };
  return { ...map, updatedAt: Date.now(), nodes: [...map.nodes, node], edges: [...map.edges, { id: 'edge-' + id, source: parentId, target: id, label: 'includes', kind: 'branch' }] };
}

export function removeMindMapNode(map: StoredMindMap, id: string): StoredMindMap {
  if (id === map.centralNodeId || !map.nodes.some((node) => node.id === id)) return map;
  const removed = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of map.nodes) if (node.parentId && removed.has(node.parentId) && !removed.has(node.id)) { removed.add(node.id); changed = true; }
  }
  return { ...map, updatedAt: Date.now(), nodes: map.nodes.filter((node) => !removed.has(node.id)), edges: map.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)) };
}

export function addMindMapConnection(map: StoredMindMap, source: string, target: string, label = 'related to'): StoredMindMap {
  if (source === target || !map.nodes.some((node) => node.id === source) || !map.nodes.some((node) => node.id === target) || map.edges.some((edge) => edge.kind === 'related' && edge.source === source && edge.target === target) || map.edges.length >= MAX_MIND_MAP_EDGES) return map;
  const edge: MindMapEdge = { id: 'edge-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), source, target, label: label.trim().slice(0, 80), kind: 'related' };
  return { ...map, updatedAt: Date.now(), edges: [...map.edges, edge] };
}

export function removeMindMapConnection(map: StoredMindMap, id: string): StoredMindMap {
  const edge = map.edges.find((item) => item.id === id);
  if (edge?.kind === 'branch') return removeMindMapNode(map, edge.target);
  return { ...map, updatedAt: Date.now(), edges: map.edges.filter((item) => item.id !== id) };
}

export function mindMapOutline(map: StoredMindMap): string {
  const children = new Map<string, MindMapNode[]>();
  for (const node of map.nodes) if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const lines = ['# ' + map.title, 'Source: ' + map.sourceTitle, ''];
  const visit = (id: string): void => {
    for (const child of children.get(id) ?? []) {
      lines.push('  '.repeat(child.level - 1) + '- **' + child.label + '**' + (child.explanation ? ': ' + child.explanation : ''));
      visit(child.id);
    }
  };
  const center = map.nodes.find((node) => node.id === map.centralNodeId);
  if (center) lines.push('## ' + center.label, ...(center.explanation ? [center.explanation] : []), '');
  visit(map.centralNodeId);
  const related = map.edges.filter((edge) => edge.kind === 'related');
  if (related.length) lines.push('', 'Related connections:', ...related.map((edge) => '- ' + map.nodes.find((node) => node.id === edge.source)?.label + ' ' + (edge.label || 'relates to') + ' ' + map.nodes.find((node) => node.id === edge.target)?.label));
  return lines.join('\n');
}
