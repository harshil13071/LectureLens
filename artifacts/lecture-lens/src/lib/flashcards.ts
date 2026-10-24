export const FLASHCARD_STORAGE_KEY = 'lecturelens-flashcards-v1';
export const MAX_SAVED_DECKS = 100;
export const MIN_FLASHCARDS = 5;
export const MAX_FLASHCARDS = 40;

export type RecallRating = 'again' | 'hard' | 'good' | 'easy';

export interface StoredFlashcard {
  id: string;
  front: string;
  back: string;
  repetitions: number;
  intervalDays: number;
  dueAt: number;
  reviewedAt?: number;
  lastRating?: RecallRating;
  ratingCounts: Record<RecallRating, number>;
}

export interface StoredFlashcardDeck {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  cards: StoredFlashcard[];
  currentIndex: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const ratings: RecallRating[] = ['again', 'hard', 'good', 'easy'];
const emptyRatingCounts = (): Record<RecallRating, number> => ({ again: 0, hard: 0, good: 0, easy: 0 });
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const validCount = (value: unknown): number => Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;

function parseCard(value: unknown): StoredFlashcard | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.front !== 'string' || typeof value.back !== 'string') return null;
  const front = value.front.trim();
  const back = value.back.trim();
  if (!front || !back || front.length > 500 || back.length > 1000) return null;
  const rawCounts = isRecord(value.ratingCounts) ? value.ratingCounts : {};
  const ratingCounts = emptyRatingCounts();
  for (const rating of ratings) ratingCounts[rating] = validCount(rawCounts[rating]);
  return {
    id: value.id,
    front,
    back,
    repetitions: validCount(value.repetitions),
    intervalDays: typeof value.intervalDays === 'number' && Number.isFinite(value.intervalDays) && value.intervalDays >= 0 ? value.intervalDays : 0,
    dueAt: typeof value.dueAt === 'number' && Number.isFinite(value.dueAt) ? value.dueAt : Date.now(),
    ...(typeof value.reviewedAt === 'number' && Number.isFinite(value.reviewedAt) ? { reviewedAt: value.reviewedAt } : {}),
    ...(ratings.includes(value.lastRating as RecallRating) ? { lastRating: value.lastRating as RecallRating } : {}),
    ratingCounts,
  };
}

export function parseFlashcardDecks(value: unknown): StoredFlashcardDeck[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_SAVED_DECKS).flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.title !== 'string' || !Array.isArray(entry.cards)) return [];
    const title = entry.title.trim().slice(0, 160);
    const cards = entry.cards.slice(0, MAX_FLASHCARDS).map(parseCard);
    if (!title || cards.length < MIN_FLASHCARDS || cards.some((card) => card === null)) return [];
    const now = Date.now();
    return [{
      id: entry.id,
      title,
      createdAt: typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) ? entry.createdAt : now,
      updatedAt: typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : now,
      cards: cards as StoredFlashcard[],
      currentIndex: Math.min(cards.length - 1, validCount(entry.currentIndex)),
    }];
  });
}

export function loadFlashcardDecks(storage: StorageLike): StoredFlashcardDeck[] {
  try {
    const raw = storage.getItem(FLASHCARD_STORAGE_KEY);
    return raw ? parseFlashcardDecks(JSON.parse(raw) as unknown) : [];
  } catch {
    return [];
  }
}

export function saveFlashcardDecks(storage: StorageLike, decks: StoredFlashcardDeck[]): boolean {
  try {
    storage.setItem(FLASHCARD_STORAGE_KEY, JSON.stringify(parseFlashcardDecks(decks)));
    return true;
  } catch {
    return false;
  }
}

export function upsertFlashcardDeck(decks: StoredFlashcardDeck[], deck: StoredFlashcardDeck): StoredFlashcardDeck[] {
  return [deck, ...decks.filter((item) => item.id !== deck.id)].slice(0, MAX_SAVED_DECKS);
}

export function renameFlashcardDeck(decks: StoredFlashcardDeck[], id: string, title: string, now = Date.now()): StoredFlashcardDeck[] {
  const normalizedTitle = title.trim().slice(0, 160);
  if (!normalizedTitle) return decks;
  return decks.map((deck) => deck.id === id ? { ...deck, title: normalizedTitle, updatedAt: now } : deck);
}

export function deleteFlashcardDeck(decks: StoredFlashcardDeck[], id: string): StoredFlashcardDeck[] {
  return decks.filter((deck) => deck.id !== id);
}

export function createStoredDeck(
  title: string,
  cards: Array<{ front: string; back: string }>,
  now = Date.now(),
  id = `deck-${now}-${Math.random().toString(36).slice(2, 9)}`,
): StoredFlashcardDeck {
  return {
    id,
    title: title.trim().slice(0, 160) || 'Untitled deck',
    createdAt: now,
    updatedAt: now,
    currentIndex: 0,
    cards: cards.map((card, index) => ({
      id: `${id}-card-${index + 1}`,
      front: card.front.trim(),
      back: card.back.trim(),
      repetitions: 0,
      intervalDays: 0,
      dueAt: now,
      ratingCounts: emptyRatingCounts(),
    })),
  };
}

export function rateFlashcard(deck: StoredFlashcardDeck, cardIndex: number, rating: RecallRating, now = Date.now()): StoredFlashcardDeck {
  if (!deck.cards[cardIndex]) return deck;
  const cards = deck.cards.map((card, index) => {
    if (index !== cardIndex) return card;
    let repetitions = card.repetitions;
    let intervalDays = card.intervalDays;
    if (rating === 'again') {
      repetitions = 0;
      intervalDays = 10 / (24 * 60);
    } else if (rating === 'hard') {
      intervalDays = Math.max(1 / 24, card.intervalDays ? card.intervalDays * 1.2 : 0.5);
      repetitions += 1;
    } else if (rating === 'good') {
      intervalDays = card.repetitions === 0 ? 1 : Math.max(1, card.intervalDays * 2);
      repetitions += 1;
    } else {
      intervalDays = card.repetitions === 0 ? 4 : Math.max(4, card.intervalDays * 2.5);
      repetitions += 1;
    }
    return {
      ...card,
      repetitions,
      intervalDays,
      dueAt: now + intervalDays * 24 * 60 * 60 * 1000,
      reviewedAt: now,
      lastRating: rating,
      ratingCounts: { ...card.ratingCounts, [rating]: card.ratingCounts[rating] + 1 },
    };
  });
  return { ...deck, cards, updatedAt: now };
}

export function shuffleCards<T>(items: T[], random: () => number = Math.random): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}
