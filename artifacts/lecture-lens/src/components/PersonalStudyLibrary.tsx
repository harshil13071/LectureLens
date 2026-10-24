import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, FileText, FileUp, LoaderCircle, LockKeyhole, LogOut, RefreshCw, Trash2, Upload } from 'lucide-react';
import { loadFlashcardDecks } from '@/lib/flashcards';
import { loadMindMaps, mindMapOutline } from '@/lib/mindMaps';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(options: { client_id: string; callback: (response: { credential?: string }) => void }): void;
          renderButton(parent: HTMLElement, options: { theme: string; size: string; shape: string; text: string; width: number }): void;
          cancel(): void;
        };
      };
    };
  }
}

type LibraryDocument = {
  id: string;
  sourceType: 'note' | 'document' | 'flashcards' | 'mindmap';
  title: string;
  subject: string | null;
  status: 'processing' | 'ready' | 'failed';
  errorCode: string | null;
  pageCount: number | null;
  chunkCount: number;
  updatedAt: string;
};
type Citation = { documentId: string; title: string; pageNumber: number | null; section: string | null; quote: string };
type Answer = { answer: string; insufficientMaterial: boolean; citations: Citation[] };
type StoredDocument = LibraryDocument & { content: string };

const GOOGLE_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const apiUrl = '/api/rag';

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'The study library request failed.');
  return payload as T;
}

function sourceKeyFromName(name: string) {
  return `file:${name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'upload'}`;
}

function downloadBrowserMaterials() {
  try {
    const storage = window.localStorage;
    const decks = loadFlashcardDecks(storage);
    const maps = loadMindMaps(storage);
    return [
      ...decks.map((deck) => ({
        sourceKey: `flashcards:${deck.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120)}`,
        sourceType: 'flashcards' as const,
        title: deck.title,
        content: deck.cards.map((card, index) => `Card ${index + 1}\nQuestion: ${card.front}\nAnswer: ${card.back}`).join('\n\n'),
      })),
      ...maps.map((map) => ({
        sourceKey: `mindmap:${map.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120)}`,
        sourceType: 'mindmap' as const,
        title: map.title,
        content: mindMapOutline(map),
      })),
    ].filter((item) => item.sourceKey.length >= 8 && item.content.trim().length > 0);
  } catch {
    return [];
  }
}

export function PersonalStudyLibrary({ workspaceText, workspaceTitle, onUseRetrievedMaterial, onSignedOut }: { workspaceText: string; workspaceTitle: string; onUseRetrievedMaterial?: (material: string, title: string) => void; onSignedOut?: () => void }) {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() ?? '';
  const buttonRef = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState('');
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const [subject, setSubject] = useState('');
  const [materialSubject, setMaterialSubject] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [contextBusy, setContextBusy] = useState(false);
  const [preview, setPreview] = useState<StoredDocument | null>(null);
  const [title, setTitle] = useState('');
  const [noteText, setNoteText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const request = useCallback(async <T,>(path: string, init: RequestInit = {}) => {
    const response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    if (response.status === 401) { setToken(''); setDocuments([]); setAnswer(null); setPreview(null); setSelectedIds(null); onSignedOut?.(); }
    return readJson<T>(response);
  }, [onSignedOut, token]);

  const refreshDocuments = useCallback(async () => {
    if (!token) return;
    const result = await request<{ documents: LibraryDocument[] }>('/documents');
    setDocuments(result.documents);
    setSelectedIds((current) => current === null ? null : current.filter((id) => result.documents.some((document) => document.id === id)));
  }, [request, token]);

  useEffect(() => {
    if (!token) return;
    void refreshDocuments().then(() => setStatus('')).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The library could not be loaded.'));
  }, [token, refreshDocuments]);

  useEffect(() => {
    if (!clientId || !buttonRef.current) return;
    let disposed = false;
    const render = () => {
      if (disposed || !buttonRef.current || !window.google) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (response) => {
          if (!response.credential) { setError('Google did not return a sign-in credential.'); return; }
          setError('');
          setStatus('Verifying your Google account…');
          setToken(response.credential);
        },
      });
      buttonRef.current.replaceChildren();
      window.google.accounts.id.renderButton(buttonRef.current, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: 260 });
    };
    if (window.google) render();
    else {
      let script = document.querySelector<HTMLScriptElement>(`script[src="${GOOGLE_SCRIPT_URL}"]`);
      if (!script) {
        script = document.createElement('script');
        script.src = GOOGLE_SCRIPT_URL;
        script.async = true;
        script.defer = true;
        document.head.append(script);
      }
      script.addEventListener('load', render);
      script.addEventListener('error', () => setError('Google sign-in could not load. Check your connection and retry.'));
      return () => { disposed = true; script?.removeEventListener('load', render); };
    }
    return () => { disposed = true; window.google?.accounts.id.cancel(); };
  }, [clientId]);

  const subjects = useMemo(() => Array.from(new Set(documents.map((document) => document.subject).filter((value): value is string => Boolean(value)))).sort(), [documents]);
  const visibleDocuments = useMemo(() => documents.filter((document) => !subject || document.subject === subject), [documents, subject]);

  const saveText = async (sourceType: 'note' | 'flashcards' | 'mindmap', sourceKey: string, itemTitle: string, content: string) => {
    await request<{ document: LibraryDocument }>('/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceKey, sourceType, title: itemTitle, subject: materialSubject || undefined, content }),
    });
  };

  const saveCurrent = async () => {
    const content = workspaceText.trim() || noteText.trim();
    if (!content) { setError('Add transcript text or a note before saving.'); return; }
    setBusy(true); setError(''); setStatus('Indexing your material…');
    try {
      const slug = workspaceTitle.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'current-workspace';
      await saveText('note', `note:${slug}`, workspaceTitle.trim() || 'Current study material', content);
      await refreshDocuments();
      setStatus('Material saved and indexed.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The material could not be indexed.'); setStatus(''); }
    finally { setBusy(false); }
  };

  const uploadDocument = async () => {
    if (!file) { setError('Choose a TXT, PDF, or DOCX document first.'); return; }
    setBusy(true); setError(''); setStatus('Extracting and indexing your document…');
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('sourceKey', sourceKeyFromName(file.name));
      form.set('title', title.trim() || file.name);
      if (materialSubject) form.set('subject', materialSubject);
      await request('/documents/upload', { method: 'POST', body: form });
      setFile(null); setTitle('');
      const input = document.getElementById('rag-file-input') as HTMLInputElement | null;
      if (input) input.value = '';
      await refreshDocuments();
      setStatus('Document saved and indexed.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The document could not be indexed.'); setStatus(''); }
    finally { setBusy(false); }
  };

  const importBrowserMaterials = async () => {
    const materials = downloadBrowserMaterials();
    if (!materials.length) { setError('No saved flashcard decks or mind maps were found in this browser.'); return; }
    setBusy(true); setError(''); setStatus('Importing saved browser materials…');
    let imported = 0;
    try {
      for (const item of materials.slice(0, 20)) {
        await saveText(item.sourceType, item.sourceKey, item.title, item.content);
        imported++;
      }
      await refreshDocuments();
      setStatus(`Imported ${imported} saved item${imported === 1 ? '' : 's'}${materials.length > imported ? `; ${materials.length - imported} remain. Import again to continue.` : '.'}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : `Import stopped after ${imported} items.`); setStatus(''); }
    finally { setBusy(false); }
  };

  const askLibrary = async (event: FormEvent) => {
    event.preventDefault();
    if (!question.trim()) return;
    setBusy(true); setError(''); setStatus('Searching your private library…'); setAnswer(null);
    try {
      const result = await request<Answer>('/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question.trim(), ...(selectedIds === null ? {} : { documentIds: selectedIds }), ...(subject ? { subject } : {}) }),
      });
      setAnswer(result); setStatus('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Your question could not be answered.'); setStatus(''); }
    finally { setBusy(false); }
  };

  const useRetrievedMaterial = async () => {
    if (!question.trim() || !onUseRetrievedMaterial) return;
    setContextBusy(true); setError('');
    try {
      const result = await request<{ passages: Array<{ title: string; pageNumber: number | null; section: string | null; text: string }> }>('/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question.trim(), ...(selectedIds === null ? {} : { documentIds: selectedIds }), ...(subject ? { subject } : {}) }),
      });
      if (!result.passages.length) { setError('No saved passages matched. Add or select material and try again.'); return; }
      const material = result.passages.map((passage, index) => `[${index + 1}] ${passage.title}${passage.pageNumber ? ` · page ${passage.pageNumber}` : passage.section ? ` · ${passage.section}` : ''}\n${passage.text}`).join('\n\n').slice(0, 40_000);
      onUseRetrievedMaterial(material, `Library: ${question.trim().slice(0, 100)}`);
      setStatus('Retrieved passages are ready in Practice and Flashcards.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Study passages could not be retrieved.'); }
    finally { setContextBusy(false); }
  };

  const toggleDocument = (id: string) => {
    setSelectedIds((current) => {
      const selected = new Set(current ?? documents.map((document) => document.id));
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      return selected.size === documents.length ? null : [...selected];
    });
  };

  const showDocument = async (citation: Citation) => {
    try {
      const result = await request<{ document: StoredDocument }>(`/documents/${citation.documentId}`);
      setPreview(result.document);
      window.setTimeout(() => document.getElementById(`rag-doc-${citation.documentId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The source could not be opened.'); }
  };

  const removeDocument = async (id: string) => {
    setBusy(true); setError('');
    try {
      await request(`/documents/${id}`, { method: 'DELETE' });
      if (preview?.id === id) setPreview(null);
      await refreshDocuments();
      setStatus('Material and its indexed passages were deleted.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The material could not be deleted.'); }
    finally { setBusy(false); }
  };

  return <section className="mt-5 rounded-2xl border border-[#ded8f5] bg-[#faf9ff] p-4 sm:p-5" aria-label="Private study library tutor">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3"><div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#eeeaff] text-[#6c59d4]"><BookOpen size={17} /></div><div><h3 className="font-display text-[15px] font-bold text-[#403c56]">Ask across your study library</h3><p className="mt-1 max-w-2xl text-[11px] leading-5 text-[#77738b]">Answers search only material saved to your private, Google-verified library. Study Rooms content is kept separate.</p></div></div>
      {token && <button type="button" onClick={() => { setToken(''); setDocuments([]); setAnswer(null); setPreview(null); setSelectedIds(null); setQuestion(''); onSignedOut?.(); setStatus('Signed out of the private library.'); }} className="inline-flex items-center gap-1.5 rounded-lg border border-[#e3e0eb] bg-white px-2.5 py-1.5 text-[10px] font-semibold text-[#716c82]"><LogOut size={12} /> Sign out</button>}
    </div>

    {!token ? <div className="mt-4 rounded-xl border border-[#ebe8f3] bg-white p-4">
      <div className="flex items-start gap-2 text-[11px] leading-5 text-[#716c82]"><LockKeyhole size={14} className="mt-0.5 shrink-0 text-[#7565c7]" /><p>Sign in to create a private library. Your Google account is verified by the LectureLens server. Your personal library is not shared with Study Rooms.</p></div>
      {clientId ? <div className="mt-3 min-h-10" ref={buttonRef} /> : <p role="status" className="mt-3 rounded-lg bg-[#fff8e8] px-3 py-2 text-[11px] text-[#8b6723]">Google sign-in needs <code>VITE_GOOGLE_CLIENT_ID</code> in the frontend environment and the same client ID as <code>GOOGLE_CLIENT_ID</code> on the API.</p>}
    </div> : <>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#e8e5ef] bg-white px-3 py-2 text-[10px] text-[#77738b]"><span className="inline-flex items-center gap-1.5"><Check size={12} className="text-emerald-600" /> Signed in; {documents.length} private item{documents.length === 1 ? '' : 's'} indexed</span><button type="button" onClick={() => void refreshDocuments().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Refresh failed.'))} className="inline-flex items-center gap-1 rounded px-2 py-1 font-semibold"><RefreshCw size={12} /> Refresh</button></div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-[#e8e5ef] bg-white p-3.5">
          <h4 className="text-[11px] font-bold text-[#514d65]">Save current workspace material</h4>
          <p className="mt-1 text-[10px] leading-4 text-[#8b8798]">Saves the current transcript, extracted text, or generated notes under your account.</p>
          <button type="button" disabled={busy || !(workspaceText.trim() || noteText.trim())} onClick={() => void saveCurrent()} className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-[#6754d9] px-3 py-2 text-[10px] font-bold text-white disabled:opacity-45"><FileText size={13} /> Save current material</button>
          <label className="mt-3 block text-[10px] font-semibold text-[#6d687f]" htmlFor="rag-note-text">Or add a private note</label>
          <textarea id="rag-note-text" value={noteText} onChange={(event) => setNoteText(event.target.value.slice(0, 40_000))} maxLength={40_000} placeholder="Paste study notes to add them to your searchable library…" className="mt-1.5 min-h-20 w-full rounded-lg border border-[#e8e5ef] bg-[#fcfbfe] p-2.5 text-[11px] leading-5 text-[#4c4860] outline-none focus:border-[#a89aed]" />
          <label className="mt-2.5 block text-[10px] font-semibold text-[#6d687f]" htmlFor="rag-material-subject">Subject (optional)</label>
          <input id="rag-material-subject" value={materialSubject} onChange={(event) => setMaterialSubject(event.target.value.slice(0, 120))} maxLength={120} placeholder="Biology, history…" className="mt-1.5 w-full rounded-lg border border-[#e8e5ef] px-2.5 py-2 text-[11px] outline-none focus:border-[#a89aed]" />
          <button type="button" disabled={busy || !noteText.trim()} onClick={() => void (async () => {
            setBusy(true); setError(''); setStatus('Indexing your note…');
            try { const slug = (title.trim() || 'Personal note').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'personal-note'; await saveText('note', `note:${slug}`, title.trim() || 'Personal note', noteText); await refreshDocuments(); setNoteText(''); setTitle(''); setStatus('Note saved and indexed.'); }
            catch (reason) { setError(reason instanceof Error ? reason.message : 'The note could not be indexed.'); setStatus(''); }
            finally { setBusy(false); }
          })()} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-[#ded8f5] px-3 py-2 text-[10px] font-bold text-[#6655c6] disabled:opacity-45"><Upload size={13} /> Add note</button>
        </div>

        <div className="rounded-xl border border-[#e8e5ef] bg-white p-3.5">
          <h4 className="text-[11px] font-bold text-[#514d65]">Add a document</h4>
          <p className="mt-1 text-[10px] leading-4 text-[#8b8798]">TXT, PDF, and DOCX up to 15 MB. Extracted text is limited to 250,000 characters.</p>
          <label className="mt-3 block text-[10px] font-semibold text-[#6d687f]" htmlFor="rag-document-title">Title</label>
          <input id="rag-document-title" value={title} onChange={(event) => setTitle(event.target.value.slice(0, 200))} maxLength={200} placeholder="Use the file name if blank" className="mt-1.5 w-full rounded-lg border border-[#e8e5ef] px-2.5 py-2 text-[11px] outline-none focus:border-[#a89aed]" />
          <label className="mt-2 block text-[10px] font-semibold text-[#6d687f]" htmlFor="rag-upload-subject">Subject (optional)</label>
          <input id="rag-upload-subject" value={materialSubject} onChange={(event) => setMaterialSubject(event.target.value.slice(0, 120))} maxLength={120} placeholder="Biology, history…" className="mt-1.5 w-full rounded-lg border border-[#e8e5ef] px-2.5 py-2 text-[11px] outline-none focus:border-[#a89aed]" />
          <label className="mt-2.5 flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-[#cfc8e7] bg-[#fcfbff] px-3 py-3 text-[10px] font-semibold text-[#716a89]">
            <FileUp size={15} /><span className="min-w-0 flex-1 truncate">{file?.name ?? 'Choose a TXT, PDF, or DOCX file'}</span>
            <input id="rag-file-input" type="file" accept=".txt,.pdf,.docx" className="sr-only" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </label>
          <button type="button" disabled={busy || !file} onClick={() => void uploadDocument()} className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-[#6754d9] px-3 py-2 text-[10px] font-bold text-white disabled:opacity-45"><Upload size={13} /> Upload and index</button>
          <button type="button" disabled={busy} onClick={() => void importBrowserMaterials()} className="mt-2.5 ml-2 inline-flex items-center gap-1.5 rounded-lg border border-[#ded8f5] px-3 py-2 text-[10px] font-bold text-[#6655c6] disabled:opacity-45">Import saved flashcards/maps</button>
          <p className="mt-2 text-[9px] leading-4 text-[#9691a5]">Browser materials are imported only when you choose this action. Up to 20 items per click.</p>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-[#e8e5ef] bg-white p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-[11px] font-bold text-[#514d65]">Your searchable library</h4><label className="flex items-center gap-2 text-[10px] text-[#77738b]">Subject <select value={subject} onChange={(event) => setSubject(event.target.value)} className="rounded border border-[#e8e5ef] bg-white px-2 py-1"><option value="">All subjects</option>{subjects.map((item) => <option key={item} value={item}>{item}</option>)}</select></label></div>
        {documents.length === 0 ? <p className="mt-3 rounded-lg border border-dashed border-[#e3dfed] px-3 py-4 text-center text-[10px] text-[#8b8798]">Your library is empty. Save the current material, add a note, or upload a document.</p> : <div className="mt-2 space-y-1.5">
          {visibleDocuments.map((document) => <article id={`rag-doc-${document.id}`} key={document.id} className="rounded-lg border border-[#efedf4] px-2.5 py-2">
            <div className="flex items-center gap-2"><input type="checkbox" aria-label={`Include ${document.title} in library questions`} checked={selectedIds === null || selectedIds.includes(document.id)} onChange={() => toggleDocument(document.id)} className="accent-[#6754d9]" /><div className="min-w-0 flex-1"><div className="truncate text-[10px] font-semibold text-[#514d65]">{document.title}</div><div className="text-[9px] text-[#928da0]">{document.subject || 'No subject'} · {document.status === 'ready' ? `${document.chunkCount} passages` : document.status === 'processing' ? 'Indexing' : 'Indexing failed'}</div>{document.status === 'failed' && <div role="alert" className="text-[9px] text-rose-600">{document.errorCode === 'EMBEDDING_NOT_CONFIGURED' ? 'Set the server embedding API key, then upload again.' : 'Could not index this item. Retry by saving it again.'}</div>}</div><button type="button" title="Delete material and indexed passages" onClick={() => void removeDocument(document.id)} disabled={busy} className="rounded p-1.5 text-[#9b96a8] hover:text-rose-600 disabled:opacity-40"><Trash2 size={13} /></button></div>
            {preview?.id === document.id && <div className="mt-2 max-h-36 overflow-auto rounded bg-[#faf9fe] p-2 text-[10px] leading-5 text-[#68647a]"><div className="mb-1 font-semibold">Saved extracted text</div><pre className="whitespace-pre-wrap font-sans">{preview.content.slice(0, 8_000)}{preview.content.length > 8_000 ? '…' : ''}</pre></div>}
          </article>)}
        </div>}
      </div>

      <form onSubmit={(event) => void askLibrary(event)} className="mt-3 rounded-xl border border-[#e8e5ef] bg-white p-3.5">
        <label htmlFor="rag-question" className="block text-[10px] font-bold text-[#514d65]">Ask across selected material</label>
        <textarea id="rag-question" value={question} onChange={(event) => setQuestion(event.target.value.slice(0, 2_000))} maxLength={2_000} placeholder="Ask a question across your saved notes and documents…" className="mt-1.5 min-h-20 w-full rounded-lg border border-[#e8e5ef] bg-[#fcfbfe] p-2.5 text-[11px] leading-5 outline-none focus:border-[#a89aed]" />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="text-[9px] text-[#9994aa]">{selectedIds === null ? 'Searching all indexed items' : `${selectedIds.length} selected item${selectedIds.length === 1 ? '' : 's'}`}</span><button type="submit" disabled={busy || !question.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-[#6754d9] px-3 py-2 text-[10px] font-bold text-white disabled:opacity-45">{busy ? <LoaderCircle size={13} className="animate-spin" /> : <BookOpen size={13} />} Ask my library</button></div>
      </form>

      {answer && <article className="mt-3 rounded-xl border border-[#dfd9f3] bg-white p-3.5" aria-live="polite"><div className="text-[9px] font-bold uppercase tracking-wider text-[#7466b7]">{answer.citations.length ? 'Answer grounded in your materials' : 'Material check'}</div><p className="mt-2 whitespace-pre-wrap text-[11px] leading-6 text-[#5d596f]">{answer.answer}</p>{answer.insufficientMaterial && <p className="mt-2 rounded-lg bg-[#fff8e8] px-2.5 py-2 text-[9px] leading-4 text-[#80652d]">The library did not provide enough source evidence for a fully grounded answer.</p>}{answer.citations.length > 0 && <div className="mt-3 space-y-1.5"><div className="text-[9px] font-bold text-[#6a657b]">Sources</div>{answer.citations.map((citation, index) => <button type="button" key={`${citation.documentId}-${index}`} onClick={() => void showDocument(citation)} className="block w-full rounded-lg bg-[#f8f6ff] px-2.5 py-2 text-left text-[9px] text-[#625a86] hover:bg-[#f0edff]"><span className="font-bold underline decoration-[#b9afe3] underline-offset-2">{citation.title}</span>{citation.pageNumber ? ` · page ${citation.pageNumber}` : citation.section ? ` · ${citation.section}` : ''}<span className="mt-1 block text-[#77718e]">“{citation.quote}”</span></button>)}</div>}{answer.citations.length > 0 && onUseRetrievedMaterial && <button type="button" onClick={() => void useRetrievedMaterial()} disabled={contextBusy || busy} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-[#ded8f5] px-3 py-2 text-[10px] font-bold text-[#6655c6] disabled:opacity-45">{contextBusy && <LoaderCircle size={12} className="animate-spin" />}Use matching passages in Practice and Flashcards</button>}</article>}
    </>}
    {status && <p role="status" className="mt-2 text-[10px] text-[#6b638c]">{status}</p>}
    {error && <p role="alert" className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] leading-5 text-rose-700">{error}</p>}
  </section>;
}
