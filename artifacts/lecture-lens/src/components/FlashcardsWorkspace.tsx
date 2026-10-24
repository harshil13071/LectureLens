import { useEffect, useMemo, useState } from 'react';
import { useGenerateFlashcards, type FlashcardDeck as GeneratedDeck, type FlashcardsInput } from '@workspace/api-client-react';
import { ArrowLeft, ArrowRight, BookOpen, Check, Clock3, Edit3, Layers3, LoaderCircle, Plus, RotateCcw, Search, Shuffle, Sparkles, Trash2, X } from 'lucide-react';
import {
  createStoredDeck,
  deleteFlashcardDeck,
  FLASHCARD_STORAGE_KEY,
  loadFlashcardDecks,
  MAX_FLASHCARDS,
  MAX_SAVED_DECKS,
  MIN_FLASHCARDS,
  rateFlashcard,
  renameFlashcardDeck,
  saveFlashcardDecks,
  shuffleCards,
  upsertFlashcardDeck,
  type RecallRating,
  type StorageLike,
  type StoredFlashcardDeck,
} from '@/lib/flashcards';

type SourceMode = 'workspace' | 'paste' | 'notes' | 'topic';
type DeckFilter = 'all' | 'due' | 'needs-review';

interface FlashcardsWorkspaceProps {
  workspaceMaterial: string;
  workspaceTitle: string;
  savedNotesText: string;
  onNavigateWorkspace: () => void;
}

const storage = (): StorageLike | null => {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
};

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'data' in error) {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') return data.error;
  }
  return error instanceof Error ? error.message : 'Flashcards could not be generated. Please try again.';
}

function freshId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `deck-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getSourceLabel(source: SourceMode) {
  return ({ workspace: 'Workspace material', paste: 'Pasted content', notes: 'Saved notes', topic: 'Topic' } as const)[source];
}

export function FlashcardsWorkspace({ workspaceMaterial, workspaceTitle, savedNotesText, onNavigateWorkspace }: FlashcardsWorkspaceProps) {
  const generation = useGenerateFlashcards();
  const [source, setSource] = useState<SourceMode>('workspace');
  const [pastedSource, setPastedSource] = useState('');
  const [topic, setTopic] = useState('');
  const [deckTitle, setDeckTitle] = useState('');
  const [activeTitleDraft, setActiveTitleDraft] = useState('');
  const [cardCount, setCardCount] = useState('20');
  const [customCount, setCustomCount] = useState('');
  const [difficulty, setDifficulty] = useState<FlashcardsInput['difficulty']>('medium');
  const [savedDecks, setSavedDecks] = useState<StoredFlashcardDeck[]>(() => {
    const browserStorage = storage();
    return browserStorage ? loadFlashcardDecks(browserStorage) : [];
  });
  const [activeDeck, setActiveDeck] = useState<StoredFlashcardDeck | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [error, setError] = useState('');
  const [storageNotice, setStorageNotice] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<DeckFilter>('all');
  const [showLibrary, setShowLibrary] = useState(true);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [editFront, setEditFront] = useState('');
  const [editBack, setEditBack] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const browserStorage = storage();
    if (browserStorage && !saveFlashcardDecks(browserStorage, savedDecks)) {
      setStorageNotice('Browser storage is unavailable or full. Keep a copy of important decks elsewhere.');
    } else if (browserStorage) {
      setStorageNotice('');
    }
  }, [savedDecks]);

  useEffect(() => {
    if (!activeDeck) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName))) return;
      if (event.code === 'Space') { event.preventDefault(); setIsFlipped((value) => !value); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); moveCard(1); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); moveCard(-1); }
      else if (isFlipped && ['1', '2', '3', '4'].includes(event.key)) rateCurrent((['again', 'hard', 'good', 'easy'] as RecallRating[])[Number(event.key) - 1]);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeDeck, activeIndex, isFlipped]);

  const sourceText = source === 'workspace' ? workspaceMaterial.trim() : source === 'paste' ? pastedSource.trim() : source === 'notes' ? savedNotesText.trim() : '';
  const count = cardCount === 'custom' ? Number(customCount) : Number(cardCount);
  const countValid = Number.isInteger(count) && count >= MIN_FLASHCARDS && count <= MAX_FLASHCARDS;
  const sourceValid = source === 'topic' ? topic.trim().length >= 2 : sourceText.length > 0;
  const activeCard = activeDeck?.cards[activeIndex];
  const isSavedDeck = Boolean(activeDeck && savedDecks.some((deck) => deck.id === activeDeck.id));
  const reviewTotals = useMemo(() => activeDeck?.cards.reduce((totals, card) => {
    totals.studied += card.reviewedAt ? 1 : 0;
    totals.confident += card.ratingCounts.good + card.ratingCounts.easy;
    totals.revision += card.ratingCounts.again + card.ratingCounts.hard;
    return totals;
  }, { studied: 0, confident: 0, revision: 0 }) ?? { studied: 0, confident: 0, revision: 0 }, [activeDeck]);
  const visibleDecks = useMemo(() => savedDecks.filter((deck) => {
    const query = search.trim().toLowerCase();
    const matchesQuery = !query || deck.title.toLowerCase().includes(query) || deck.cards.some((card) => card.front.toLowerCase().includes(query));
    const matchesFilter = filter === 'all'
      || (filter === 'due' && deck.cards.some((card) => card.dueAt <= now))
      || (filter === 'needs-review' && deck.cards.some((card) => card.ratingCounts.again + card.ratingCounts.hard > card.ratingCounts.good + card.ratingCounts.easy));
    return matchesQuery && matchesFilter;
  }).sort((left, right) => right.updatedAt - left.updatedAt), [savedDecks, search, filter, now]);

  function updateActiveDeck(updater: (deck: StoredFlashcardDeck) => StoredFlashcardDeck) {
    if (!activeDeck) return;
    const next = updater(activeDeck);
    setActiveDeck(next);
    if (savedDecks.some((deck) => deck.id === next.id)) setSavedDecks((decks) => renameFlashcardDeck(decks, next.id, next.title, next.updatedAt).map((deck) => deck.id === next.id ? next : deck));
  }

  function moveCard(delta: number) {
    if (!activeDeck) return;
    const next = (activeIndex + delta + activeDeck.cards.length) % activeDeck.cards.length;
    updateActiveDeck((deck) => ({ ...deck, currentIndex: next, updatedAt: Date.now() }));
    setActiveIndex(next);
    setIsFlipped(false);
  }

  function rateCurrent(rating: RecallRating) {
    if (!activeDeck) return;
    const updated = rateFlashcard(activeDeck, activeIndex, rating);
    const nextIndex = activeIndex < updated.cards.length - 1 ? activeIndex + 1 : 0;
    updated.currentIndex = nextIndex;
    setActiveDeck(updated);
    if (savedDecks.some((deck) => deck.id === updated.id)) setSavedDecks((decks) => decks.map((deck) => deck.id === updated.id ? updated : deck));
    setActiveIndex(nextIndex);
    setIsFlipped(false);
    setNow(Date.now());
  }

  async function generateDeck(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (!countValid) { setError(`Choose a whole number from ${MIN_FLASHCARDS} to ${MAX_FLASHCARDS}.`); return; }
    if (!sourceValid) {
      setError(source === 'workspace' ? 'Add or upload study material in Workspace first.' : source === 'notes' ? 'Generate study notes or save research to Notes first.' : source === 'topic' ? 'Enter a topic with at least two characters.' : 'Paste some study material first.');
      return;
    }
    const payload: FlashcardsInput = {
      title: deckTitle.trim() || workspaceTitle.trim() || undefined,
      ...(sourceText ? { sourceText: sourceText.slice(0, 40000) } : {}),
      ...(source === 'topic' ? { topic: topic.trim() } : {}),
      cardCount: count,
      difficulty,
    };
    try {
      const result = await generation.mutateAsync({ data: payload });
      const title = deckTitle.trim() || result.title;
      const deck = createStoredDeck(title, result.cards, Date.now(), freshId());
      setActiveDeck(deck);
      setActiveTitleDraft(title);
      setActiveIndex(0);
      setIsFlipped(false);
      setShowLibrary(false);
    } catch (cause) {
      setError(getErrorMessage(cause));
    }
  }

  function saveDeck() {
    if (!activeDeck || activeDeck.cards.length < MIN_FLASHCARDS) return;
    if (!isSavedDeck && savedDecks.length >= MAX_SAVED_DECKS) {
      setError(`You can save up to ${MAX_SAVED_DECKS} decks in this browser. Delete an old deck first.`);
      return;
    }
    const title = activeTitleDraft.trim().slice(0, 160) || activeDeck.title;
    const updated = { ...activeDeck, title, updatedAt: Date.now() };
    setActiveDeck(updated);
    setActiveTitleDraft(title);
    setSavedDecks((decks) => upsertFlashcardDeck(decks, updated));
    setError('');
    setStorageNotice('Deck saved in this browser.');
  }

  function openDeck(deck: StoredFlashcardDeck) {
    setActiveDeck(deck);
    setActiveTitleDraft(deck.title);
    setActiveIndex(Math.min(deck.currentIndex, deck.cards.length - 1));
    setIsFlipped(false);
    setEditingCardId(null);
    setShowLibrary(false);
    setError('');
  }

  function renameDeck() {
    if (!activeDeck || !activeTitleDraft.trim()) { setActiveTitleDraft(activeDeck?.title ?? ''); return; }
    const title = activeTitleDraft.trim().slice(0, 160);
    const updated = { ...activeDeck, title, updatedAt: Date.now() };
    setActiveDeck(updated);
    if (savedDecks.some((deck) => deck.id === updated.id)) setSavedDecks((decks) => renameFlashcardDeck(decks, updated.id, title, updated.updatedAt));
    setActiveTitleDraft(title);
  }

  function startEditCard(card: StoredFlashcardDeck['cards'][number]) {
    setEditingCardId(card.id);
    setEditFront(card.front);
    setEditBack(card.back);
  }

  function saveCardEdit() {
    if (!activeDeck || !editingCardId || !editFront.trim() || !editBack.trim()) return;
    updateActiveDeck((deck) => ({ ...deck, updatedAt: Date.now(), cards: deck.cards.map((card) => card.id === editingCardId ? { ...card, front: editFront.trim().slice(0, 500), back: editBack.trim().slice(0, 1000) } : card) }));
    setEditingCardId(null);
  }

  function addCard() {
    if (!activeDeck || activeDeck.cards.length >= MAX_FLASHCARDS) return;
    const id = `${activeDeck.id}-card-${Date.now()}`;
    updateActiveDeck((deck) => ({ ...deck, updatedAt: Date.now(), cards: [...deck.cards, { id, front: 'New question', back: 'Add an answer', repetitions: 0, intervalDays: 0, dueAt: Date.now(), ratingCounts: { again: 0, hard: 0, good: 0, easy: 0 } }] }));
    const index = activeDeck.cards.length;
    setActiveIndex(index);
    setIsFlipped(false);
  }

  function removeCard(cardId: string) {
    if (!activeDeck || activeDeck.cards.length <= MIN_FLASHCARDS) return;
    const nextCards = activeDeck.cards.filter((card) => card.id !== cardId);
    const nextIndex = Math.min(activeIndex, nextCards.length - 1);
    updateActiveDeck((deck) => ({ ...deck, cards: nextCards, currentIndex: nextIndex, updatedAt: Date.now() }));
    setActiveIndex(nextIndex);
    setIsFlipped(false);
    setEditingCardId(null);
  }

  function shuffleDeck() {
    if (!activeDeck) return;
    updateActiveDeck((deck) => ({ ...deck, cards: shuffleCards(deck.cards), currentIndex: 0, updatedAt: Date.now() }));
    setActiveIndex(0);
    setIsFlipped(false);
  }

  function restartDeck() {
    if (!activeDeck) return;
    updateActiveDeck((deck) => ({ ...deck, currentIndex: 0, updatedAt: Date.now() }));
    setActiveIndex(0);
    setIsFlipped(false);
  }

  return <section id="flashcards" className="flashcards-workspace scroll-mt-24 space-y-5" aria-labelledby="flashcards-heading">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="flash-eyebrow">ACTIVE RECALL</p><h2 id="flashcards-heading" className="font-display text-[26px] font-bold tracking-[-.04em] sm:text-[32px]">AI Flashcards</h2><p className="mt-1 max-w-2xl text-[13px] text-[var(--app-text-muted)]">Build a focused deck from your material, then review it at your own pace.</p></div>
      {activeDeck && <div className="flex gap-2"><button type="button" onClick={() => { setActiveDeck(null); setShowLibrary(true); setEditingCardId(null); }} className="flash-secondary-button"><Layers3 size={15} />Deck library</button><button type="button" onClick={saveDeck} className="flash-primary-button"><Check size={15} />{isSavedDeck ? 'Save changes' : 'Save deck'}</button></div>}
    </div>

    {!activeDeck && <form onSubmit={generateDeck} className="flash-panel grid gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,.85fr)]">
      <div className="space-y-4">
        <div><label className="flash-label" htmlFor="flashcard-source">Create from</label><select id="flashcard-source" className="flash-input mt-1.5" value={source} onChange={(event) => setSource(event.target.value as SourceMode)}><option value="workspace">Current Workspace material</option><option value="paste">Paste notes or textbook content</option>{savedNotesText.trim() && <option value="notes">Current saved notes</option>}<option value="topic">A topic or chapter</option></select></div>
        {source === 'paste' && <div><label className="flash-label" htmlFor="flashcard-paste">Paste lecture notes or textbook content</label><textarea id="flashcard-paste" maxLength={40000} value={pastedSource} onChange={(event) => setPastedSource(event.target.value)} placeholder="Paste material to turn into flashcards…" className="flash-input mt-1.5 min-h-40 resize-y leading-6" /><p className="mt-1 text-right text-[10px] text-[var(--app-text-muted)]">{pastedSource.length.toLocaleString()} / 40,000</p></div>}
        {source === 'topic' && <div><label className="flash-label" htmlFor="flashcard-topic">Topic, subject, or chapter</label><input id="flashcard-topic" maxLength={160} value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="e.g. Working memory, Chapter 5" className="flash-input mt-1.5" /></div>}
        {source === 'workspace' && <div className="flash-source-preview">{sourceText ? <><span className="flash-source-ready"><Check size={14} />Workspace material ready</span><span className="mt-1 block">{workspaceTitle || 'Current study material'} · {sourceText.length.toLocaleString()} characters</span></> : <><span className="flash-source-ready"><BookOpen size={14} />No active study material yet</span><span className="mt-1 block">Paste notes or upload a PDF in Workspace to use it here.</span><button type="button" className="mt-2 text-[12px] font-semibold text-[var(--app-accent-text)] underline" onClick={onNavigateWorkspace}>Go to Workspace</button></>}</div>}
        {source === 'notes' && <div className="flash-source-preview">{sourceText ? `Current Notes and saved research · ${sourceText.length.toLocaleString()} characters` : 'Create Notes or save research to Notes first.'}</div>}
        {(source === 'paste' || source === 'notes') && <p className="text-[11px] text-[var(--app-text-muted)]">{sourceText.length.toLocaleString()} / 40,000 characters</p>}
      </div>
      <div className="space-y-4">
        <div><label className="flash-label" htmlFor="flashcard-deck-title">Deck title <span className="font-normal text-[var(--app-text-muted)]">· optional</span></label><input id="flashcard-deck-title" maxLength={160} value={deckTitle} onChange={(event) => setDeckTitle(event.target.value)} placeholder={topic.trim() || workspaceTitle || 'e.g. Cell biology — key terms'} className="flash-input mt-1.5" /></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flash-label">Number of cards<select className="flash-input mt-1.5" value={cardCount} onChange={(event) => setCardCount(event.target.value)}><option value="5">5 cards</option><option value="10">10 cards</option><option value="15">15 cards</option><option value="20">20 cards</option><option value="30">30 cards</option><option value="custom">Custom</option></select></label>
          <label className="flash-label">Difficulty<select className="flash-input mt-1.5" value={difficulty} onChange={(event) => setDifficulty(event.target.value as FlashcardsInput['difficulty'])}><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></label>
        </div>
        {cardCount === 'custom' && <div><label className="flash-label" htmlFor="flashcard-custom-count">Custom cards ({MIN_FLASHCARDS}–{MAX_FLASHCARDS})</label><input id="flashcard-custom-count" type="number" min={MIN_FLASHCARDS} max={MAX_FLASHCARDS} step="1" value={customCount} onChange={(event) => setCustomCount(event.target.value)} className="flash-input mt-1.5" placeholder="Enter a whole number" /></div>}
        <button type="submit" disabled={generation.isPending || !countValid || !sourceValid} className="flash-primary-button min-h-12 w-full justify-center text-[13px] disabled:cursor-not-allowed disabled:opacity-50">{generation.isPending ? <LoaderCircle size={16} className="animate-spin" /> : <Sparkles size={16} />}{generation.isPending ? 'Generating your deck…' : 'Generate Flashcards'}</button>
        <p className="text-[10px] leading-4 text-[var(--app-text-muted)]">Uses the current workspace text when selected. Uploaded documents stay in the existing in-memory extraction flow.</p>
      </div>
    </form>}

    {error && <div className="flash-error" role="alert">{error}</div>}
    {storageNotice && <p role="status" className="text-[11px] text-[var(--app-text-muted)]">{storageNotice}</p>}

    {activeDeck && activeCard && <div className="space-y-4">
      <div className="flash-panel flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0 flex-1"><label className="sr-only" htmlFor="flashcard-active-title">Deck title</label><input id="flashcard-active-title" value={activeTitleDraft} maxLength={160} onChange={(event) => setActiveTitleDraft(event.target.value)} onBlur={renameDeck} className="flash-title-input" /><p className="mt-1 text-[11px] text-[var(--app-text-muted)]">{getSourceLabel(source)}{isSavedDeck ? ' · saved deck' : ' · unsaved deck'}</p></div>
        <div className="flex flex-wrap gap-2"><button type="button" onClick={shuffleDeck} className="flash-secondary-button"><Shuffle size={14} />Shuffle</button><button type="button" onClick={restartDeck} className="flash-secondary-button"><RotateCcw size={14} />Restart</button></div>
      </div>
      <div className="flash-study-panel p-4 sm:p-7">
        <div className="mb-5 flex items-center justify-between gap-3"><span className="text-[12px] font-semibold text-[var(--app-text-muted)]">Card {activeIndex + 1} of {activeDeck.cards.length}</span><span className="text-[11px] text-[var(--app-text-muted)]">Space flips · ← → navigate · 1–4 rate</span></div>
        <div className="flash-progress-track" role="progressbar" aria-label="Deck study progress" aria-valuemin={0} aria-valuemax={activeDeck.cards.length} aria-valuenow={activeIndex + 1}><span style={{ width: `${((activeIndex + 1) / activeDeck.cards.length) * 100}%` }} /></div>
        <button type="button" onClick={() => setIsFlipped((value) => !value)} aria-label={isFlipped ? 'Show flashcard question' : 'Reveal flashcard answer'} aria-pressed={isFlipped} className={`flash-card ${isFlipped ? 'is-flipped' : ''}`}>
          <span className="flash-card-face"><span className="flash-eyebrow">QUESTION</span><span className="flash-card-copy">{activeCard.front}</span><span className="flash-card-hint">Click or press Space to reveal</span></span>
          <span className="flash-card-face flash-card-back"><span className="flash-eyebrow">ANSWER</span><span className="flash-card-copy">{activeCard.back}</span><span className="flash-card-hint">Rate how well you recalled it</span></span>
        </button>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <button type="button" onClick={() => moveCard(-1)} className="flash-secondary-button"><ArrowLeft size={15} />Previous</button>
          {isFlipped ? <div className="flex flex-wrap justify-center gap-2">{(['again', 'hard', 'good', 'easy'] as RecallRating[]).map((rating) => <button key={rating} type="button" onClick={() => rateCurrent(rating)} className={`flash-rating-button rating-${rating}`}>{rating[0].toUpperCase() + rating.slice(1)} <span className="hidden sm:inline">· {({ again: '10m', hard: '12h', good: '1d', easy: '4d' } as const)[rating]}</span></button>)}</div> : <span className="text-[11px] text-[var(--app-text-muted)]">Reveal the answer before rating recall.</span>}
          <button type="button" onClick={() => moveCard(1)} className="flash-secondary-button">Next<ArrowRight size={15} /></button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3"><div className="flash-stat"><span>Cards studied</span><strong>{reviewTotals.studied} / {activeDeck.cards.length}</strong></div><div className="flash-stat"><span>Confident recalls</span><strong>{reviewTotals.confident}</strong></div><div className="flash-stat"><span>Needs more review</span><strong>{reviewTotals.revision}</strong></div></div>
      <div className="flash-panel p-4"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-display text-[16px] font-bold">Edit this deck</h3><button type="button" onClick={addCard} disabled={activeDeck.cards.length >= MAX_FLASHCARDS} className="flash-secondary-button"><Plus size={14} />Add card</button></div><div className="mt-3 grid gap-2">{activeDeck.cards.map((card, index) => <article key={card.id} className="flash-card-row"><div className="min-w-0 flex-1"><p className="text-[10px] font-bold uppercase text-[var(--app-text-muted)]">{String(index + 1).padStart(2, '0')}</p>{editingCardId === card.id ? <div className="mt-2 grid gap-2"><textarea value={editFront} maxLength={500} onChange={(event) => setEditFront(event.target.value)} aria-label="Edit flashcard question" className="flash-input min-h-16" /><textarea value={editBack} maxLength={1000} onChange={(event) => setEditBack(event.target.value)} aria-label="Edit flashcard answer" className="flash-input min-h-20" /><div className="flex gap-2"><button type="button" onClick={saveCardEdit} disabled={!editFront.trim() || !editBack.trim()} className="flash-primary-button"><Check size={13} />Save</button><button type="button" onClick={() => setEditingCardId(null)} className="flash-secondary-button"><X size={13} />Cancel</button></div></div> : <><p className="mt-1 text-[13px] font-semibold">{card.front}</p><p className="mt-1 text-[12px] text-[var(--app-text-muted)]">{card.back}</p></>}</div>{editingCardId !== card.id && <div className="flex shrink-0 items-start gap-1"><button type="button" onClick={() => startEditCard(card)} aria-label={`Edit card ${index + 1}`} className="flash-icon-button"><Edit3 size={14} /></button><button type="button" onClick={() => removeCard(card.id)} disabled={activeDeck.cards.length <= MIN_FLASHCARDS} aria-label={`Remove card ${index + 1}`} className="flash-icon-button"><Trash2 size={14} /></button></div>}</article>)}</div></div>
    </div>}

    {showLibrary && !activeDeck && <div className="flash-panel p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-display text-[17px] font-bold">Your decks</h3><p className="mt-1 text-[11px] text-[var(--app-text-muted)]">Saved privately in this browser · {savedDecks.length} / {MAX_SAVED_DECKS}</p></div><button type="button" onClick={() => setShowLibrary(false)} className="flash-secondary-button"><X size={14} />Hide library</button></div>
      <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px]"><label className="relative"><span className="sr-only">Search saved decks</span><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--app-text-muted)]" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search decks or questions" className="flash-input pl-9" /></label><label className="sr-only" htmlFor="flashcard-deck-filter">Filter decks</label><select id="flashcard-deck-filter" value={filter} onChange={(event) => setFilter(event.target.value as DeckFilter)} className="flash-input"><option value="all">All decks</option><option value="due">Due for review</option><option value="needs-review">Needs more review</option></select></div>
      {visibleDecks.length ? <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{visibleDecks.map((deck) => {
        const due = deck.cards.filter((card) => card.dueAt <= now).length;
        return <article key={deck.id} className="flash-deck-tile"><button type="button" onClick={() => openDeck(deck)} className="min-w-0 flex-1 text-left"><p className="font-display text-[15px] font-bold">{deck.title}</p><p className="mt-1 text-[11px] text-[var(--app-text-muted)]">{deck.cards.length} cards · {due} due · reviewed {new Date(deck.updatedAt).toLocaleDateString()}</p><span className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--app-accent-text)]">Resume study <ArrowRight size={13} /></span></button><div className="flex flex-col gap-1"><button type="button" onClick={() => openDeck(deck)} aria-label={`Rename ${deck.title}`} className="flash-icon-button"><Edit3 size={14} /></button>{confirmDeleteId === deck.id ? <button type="button" onClick={() => { setSavedDecks((decks) => deleteFlashcardDeck(decks, deck.id)); setConfirmDeleteId(null); }} className="text-[10px] font-bold text-red-300">Confirm</button> : <button type="button" onClick={() => setConfirmDeleteId(deck.id)} aria-label={`Delete ${deck.title}`} className="flash-icon-button"><Trash2 size={14} /></button>}</div></article>;
      })}</div> : <div className="flash-empty mt-4"><Layers3 size={22} /><p className="mt-2 font-semibold">{savedDecks.length ? 'No decks match this search.' : 'Your saved decks will appear here.'}</p><p className="mt-1 text-[11px]">Generate a deck, then save it to review again later.</p></div>}
    </div>}
    {generation.isPending && <div role="status" className="flash-panel flex items-center gap-3 p-4 text-[12px] text-[var(--app-text-muted)]"><LoaderCircle size={16} className="animate-spin" />Creating grounded questions and concise answers…</div>}
  </section>;
}
