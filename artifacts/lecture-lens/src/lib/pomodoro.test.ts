import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeTimerIfExpired,
  createInitialTimerState,
  durationIsValid,
  loadTimerState,
  pauseTimer,
  resetTimer,
  selectTimerMode,
  skipTimer,
  startTimer,
  timerRemaining,
  updateTimerDuration,
} from './pomodoro';

test('Pomodoro defaults, validation, and corrupted storage', () => {
  const initial = loadTimerState(null, 1000);
  assert.deepEqual(initial.durations, { focus: 25, shortBreak: 5, longBreak: 15 });
  assert.equal(initial.remainingMs, 25 * 60_000);
  assert.deepEqual(loadTimerState('{bad json', 1000), createInitialTimerState());
  assert.deepEqual(loadTimerState(JSON.stringify({ durations: { focus: 0, shortBreak: 5, longBreak: 15 } }), 1000), createInitialTimerState());
  for (const valid of [1, 180]) assert.equal(durationIsValid(valid), true);
  for (const invalid of [0, 181, 1.5, NaN, '5', null]) assert.equal(durationIsValid(invalid), false);
});

test('timestamp transitions start, pause, resume, reset, and switch session modes', () => {
  let state = startTimer(createInitialTimerState(), 10_000);
  assert.equal(timerRemaining(state, 11_500), 25 * 60_000 - 1500);
  state = pauseTimer(state, 11_500);
  assert.equal(state.remainingMs, 25 * 60_000 - 1500);
  state = startTimer(state, 20_000);
  assert.equal(timerRemaining(state, 21_000), 25 * 60_000 - 2500);
  state = resetTimer(state, 21_000);
  assert.equal(state.remainingMs, 25 * 60_000);
  state = selectTimerMode(state, 'shortBreak');
  assert.equal(state.remainingMs, 5 * 60_000);
  state = selectTimerMode(state, 'longBreak');
  assert.equal(state.remainingMs, 15 * 60_000);
});

test('duration edits validate and running sessions retain their captured length', () => {
  const initial = createInitialTimerState();
  assert.equal(updateTimerDuration(initial, 'focus', 0), initial);
  assert.equal(updateTimerDuration(initial, 'focus', 2.5), initial);
  const adjusted = updateTimerDuration(initial, 'focus', 30);
  assert.equal(adjusted.durations.focus, 30);
  assert.equal(adjusted.remainingMs, 30 * 60_000);
  const running = startTimer(initial, 1000);
  const nextDuration = updateTimerDuration(running, 'focus', 40);
  assert.equal(nextDuration.running, true);
  assert.equal(nextDuration.endAt, running.endAt);
  assert.equal(nextDuration.sessionDurationMs, 25 * 60_000);
  assert.equal(nextDuration.durations.focus, 40);
});

test('skip never counts an unfinished focus session; completion counts only once', () => {
  const skipped = skipTimer(createInitialTimerState(), 1000);
  assert.equal(skipped.mode, 'shortBreak');
  assert.equal(skipped.completedFocusSessions, 0);
  const running = startTimer(createInitialTimerState(), 1000);
  const completed = completeTimerIfExpired(running, 25 * 60_000 + 1000);
  assert.equal(completed.mode, 'shortBreak');
  assert.equal(completed.completedFocusSessions, 1);
  assert.equal(completeTimerIfExpired(completed, 30 * 60_000), completed);
  const deadline = 25 * 60_000 + 1000;
  const expiredFocus = startTimer(createInitialTimerState(), 1000);
  assert.equal(pauseTimer(expiredFocus, deadline).completedFocusSessions, 1);
  assert.equal(skipTimer(expiredFocus, deadline).completedFocusSessions, 1);
  assert.equal(resetTimer(expiredFocus, deadline).completedFocusSessions, 1);
});

test('break completion does not increment focus count and cycle selects a long break', () => {
  let state = { ...createInitialTimerState(), completedFocusSessions: 3, focusSessionsInCycle: 3 };
  state = completeTimerIfExpired(startTimer(state, 1000), 25 * 60_000 + 1000);
  assert.equal(state.mode, 'longBreak');
  assert.equal(state.completedFocusSessions, 4);
  state = completeTimerIfExpired(startTimer(state, 50_000), 15 * 60_000 + 50_000);
  assert.equal(state.mode, 'focus');
  assert.equal(state.completedFocusSessions, 4);
  assert.equal(state.focusSessionsInCycle, 0);
});

test('auto-start, persisted preferences, delayed ticks, and expired restore use end timestamps', () => {
  const initial = { ...createInitialTimerState(), autoStart: true };
  const running = startTimer(initial, 1000);
  const expired = completeTimerIfExpired(running, 25 * 60_000 + 10_000);
  assert.equal(expired.mode, 'shortBreak');
  assert.equal(expired.running, true);
  assert.equal(expired.endAt, 25 * 60_000 + 10_000 + 5 * 60_000);
  const restored = loadTimerState(JSON.stringify(running), 2 * 60_000);
  assert.equal(restored.running, true);
  assert.equal(timerRemaining(restored, 2 * 60_000), 23 * 60_000 + 1000);
  const overdue = completeTimerIfExpired(restored, 30 * 60_000);
  assert.equal(overdue.completedFocusSessions, 1);
  assert.equal(overdue.running, true);
  assert.equal(overdue.mode, 'shortBreak');
  const previouslyCompleted = loadTimerState(JSON.stringify({ ...expired, completionId: 'already-announced' }), 40 * 60_000);
  assert.equal(previouslyCompleted.completionId, null);
  assert.equal(previouslyCompleted.focusSessionsInCycle, 1);
});

test('persisted fourth focus completion remains visible until the long break ends', () => {
  const focus = { ...createInitialTimerState(), completedFocusSessions: 3, focusSessionsInCycle: 3 };
  const afterFocus = completeTimerIfExpired(startTimer(focus, 1000), 25 * 60_000 + 1000);
  assert.equal(afterFocus.focusSessionsInCycle, 4);
  const restored = loadTimerState(JSON.stringify(afterFocus), 30 * 60_000);
  assert.equal(restored.focusSessionsInCycle, 4);
  const afterBreak = completeTimerIfExpired(startTimer(restored, 35 * 60_000), 50 * 60_000);
  assert.equal(afterBreak.focusSessionsInCycle, 0);
});
