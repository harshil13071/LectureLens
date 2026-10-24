import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FLASHCARD_STORAGE_KEY,
  createStoredDeck,
  deleteFlashcardDeck,
  loadFlashcardDecks,
  parseFlashcardDecks,
  rateFlashcard,
  renameFlashcardDeck,
  saveFlashcardDecks,
  shuffleCards,
  upsertFlashcardDeck,
  type StorageLike,
} from './flashcards';

function makeDeck() {
  return createStoredDeck('Memory Systems', Array.from({ length: 5 }, (_, index) => ({
    front: `Question ${index + 1}`,
    back: `Answer ${index + 1}`,
  })), 1_000, 'memory');
}

test('flashcard deck serialization restores saved decks and ignores invalid or corrupt data', () => {
  let stored: string | null = null;
  const storage: StorageLike = {
    getItem: (key) => key === FLASHCARD_STORAGE_KEY ? stored : null,
    setItem: (_key, value) => { stored = value; },
  };
  const deck = makeDeck();
  assert.equal(saveFlashcardDecks(storage, [deck]), true);
  assert.deepEqual(loadFlashcardDecks(storage), [deck]);
  assert.deepEqual(parseFlashcardDecks({ unexpected: true }), []);
  stored = '{invalid json';
  assert.deepEqual(loadFlashcardDecks(storage), []);
  assert.equal(saveFlashcardDecks({ getItem: () => null, setItem: () => { throw new Error('quota'); } }, [deck]), false);
});

test('flashcard validation drops incomplete decks and malformed cards', () => {
  const deck = makeDeck();
  assert.deepEqual(parseFlashcardDecks([{ ...deck, cards: deck.cards.slice(0, 4) }]), []);
  assert.deepEqual(parseFlashcardDecks([{ ...deck, cards: [{ ...deck.cards[0], front: ' ' }, ...deck.cards.slice(1)] }]), []);
});

test('recall ratings track confidence and schedule difficult cards sooner', () => {
  const deck = makeDeck();
  const again = rateFlashcard(deck, 0, 'again', 10_000);
  const hard = rateFlashcard(deck, 1, 'hard', 10_000);
  const good = rateFlashcard(deck, 2, 'good', 10_000);
  const easy = rateFlashcard(deck, 3, 'easy', 10_000);
  assert.equal(again.cards[0].ratingCounts.again, 1);
  assert.equal(again.cards[0].repetitions, 0);
  assert.ok(again.cards[0].dueAt - 10_000 < 11 * 60_000);
  assert.equal(hard.cards[1].intervalDays, 0.5);
  assert.equal(good.cards[2].intervalDays, 1);
  assert.equal(easy.cards[3].intervalDays, 4);
  assert.ok(again.cards[0].dueAt < easy.cards[3].dueAt);
});

test('shuffle returns all cards without changing the saved ordering', () => {
  const cards = [1, 2, 3, 4, 5];
  const shuffled = shuffleCards(cards, () => 0);
  assert.deepEqual(cards, [1, 2, 3, 4, 5]);
  assert.deepEqual([...shuffled].sort(), cards);
  assert.notDeepEqual(shuffled, cards);
});

test('generated deck can be saved, reopened, renamed, and deleted without losing study progress', () => {
  let stored: string | null = null;
  const storage: StorageLike = {
    getItem: () => stored,
    setItem: (_key, value) => { stored = value; },
  };
  const generated = createStoredDeck('Virtual Memory', Array.from({ length: 5 }, (_, index) => ({
    front: `Generated question ${index + 1}`,
    back: `Grounded answer ${index + 1}`,
  })), 20_000, 'generated-deck');
  const reviewed = rateFlashcard(generated, 0, 'good', 21_000);
  assert.equal(saveFlashcardDecks(storage, upsertFlashcardDeck([], reviewed)), true);

  const reopened = loadFlashcardDecks(storage);
  assert.equal(reopened[0].title, 'Virtual Memory');
  assert.equal(reopened[0].cards[0].front, 'Generated question 1');
  assert.equal(reopened[0].cards[0].ratingCounts.good, 1);
  const renamed = renameFlashcardDeck(reopened, 'generated-deck', 'Memory Review', 22_000);
  assert.equal(saveFlashcardDecks(storage, renamed), true);
  assert.equal(loadFlashcardDecks(storage)[0].title, 'Memory Review');
  assert.deepEqual(deleteFlashcardDeck(renamed, 'generated-deck'), []);
});
