import { useCallback, useEffect, useRef, useState } from 'react';
import {
  completeTimerIfExpired,
  createInitialTimerState,
  loadTimerState,
  pauseTimer,
  POMODORO_STORAGE_KEY,
  resetTimer,
  selectTimerMode,
  skipTimer,
  startTimer,
  timerRemaining,
  updateTimerDuration,
  type PomodoroPreferences,
  type TimerMode,
} from '@/lib/pomodoro';

function readInitialState(): PomodoroPreferences {
  if (typeof window === 'undefined') return createInitialTimerState();
  try {
    return loadTimerState(window.localStorage.getItem(POMODORO_STORAGE_KEY));
  } catch {
    return createInitialTimerState();
  }
}

function playCompletionSound() {
  try {
    const AudioContextConstructor = window.AudioContext;
    if (!AudioContextConstructor) return;
    const context = new AudioContextConstructor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.35);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.35);
    oscillator.onended = () => { void context.close().catch(() => undefined); };
  } catch {
    // The in-app completion notice remains available when audio is blocked.
  }
}

export function usePomodoroTimer() {
  const [state, setState] = useState(readInitialState);
  const [now, setNow] = useState(() => Date.now());
  const lastNotifiedCompletion = useRef<string | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(POMODORO_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
    }
  }, [state]);

  useEffect(() => {
    const refresh = () => {
      const currentTime = Date.now();
      setNow(currentTime);
      setState((current) => completeTimerIfExpired(current, currentTime));
    };
    const interval = window.setInterval(refresh, 1000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  useEffect(() => {
    const id = state.completionId;
    if (!id || lastNotifiedCompletion.current === id) return;
    lastNotifiedCompletion.current = id;
    if (state.soundEnabled) playCompletionSound();
    if (state.notificationsEnabled && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification('LectureLens timer', { body: state.notice || 'Your session is complete.' });
      } catch {
        // Notification support is optional; the in-app notice remains primary.
      }
    }
  }, [state.completionId, state.notice, state.notificationsEnabled, state.soundEnabled]);

  const start = useCallback(() => {
    const currentTime = Date.now();
    setNow(currentTime);
    setState((current) => startTimer(current, currentTime));
  }, []);
  const pause = useCallback(() => {
    const currentTime = Date.now();
    setNow(currentTime);
    setState((current) => pauseTimer(current, currentTime));
  }, []);
  const reset = useCallback(() => {
    setNow(Date.now());
    setState((current) => resetTimer(current));
  }, []);
  const skip = useCallback(() => {
    const currentTime = Date.now();
    setNow(currentTime);
    setState((current) => skipTimer(current, currentTime));
  }, []);
  const selectMode = useCallback((mode: TimerMode) => {
    setNow(Date.now());
    setState((current) => selectTimerMode(current, mode));
  }, []);
  const setDuration = useCallback((mode: TimerMode, duration: number) => setState((current) => updateTimerDuration(current, mode, duration)), []);
  const setAutoStart = useCallback((autoStart: boolean) => setState((current) => ({ ...current, autoStart })), []);
  const setSoundEnabled = useCallback((soundEnabled: boolean) => setState((current) => ({ ...current, soundEnabled })), []);
  const setNotificationsEnabled = useCallback(async (enabled: boolean) => {
    if (!enabled) {
      setState((current) => ({ ...current, notificationsEnabled: false }));
      return 'Browser notifications are off.';
    }
    if (typeof Notification === 'undefined') return 'Browser notifications are not supported here.';
    try {
      const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      const granted = permission === 'granted';
      setState((current) => ({ ...current, notificationsEnabled: granted }));
      return granted ? 'Browser notifications enabled.' : permission === 'denied' ? 'Notifications are blocked in browser settings; the in-app notice will still appear.' : 'Notification permission was not granted; the in-app notice will still appear.';
    } catch {
      setState((current) => ({ ...current, notificationsEnabled: false }));
      return 'Browser notifications are unavailable; the in-app notice will still appear.';
    }
  }, []);

  return {
    state,
    now,
    remainingMs: timerRemaining(state, now),
    start,
    pause,
    reset,
    skip,
    selectMode,
    setDuration,
    setAutoStart,
    setSoundEnabled,
    setNotificationsEnabled,
    clearNotice: () => setState((current) => ({ ...current, notice: '' })),
  };
}
