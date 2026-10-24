export type TimerMode = 'focus' | 'shortBreak' | 'longBreak';

export type PomodoroPreferences = {
  durations: Record<TimerMode, number>;
  autoStart: boolean;
  soundEnabled: boolean;
  notificationsEnabled: boolean;
  completedFocusSessions: number;
  focusSessionsInCycle: number;
  mode: TimerMode;
  running: boolean;
  endAt: number | null;
  remainingMs: number;
  sessionDurationMs: number;
  completionId: string | null;
  notice: string;
};

export const POMODORO_STORAGE_KEY = 'lecturelens-pomodoro-v1';
export const DEFAULT_DURATIONS: Record<TimerMode, number> = {
  focus: 25,
  shortBreak: 5,
  longBreak: 15,
};

export function durationIsValid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 180;
}

export function createInitialTimerState(): PomodoroPreferences {
  return {
    durations: { ...DEFAULT_DURATIONS },
    autoStart: false,
    soundEnabled: false,
    notificationsEnabled: false,
    completedFocusSessions: 0,
    focusSessionsInCycle: 0,
    mode: 'focus',
    running: false,
    endAt: null,
    remainingMs: DEFAULT_DURATIONS.focus * 60_000,
    sessionDurationMs: DEFAULT_DURATIONS.focus * 60_000,
    completionId: null,
    notice: '',
  };
}

function isTimerMode(value: unknown): value is TimerMode {
  return value === 'focus' || value === 'shortBreak' || value === 'longBreak';
}

export function loadTimerState(serialized: string | null, now = Date.now()): PomodoroPreferences {
  const initial = createInitialTimerState();
  if (!serialized) return initial;
  try {
    const saved: unknown = JSON.parse(serialized);
    if (!saved || typeof saved !== 'object') return initial;
    const value = saved as Partial<PomodoroPreferences>;
    const durations = value.durations;
    if (!durations || !durationIsValid(durations.focus) || !durationIsValid(durations.shortBreak) || !durationIsValid(durations.longBreak)) return initial;
    const mode = isTimerMode(value.mode) ? value.mode : 'focus';
    const sessionDurationMs = Number.isFinite(value.sessionDurationMs) && Number(value.sessionDurationMs) >= 60_000
      ? Math.min(Number(value.sessionDurationMs), 180 * 60_000)
      : durations[mode] * 60_000;
    const running = value.running === true && Number.isFinite(value.endAt);
    const endAt = running ? Number(value.endAt) : null;
    return {
      durations: { ...durations },
      autoStart: value.autoStart === true,
      soundEnabled: value.soundEnabled === true,
      notificationsEnabled: value.notificationsEnabled === true,
      completedFocusSessions: Number.isInteger(value.completedFocusSessions) && Number(value.completedFocusSessions) >= 0 ? Number(value.completedFocusSessions) : 0,
      focusSessionsInCycle: Number.isInteger(value.focusSessionsInCycle) && Number(value.focusSessionsInCycle) >= 0 ? Math.min(Number(value.focusSessionsInCycle), 4) : 0,
      mode,
      running,
      endAt,
      remainingMs: running ? Math.max(0, endAt! - now) : Math.max(0, Math.min(Number(value.remainingMs) || sessionDurationMs, sessionDurationMs)),
      sessionDurationMs,
      // A previously announced completion must not notify again after refresh.
      // An expired running session receives a new completion ID when reconciled.
      completionId: null,
      notice: '',
    };
  } catch {
    return initial;
  }
}

export function timerRemaining(state: PomodoroPreferences, now = Date.now()): number {
  return state.running && state.endAt !== null ? Math.max(0, state.endAt - now) : state.remainingMs;
}

export function startTimer(state: PomodoroPreferences, now = Date.now()): PomodoroPreferences {
  const completed = completeTimerIfExpired(state, now);
  if (completed !== state) return completed;
  if (state.running) return state;
  const remainingMs = Math.max(0, state.remainingMs);
  return { ...state, running: true, endAt: now + remainingMs, remainingMs, notice: '' };
}

export function pauseTimer(state: PomodoroPreferences, now = Date.now()): PomodoroPreferences {
  const completed = completeTimerIfExpired(state, now);
  if (completed !== state) return completed;
  if (!state.running) return state;
  return { ...state, running: false, endAt: null, remainingMs: timerRemaining(state, now), notice: '' };
}

export function resetTimer(state: PomodoroPreferences, now = Date.now()): PomodoroPreferences {
  const completed = completeTimerIfExpired(state, now);
  if (completed !== state) return completed;
  const sessionDurationMs = state.durations[state.mode] * 60_000;
  return { ...state, running: false, endAt: null, sessionDurationMs, remainingMs: sessionDurationMs, notice: '' };
}

export function selectTimerMode(state: PomodoroPreferences, mode: TimerMode, now = Date.now()): PomodoroPreferences {
  const completed = completeTimerIfExpired(state, now);
  if (completed !== state) return completed;
  const sessionDurationMs = state.durations[mode] * 60_000;
  return { ...state, mode, running: false, endAt: null, sessionDurationMs, remainingMs: sessionDurationMs, notice: '' };
}

export function updateTimerDuration(state: PomodoroPreferences, mode: TimerMode, duration: number): PomodoroPreferences {
  if (!durationIsValid(duration)) return state;
  const durations = { ...state.durations, [mode]: duration };
  if (mode !== state.mode || state.running) return { ...state, durations };
  const sessionDurationMs = duration * 60_000;
  return { ...state, durations, sessionDurationMs, remainingMs: sessionDurationMs, endAt: null, notice: '' };
}

export function selectNextSession(state: PomodoroPreferences, now = Date.now(), completed = false): PomodoroPreferences {
  let completedFocusSessions = state.completedFocusSessions;
  let focusSessionsInCycle = state.focusSessionsInCycle;
  let mode: TimerMode;
  let notice = '';
  if (state.mode === 'focus') {
    if (completed) {
      completedFocusSessions += 1;
      focusSessionsInCycle += 1;
    }
    mode = focusSessionsInCycle >= 4 ? 'longBreak' : 'shortBreak';
    notice = completed ? 'Focus session complete. Nice work.' : 'Focus session skipped.';
  } else {
    if (state.mode === 'longBreak' && completed) focusSessionsInCycle = 0;
    mode = 'focus';
    notice = completed ? `${state.mode === 'longBreak' ? 'Long' : 'Short'} break complete.` : 'Break skipped.';
  }
  const sessionDurationMs = state.durations[mode] * 60_000;
  const next: PomodoroPreferences = {
    ...state,
    mode,
    completedFocusSessions,
    focusSessionsInCycle,
    sessionDurationMs,
    remainingMs: sessionDurationMs,
    running: false,
    endAt: null,
    completionId: completed ? `${now}:${state.mode}` : state.completionId,
    notice,
  };
  return state.autoStart ? startTimer(next, now) : next;
}

export function completeTimerIfExpired(state: PomodoroPreferences, now = Date.now()): PomodoroPreferences {
  if (!state.running || state.endAt === null || now < state.endAt) return state;
  return selectNextSession({ ...state, remainingMs: 0, running: false, endAt: null }, now, true);
}

export function skipTimer(state: PomodoroPreferences, now = Date.now()): PomodoroPreferences {
  const completed = completeTimerIfExpired(state, now);
  if (completed !== state) return completed;
  return selectNextSession({ ...state, remainingMs: timerRemaining(state, now), running: false, endAt: null }, now, false);
}
