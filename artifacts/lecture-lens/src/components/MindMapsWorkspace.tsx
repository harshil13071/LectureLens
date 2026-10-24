import { useEffect, useMemo, useRef, useState } from 'react';
import { useGenerateMindMap, type MindMapInput } from '@workspace/api-client-react';
import { ArrowRight, Download, Expand, FileJson, FileText, Layers3, LoaderCircle, Minus, Plus, RotateCcw, Save, Search, Sparkles, Trash2, X } from 'lucide-react';
import {
  addMindMapConnection,
  addMindMapNode,
  createStoredMindMap,
  deleteMindMap,
  layoutMindMap,
  loadMindMaps,
  MAX_MIND_MAP_EDGES,
  MAX_MIND_MAP_NODES,
  mindMapOutline,
  normalizeMindMapLabel,
  MIND_MAP_STORAGE_KEY,
  MIND_MAP_VIEWBOX,
  parseMindMapGraph,
  removeMindMapConnection,
  removeMindMapNode,
  renameMindMap,
  saveMindMaps,
  updateMindMapNode,
  upsertMindMap,
  type MindMapEdge,
  type MindMapStorage,
  type StoredMindMap,
} from '@/lib/mindMaps';

type SourceMode = 'workspace' | 'paste' | 'notes' | 'topic';
type ViewTransform = { scale: number; x: number; y: number };
type DragState = { kind: 'pan'; lastX: number; lastY: number } | { kind: 'node'; id: string; lastX: number; lastY: number };

interface MindMapsWorkspaceProps {
  workspaceMaterial: string;
  workspaceTitle: string;
  savedNotesText: string;
  onSaveOutline: (id: string, title: string, outline: string) => void;
  onNavigateWorkspace: () => void;
}

const storage = (): MindMapStorage | null => {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
};

function errorText(error: unknown) {
  if (error && typeof error === 'object' && 'data' in error) {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') return data.error;
  }
  return error instanceof Error ? error.message : 'The mind map could not be generated. Please try again.';
}

function labelLines(label: string, maxLength: number) {
  const words = label.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && (line + ' ' + word).length > maxLength) { lines.push(line); line = word; }
    else line = line ? line + ' ' + word : word;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function hiddenNodeIds(map: StoredMindMap, collapsed: Set<string>) {
  const hidden = new Set<string>();
  const children = new Map<string, string[]>();
  for (const node of map.nodes) if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id]);
  const hideDescendants = (parent: string) => {
    for (const child of children.get(parent) ?? []) {
      if (hidden.has(child)) continue;
      hidden.add(child);
      hideDescendants(child);
    }
  };
  collapsed.forEach(hideDescendants);
  return hidden;
}

export function MindMapsWorkspace({ workspaceMaterial, workspaceTitle, savedNotesText, onSaveOutline, onNavigateWorkspace }: MindMapsWorkspaceProps) {
  const generate = useGenerateMindMap();
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const activeMapRef = useRef<StoredMindMap | null>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>('workspace');
  const [pastedText, setPastedText] = useState('');
  const [topic, setTopic] = useState('');
  const [titleInput, setTitleInput] = useState('');
  const [complexity, setComplexity] = useState<NonNullable<MindMapInput['complexity']>>('balanced');
  const [depth, setDepth] = useState(3);
  const [maps, setMaps] = useState<StoredMindMap[]>(() => { const target = storage(); return target ? loadMindMaps(target) : []; });
  const mapsRef = useRef(maps);
  mapsRef.current = maps;
  const [activeMap, setActiveMap] = useState<StoredMindMap | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [transform, setTransform] = useState<ViewTransform>({ scale: 0.85, x: 0, y: 0 });
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showLibrary, setShowLibrary] = useState(true);
  const [newLabel, setNewLabel] = useState('');
  const [newExplanation, setNewExplanation] = useState('');
  const [connectionTarget, setConnectionTarget] = useState('');
  const [connectionLabel, setConnectionLabel] = useState('related to');
  const [labelDraft, setLabelDraft] = useState('');
  const [explanationDraft, setExplanationDraft] = useState('');

  useEffect(() => {
    const target = storage();
    if (target && !saveMindMaps(target, maps)) setNotice('Browser storage is unavailable or full. Export a JSON backup of important maps.');
  }, [maps]);

  const sourceText = sourceMode === 'workspace' ? workspaceMaterial.trim() : sourceMode === 'paste' ? pastedText.trim() : sourceMode === 'notes' ? savedNotesText.trim() : '';
  const sourceValid = sourceMode === 'topic' ? topic.trim().length >= 2 : sourceText.length > 0;
  const selectedNode = activeMap?.nodes.find((node) => node.id === selectedId);
  const hidden = useMemo(() => activeMap ? hiddenNodeIds(activeMap, collapsed) : new Set<string>(), [activeMap, collapsed]);
  const visibleNodes = useMemo(() => activeMap?.nodes.filter((node) => !hidden.has(node.id)) ?? [], [activeMap, hidden]);
  const saved = Boolean(activeMap && maps.some((map) => map.id === activeMap.id));
  const filteredMaps = useMemo(() => maps.filter((map) => !filter || map.title.toLowerCase().includes(filter.toLowerCase()) || map.sourceTitle.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt), [maps, filter]);

  useEffect(() => { activeMapRef.current = activeMap; }, [activeMap]);
  useEffect(() => {
    setLabelDraft(selectedNode?.label ?? '');
    setExplanationDraft(selectedNode?.explanation ?? '');
  }, [selectedId, activeMap?.id]);

  function persistActive(next: StoredMindMap) {
    activeMapRef.current = next;
    setActiveMap(next);
    if (maps.some((map) => map.id === next.id)) setMaps((current) => current.map((map) => map.id === next.id ? next : map));
  }

  async function submitGenerate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (!sourceValid) {
      setError(sourceMode === 'workspace' ? 'Add or upload study material in Workspace first.' : sourceMode === 'notes' ? 'Generate study notes or save research to Notes first.' : sourceMode === 'topic' ? 'Enter a topic with at least two characters.' : 'Paste some study material first.');
      return;
    }
    const payload: MindMapInput = {
      title: titleInput.trim() || workspaceTitle.trim() || undefined,
      ...(sourceText ? { sourceText: sourceText.slice(0, 40000) } : {}),
      ...(sourceMode === 'topic' ? { topic: topic.trim() } : {}),
      complexity,
      depth,
    };
    try {
      const result = await generate.mutateAsync({ data: payload });
      const graph = parseMindMapGraph(result);
      const mapTitle = titleInput.trim() || graph.title;
      const sourceReference = sourceMode === 'topic' ? topic.trim() : sourceMode === 'workspace' ? workspaceTitle.trim() || 'Current Workspace material' : sourceMode === 'notes' ? 'Saved Notes' : 'Pasted study material';
      const map = createStoredMindMap({ ...graph, title: mapTitle }, sourceReference, sourceMode);
      activeMapRef.current = map;
      setActiveMap(map);
      setTitleDraft(map.title);
      setSelectedId(map.centralNodeId);
      setCollapsed(new Set());
      setTransform(fitTransform(map));
      setShowLibrary(false);
      setNotice('');
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  function fitTransform(map = activeMap) {
    if (!map?.nodes.length) return { scale: 1, x: 0, y: 0 };
    const xs = map.nodes.map((node) => node.x);
    const ys = map.nodes.map((node) => node.y);
    const width = Math.max(400, Math.max(...xs) - Math.min(...xs) + 260);
    const height = Math.max(300, Math.max(...ys) - Math.min(...ys) + 200);
    const scale = Math.max(0.38, Math.min(1.3, Math.min(MIND_MAP_VIEWBOX.width / width, MIND_MAP_VIEWBOX.height / height)));
    return {
      scale,
      x: MIND_MAP_VIEWBOX.width / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * scale,
      y: MIND_MAP_VIEWBOX.height / 2 - ((Math.min(...ys) + Math.max(...ys)) / 2) * scale,
    };
  }

  function openMap(map: StoredMindMap) {
    activeMapRef.current = map;
    setActiveMap(map);
    setTitleDraft(map.title);
    setSelectedId(map.centralNodeId);
    setCollapsed(new Set());
    setTransform(fitTransform(map));
    setShowLibrary(false);
    setError('');
  }

  function saveMap() {
    if (!activeMap) return;
    const title = titleDraft.trim().slice(0, 160);
    if (!title) { setError('Give this map a title before saving.'); return; }
    const next = { ...activeMap, title, updatedAt: Date.now() };
    activeMapRef.current = next;
    setActiveMap(next);
    setTitleDraft(title);
    setMaps((current) => upsertMindMap(current, next));
    setError('');
    setNotice('Mind map saved in this browser.');
  }

  function renameActive() {
    if (!activeMap || !titleDraft.trim()) { setTitleDraft(activeMap?.title ?? ''); return; }
    const title = titleDraft.trim().slice(0, 160);
    const next = { ...activeMap, title, updatedAt: Date.now() };
    activeMapRef.current = next;
    setActiveMap(next);
    setTitleDraft(title);
    if (maps.some((map) => map.id === next.id)) setMaps((current) => renameMindMap(current, next.id, title, next.updatedAt));
  }

  function resetLayout() {
    if (!activeMap) return;
    const arranged = layoutMindMap({ title: activeMap.title, centralNodeId: activeMap.centralNodeId, nodes: activeMap.nodes.map((node) => ({ ...node })), edges: activeMap.edges });
    const next = { ...activeMap, nodes: arranged.nodes, updatedAt: Date.now() };
    persistActive(next);
    setTransform(fitTransform(next));
  }

  function changeNode(id: string, changes: { label?: string; explanation?: string; x?: number; y?: number }) {
    if (!activeMap) return false;
    if (changes.label !== undefined && !changes.label.trim()) { setError('A concept label cannot be empty.'); return false; }
    if (changes.label && activeMap.nodes.some((node) => node.id !== id && normalizeMindMapLabel(node.label) === normalizeMindMapLabel(changes.label!))) {
      setError('Each concept needs a distinct label.');
      return false;
    }
    setError('');
    persistActive(updateMindMapNode(activeMap, id, changes));
    return true;
  }

  function addChild() {
    if (!activeMap || !selectedNode) return;
    const label = newLabel.trim();
    if (!label) { setError('Enter a label for the new concept.'); return; }
    if (activeMap.nodes.some((node) => normalizeMindMapLabel(node.label) === normalizeMindMapLabel(label))) { setError('Each concept needs a distinct label.'); return; }
    if (activeMap.nodes.length >= MAX_MIND_MAP_NODES || selectedNode.level >= 4) { setError('This map has reached its node or depth limit.'); return; }
    const next = addMindMapNode(activeMap, selectedNode.id, label, newExplanation);
    const newNode = next.nodes[next.nodes.length - 1];
    persistActive(next);
    setSelectedId(newNode.id);
    setCollapsed((current) => { const nextSet = new Set(current); nextSet.delete(selectedNode.id); return nextSet; });
    setNewLabel('');
    setNewExplanation('');
    setError('');
  }

  function addConnection() {
    if (!activeMap || !selectedNode || !connectionTarget) return;
    if (activeMap.edges.length >= MAX_MIND_MAP_EDGES) { setError('This map has reached its connection limit.'); return; }
    if (!connectionLabel.trim()) { setError('Add a label for this relationship.'); return; }
    persistActive(addMindMapConnection(activeMap, selectedNode.id, connectionTarget, connectionLabel));
    setConnectionLabel('related to');
    setError('');
  }

  function removeNode(id: string) {
    if (!activeMap || id === activeMap.centralNodeId) return;
    const parentId = activeMap.nodes.find((node) => node.id === id)?.parentId ?? activeMap.centralNodeId;
    const next = removeMindMapNode(activeMap, id);
    persistActive(next);
    setSelectedId(parentId);
    setCollapsed(new Set());
  }

  function searchForNode() {
    if (!activeMap || !search.trim()) return;
    const node = activeMap.nodes.find((item) => item.label.toLowerCase().includes(search.trim().toLowerCase()));
    if (!node) { setNotice('No matching concept found.'); return; }
    const ancestors = new Set<string>();
    let parent = node.parentId;
    while (parent) {
      ancestors.add(parent);
      parent = activeMap.nodes.find((item) => item.id === parent)?.parentId;
    }
    setCollapsed((current) => new Set([...current].filter((id) => !ancestors.has(id))));
    setSelectedId(node.id);
    setTransform((current) => ({ ...current, x: MIND_MAP_VIEWBOX.width / 2 - node.x * current.scale, y: MIND_MAP_VIEWBOX.height / 2 - node.y * current.scale }));
    setNotice('Selected “' + node.label + '”.');
  }

  function zoom(delta: number) {
    setTransform((current) => {
      const scale = Math.min(2.5, Math.max(0.35, current.scale + delta));
      const factor = scale / current.scale;
      const centerX = MIND_MAP_VIEWBOX.width / 2;
      const centerY = MIND_MAP_VIEWBOX.height / 2;
      return { scale, x: centerX - (centerX - current.x) * factor, y: centerY - (centerY - current.y) * factor };
    });
  }

  function downloadFile(filename: string, content: BlobPart, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportSvg() {
    if (!svgRef.current) return;
    const source = new XMLSerializer().serializeToString(svgRef.current);
    const svg = source.includes('xmlns=') ? source : source.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
    downloadFile((activeMap?.title || 'mind-map').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.svg', svg, 'image/svg+xml;charset=utf-8');
  }

  function exportJson() {
    if (!activeMap) return;
    downloadFile(activeMap.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.json', JSON.stringify(activeMap, null, 2), 'application/json');
  }

  function saveOutline() {
    if (!activeMap) return;
    onSaveOutline(activeMap.id, activeMap.title, mindMapOutline(activeMap));
    setNotice('Outline added to LectureLens Notes.');
  }

  function beginDrag(event: React.PointerEvent<SVGElement>, drag: DragState) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = drag;
  }

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      const svg = svgRef.current;
      if (!current || !svg) return;
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const toSvgPoint = (clientX: number, clientY: number) => {
        const point = svg.createSVGPoint();
        point.x = clientX;
        point.y = clientY;
        return point.matrixTransform(matrix.inverse());
      };
      const previous = toSvgPoint(current.lastX, current.lastY);
      const nextPoint = toSvgPoint(event.clientX, event.clientY);
      const dx = nextPoint.x - previous.x;
      const dy = nextPoint.y - previous.y;
      current.lastX = event.clientX;
      current.lastY = event.clientY;
      if (current.kind === 'pan') setTransform((state) => ({ ...state, x: state.x + dx, y: state.y + dy }));
      else {
        const map = activeMapRef.current;
        const node = map?.nodes.find((item) => item.id === current.id);
        if (!map || !node) return;
        const next = updateMindMapNode(map, current.id, { x: node.x + dx / transform.scale, y: node.y + dy / transform.scale });
        activeMapRef.current = next;
        setActiveMap(next);
        if (mapsRef.current.some((item) => item.id === next.id)) setMaps((items) => items.map((item) => item.id === next.id ? next : item));
      }
    };
    const stop = () => { dragRef.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [transform.scale]);

  const nodeMap = useMemo(() => new Map(activeMap?.nodes.map((node) => [node.id, node]) ?? []), [activeMap]);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const nodeChildren = activeMap ? activeMap.nodes.filter((node) => node.parentId === selectedId) : [];
  const relatedOptions = activeMap?.nodes.filter((node) => node.id !== selectedId) ?? [];

  return <section id="mind-maps" className="mindmaps-workspace scroll-mt-24 space-y-5" aria-labelledby="mindmaps-heading">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="mind-eyebrow">SEE THE CONNECTIONS</p><h2 id="mindmaps-heading" className="font-display text-[26px] font-bold tracking-[-.04em] sm:text-[32px]">AI Mind Maps</h2><p className="mt-1 max-w-2xl text-[13px] text-[var(--app-text-muted)]">Turn study material into a map you can explore, rearrange, and keep.</p></div>
      {activeMap && <div className="flex flex-wrap gap-2"><button type="button" onClick={() => { setActiveMap(null); setShowLibrary(true); }} className="mind-secondary"><Layers3 size={14} />Saved maps</button><button type="button" onClick={saveMap} className="mind-primary"><Save size={14} />{saved ? 'Save changes' : 'Save map'}</button></div>}
    </div>

    {!activeMap && <div className="mind-panel grid gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <form onSubmit={submitGenerate} className="space-y-4">
        <label className="mind-label" htmlFor="mind-source">Create map from<select id="mind-source" className="mind-input mt-1.5" value={sourceMode} onChange={(event) => setSourceMode(event.target.value as SourceMode)}><option value="workspace">Current Workspace material</option><option value="paste">Paste text or notes</option>{savedNotesText.trim() && <option value="notes">Saved Notes and research</option>}<option value="topic">A topic or chapter</option></select></label>
        {sourceMode === 'workspace' && <div className="mind-source">{workspaceMaterial.trim() ? <><strong>Workspace material ready</strong><span>{workspaceTitle || 'Current study material'} · {workspaceMaterial.trim().length.toLocaleString()} characters</span></> : <><strong>No active study material yet</strong><span>Paste notes or upload a PDF in Workspace first.</span><button type="button" className="mind-text-link" onClick={onNavigateWorkspace}>Go to Workspace</button></>}</div>}
        {sourceMode === 'paste' && <label className="mind-label" htmlFor="mind-paste">Paste lecture notes or text<textarea id="mind-paste" value={pastedText} maxLength={40000} onChange={(event) => setPastedText(event.target.value)} placeholder="Paste material for a grounded concept map…" className="mind-input mt-1.5 min-h-40 resize-y" /><span className="mt-1 block text-right font-normal text-[var(--app-text-muted)]">{pastedText.length.toLocaleString()} / 40,000 characters</span></label>}
        {sourceMode === 'notes' && <div className="mind-source">{savedNotesText.length.toLocaleString()} characters from current Notes and saved research.</div>}
        {sourceMode === 'topic' && <label className="mind-label" htmlFor="mind-topic">Topic, subject, or chapter<input id="mind-topic" value={topic} maxLength={160} onChange={(event) => setTopic(event.target.value)} placeholder="e.g. Cell biology, Chapter 6" className="mind-input mt-1.5" /></label>}
        <div className="grid gap-3 sm:grid-cols-2"><label className="mind-label" htmlFor="mind-title">Map title · optional<input id="mind-title" value={titleInput} maxLength={160} onChange={(event) => setTitleInput(event.target.value)} placeholder={topic || workspaceTitle || 'e.g. Cell biology overview'} className="mind-input mt-1.5" /></label><label className="mind-label" htmlFor="mind-complexity">Complexity<select id="mind-complexity" value={complexity} onChange={(event) => setComplexity(event.target.value as NonNullable<MindMapInput['complexity']>)} className="mind-input mt-1.5"><option value="simple">Simple</option><option value="balanced">Balanced</option><option value="detailed">Detailed</option></select></label></div>
        <label className="mind-label" htmlFor="mind-depth">Maximum depth<select id="mind-depth" value={depth} onChange={(event) => setDepth(Number(event.target.value))} className="mind-input mt-1.5"><option value={1}>1 level</option><option value={2}>2 levels</option><option value={3}>3 levels</option><option value={4}>4 levels</option></select></label>
        <button type="submit" disabled={generate.isPending || !sourceValid} className="mind-primary min-h-12 w-full justify-center text-[13px] disabled:cursor-not-allowed disabled:opacity-50">{generate.isPending ? <LoaderCircle size={16} className="animate-spin" /> : <Sparkles size={16} />}{generate.isPending ? 'Building your mind map…' : 'Generate Mind Map'}<ArrowRight size={15} /></button>
        <p className="text-[10px] leading-4 text-[var(--app-text-muted)]">Uploaded documents use the existing in-memory Workspace extraction flow.</p>
      </form>
      <aside className="mind-empty"><Layers3 size={24} /><strong>Start with a topic or your notes</strong><span>Explore concepts and connections on an interactive canvas. Your source text is used only for this generation request.</span></aside>
    </div>}

    {error && <div role="alert" className="mind-error">{error}</div>}
    {notice && <p role="status" className="text-[11px] text-[var(--app-text-muted)]">{notice}</p>}

    {activeMap && <div className="space-y-3">
      <div className="mind-toolbar">
        <label className="mind-map-name"><span className="sr-only">Mind map title</span><input value={titleDraft} maxLength={160} onChange={(event) => setTitleDraft(event.target.value)} onBlur={renameActive} aria-label="Mind map title" /></label>
        <label className="mind-search"><Search size={15} /><input aria-label="Search concepts" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); searchForNode(); } }} placeholder="Find a concept…" /></label>
        <button type="button" onClick={searchForNode} disabled={!search.trim()} className="mind-tool"><Search size={14} />Find</button>
        <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => zoom(-0.15)} className="mind-icon"><Minus size={15} /></button>
        <span className="mind-zoom">{Math.round(transform.scale * 100)}%</span>
        <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => zoom(0.15)} className="mind-icon"><Plus size={15} /></button>
        <button type="button" onClick={() => setTransform(fitTransform())} className="mind-tool"><Expand size={14} />Fit</button>
        <button type="button" onClick={resetLayout} className="mind-tool"><RotateCcw size={14} />Reset layout</button>
        <button type="button" onClick={exportSvg} className="mind-tool"><Download size={14} />SVG</button>
        <button type="button" onClick={exportJson} className="mind-tool"><FileJson size={14} />JSON</button>
        <button type="button" onClick={saveOutline} className="mind-tool"><FileText size={14} />Save outline to Notes</button>
      </div>
      <div className="mind-map-layout">
        <div className="mind-canvas" aria-label="Interactive concept map canvas">
          <svg ref={svgRef} viewBox={'0 0 ' + MIND_MAP_VIEWBOX.width + ' ' + MIND_MAP_VIEWBOX.height} role="application" aria-label="Mind map. Drag the background to pan and drag concepts to rearrange." onPointerDown={(event) => { if (!(event.target as Element).closest('.mind-node')) beginDrag(event, { kind: 'pan', lastX: event.clientX, lastY: event.clientY }); }} onWheel={(event) => { event.preventDefault(); zoom(event.deltaY < 0 ? 0.08 : -0.08); }} className="mind-svg">
            <rect width={MIND_MAP_VIEWBOX.width} height={MIND_MAP_VIEWBOX.height} fill="transparent" />
            <g transform={'translate(' + transform.x + ' ' + transform.y + ') scale(' + transform.scale + ')'}>
              {activeMap.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)).map((edge) => {
                const from = nodeMap.get(edge.source)!;
                const to = nodeMap.get(edge.target)!;
                const relatedToSelection = selectedId === edge.source || selectedId === edge.target;
                const muted = Boolean(selectedId && !relatedToSelection);
                return <g key={edge.id}><path d={'M ' + from.x + ' ' + from.y + ' Q ' + ((from.x + to.x) / 2) + ' ' + ((from.y + to.y) / 2 - (edge.kind === 'related' ? 45 : 0)) + ' ' + to.x + ' ' + to.y} fill="none" stroke={relatedToSelection ? '#a78bfa' : edge.kind === 'related' ? '#72688f' : '#4b4664'} strokeWidth={relatedToSelection ? 3.5 : 2.3} strokeOpacity={muted ? 0.2 : 1} strokeDasharray={edge.kind === 'related' ? '7 6' : undefined} markerEnd="url(#mind-arrow)" vectorEffect="non-scaling-stroke" /><title>{edge.label || (edge.kind === 'branch' ? 'branch' : 'related')}</title>{edge.label && <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 8} fill="#b3a8d5" fontSize="13" fontFamily="sans-serif" textAnchor="middle">{edge.label}</text>}</g>;
              })}
              <defs><marker id="mind-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#8175b3" /></marker></defs>
              {visibleNodes.map((node) => {
                const isCenter = node.id === activeMap.centralNodeId;
                const isSelected = node.id === selectedId;
                const isMatch = search.trim() && node.label.toLowerCase().includes(search.trim().toLowerCase());
                const hasChildren = activeMap.nodes.some((child) => child.parentId === node.id);
                const lines = labelLines(node.label, isCenter ? 22 : 18);
                return <g key={node.id} transform={'translate(' + node.x + ' ' + node.y + ')'} onPointerDown={(event) => beginDrag(event, { kind: 'node', id: node.id, lastX: event.clientX, lastY: event.clientY })} onClick={() => setSelectedId(node.id)} className="mind-node" role="button" tabIndex={0} aria-label={node.label + (hasChildren ? (collapsed.has(node.id) ? ', collapsed branch' : ', expanded branch') : '')} aria-pressed={isSelected} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(node.id); } }}>
                  <rect x={isCenter ? -100 : -83} y={isCenter ? -48 : -37} width={isCenter ? 200 : 166} height={isCenter ? 96 : 74} rx={isCenter ? 22 : 17} fill={isCenter ? '#3b315f' : '#242333'} stroke={isSelected || isMatch ? '#a78bfa' : isCenter ? '#806bd0' : '#4a465f'} strokeWidth={isSelected || isMatch ? 3 : 1.5} />
                  {lines.map((line, index) => <text key={index} x="0" y={lines.length === 1 ? 5 : -((lines.length - 1) * 9) + index * 19} textAnchor="middle" fill={isCenter ? '#f6f2ff' : '#eeebf5'} fontSize={isCenter ? '17' : '14'} fontWeight="700" fontFamily="sans-serif">{line}</text>)}
                  {node.explanation && <text x="0" y={isCenter ? 32 : 25} textAnchor="middle" fill="#b3adc5" fontSize="11" fontFamily="sans-serif">{node.explanation.slice(0, isCenter ? 26 : 22) + (node.explanation.length > (isCenter ? 26 : 22) ? '…' : '')}</text>}
                  {hasChildren && <g onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setCollapsed((current) => { const next = new Set(current); next.has(node.id) ? next.delete(node.id) : next.add(node.id); return next; }); }} className="mind-collapse" role="button" tabIndex={0} aria-label={collapsed.has(node.id) ? 'Expand branch' : 'Collapse branch'}><circle cx={isCenter ? 91 : 76} cy="0" r="11" fill="#715cc4" stroke="#d4c8ff" /><text x={isCenter ? 91 : 76} y="4" textAnchor="middle" className="mind-collapse-mark">{collapsed.has(node.id) ? '+' : '−'}</text></g>}
                </g>;
              })}
            </g>
          </svg>
          <span className="mind-canvas-hint">Drag to pan · drag a concept to move it · click a branch control to collapse</span>
        </div>
        <aside className="mind-details">
          {selectedNode ? <>
            <p className="mind-eyebrow">SELECTED CONCEPT</p>
            <label className="mind-label" htmlFor="mind-node-label">Label<input id="mind-node-label" value={labelDraft} maxLength={80} onChange={(event) => setLabelDraft(event.target.value)} onBlur={() => { if (labelDraft.trim()) changeNode(selectedNode.id, { label: labelDraft }); else setLabelDraft(selectedNode.label); }} className="mind-input mt-1.5" /></label>
            <label className="mind-label mt-3" htmlFor="mind-node-explanation">Explanation<textarea id="mind-node-explanation" value={explanationDraft} maxLength={320} onChange={(event) => setExplanationDraft(event.target.value)} onBlur={() => changeNode(selectedNode.id, { explanation: explanationDraft })} className="mind-input mt-1.5 min-h-24 resize-y" placeholder="Add a concise explanation…" /></label>
            <p className="mt-2 text-[10px] text-[var(--app-text-muted)]">Level {selectedNode.level} · {nodeChildren.length} direct child concepts</p>
            {selectedNode.id !== activeMap.centralNodeId && <button type="button" onClick={() => removeNode(selectedNode.id)} className="mind-danger mt-3"><Trash2 size={14} />Delete concept and its branch</button>}
            <div className="mind-divider" />
            <p className="mind-label">Add a child concept</p>
            <input value={newLabel} maxLength={80} onChange={(event) => setNewLabel(event.target.value)} placeholder="Concept label" className="mind-input mt-2" />
            <textarea value={newExplanation} maxLength={320} onChange={(event) => setNewExplanation(event.target.value)} placeholder="Short explanation" className="mind-input mt-2 min-h-16 resize-y" />
            <button type="button" onClick={addChild} disabled={activeMap.nodes.length >= MAX_MIND_MAP_NODES || selectedNode.level >= 4} className="mind-tool mt-2"><Plus size={14} />Add child</button>
            <div className="mind-divider" />
            <p className="mind-label">Add a related connection</p>
            <select value={connectionTarget} onChange={(event) => setConnectionTarget(event.target.value)} className="mind-input mt-2"><option value="">Choose another concept</option>{relatedOptions.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select>
            <input value={connectionLabel} maxLength={80} onChange={(event) => setConnectionLabel(event.target.value)} className="mind-input mt-2" aria-label="Connection label" />
            <button type="button" onClick={addConnection} disabled={!connectionTarget || activeMap.edges.length >= MAX_MIND_MAP_EDGES} className="mind-tool mt-2"><Plus size={14} />Add connection</button>
            <div className="mind-divider" />
            <p className="mind-label">Connections · {activeMap.edges.length} / {MAX_MIND_MAP_EDGES}</p>
            <div className="mt-2 max-h-36 space-y-1 overflow-auto">{activeMap.edges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id).map((edge) => <div key={edge.id} className="mind-connection-row"><span>{nodeMap.get(edge.source)?.label} {edge.label || 'relates to'} {nodeMap.get(edge.target)?.label}</span><button type="button" onClick={() => { if (edge.kind === 'branch') { removeNode(edge.target); } else persistActive(removeMindMapConnection(activeMap, edge.id)); }} aria-label="Delete connection" className="mind-icon"><X size={13} /></button></div>)}</div>
          </> : <div className="mind-empty"><Layers3 size={20} /><span>Select a concept to view and edit its details.</span></div>}
        </aside>
      </div>
      <div className="mind-map-caption"><span>{activeMap.sourceTitle}</span><span>{visibleNodes.length} visible of {activeMap.nodes.length} concepts · {activeMap.edges.length} connections</span><span>Saved {saved ? 'in this browser' : 'when you choose Save map'}</span></div>
    </div>}

    {showLibrary && <div className="mind-panel p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-display text-[17px] font-bold">Saved mind maps</h3><p className="mt-1 text-[11px] text-[var(--app-text-muted)]">Saved privately in this browser · {maps.length} / 50</p></div><button type="button" onClick={() => setShowLibrary(false)} className="mind-secondary"><X size={14} />Hide library</button></div>
      <label className="mind-search mt-4"><Search size={15} /><input aria-label="Search saved mind maps" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search saved maps" /></label>
      {filteredMaps.length ? <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{filteredMaps.map((map) => <article key={map.id} className="mind-map-tile"><button type="button" onClick={() => openMap(map)} className="min-w-0 flex-1 text-left"><strong>{map.title}</strong><span>{map.nodes.length} concepts · {map.sourceTitle}</span><small>Open map · {new Date(map.updatedAt).toLocaleDateString()}</small></button><button type="button" aria-label={'Delete ' + map.title} onClick={() => setMaps((current) => deleteMindMap(current, map.id))} className="mind-icon"><Trash2 size={14} /></button></article>)}</div> : <div className="mind-empty mt-4"><Layers3 size={20} /><strong>{maps.length ? 'No maps match your search.' : 'Your saved maps will appear here.'}</strong><span>Generate a map and save it to return to it later.</span></div>}
    </div>}
  </section>;
}
