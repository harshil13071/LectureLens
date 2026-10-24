import { useEffect, useState } from 'react';
import { Bell, BellOff, Check, Clock3, Pause, Play, RotateCcw, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { usePomodoroTimer } from '@/hooks/use-pomodoro-timer';
import { durationIsValid, type TimerMode } from '@/lib/pomodoro';

const modes: Array<{ id: TimerMode; label: string; accent: string }> = [
  { id: 'focus', label: 'Focus', accent: '#a99aff' },
  { id: 'shortBreak', label: 'Short Break', accent: '#77d8b0' },
  { id: 'longBreak', label: 'Long Break', accent: '#73c9e8' },
];

function formatTime(milliseconds: number) {
  const seconds = Math.ceil(milliseconds / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export function PomodoroTimer() {
  const timer = usePomodoroTimer();
  const [drafts, setDrafts] = useState<Record<TimerMode, string>>({
    focus: String(timer.state.durations.focus),
    shortBreak: String(timer.state.durations.shortBreak),
    longBreak: String(timer.state.durations.longBreak),
  });
  const [durationErrors, setDurationErrors] = useState<Partial<Record<TimerMode, string>>>({});
  const [notificationMessage, setNotificationMessage] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    setDrafts({
      focus: String(timer.state.durations.focus),
      shortBreak: String(timer.state.durations.shortBreak),
      longBreak: String(timer.state.durations.longBreak),
    });
  }, [timer.state.durations]);

  const activeMode = modes.find((mode) => mode.id === timer.state.mode)!;
  const progress = 1 - timer.remainingMs / timer.state.sessionDurationMs;
  const circumference = 2 * Math.PI * 92;
  const primaryAction = timer.state.running ? timer.pause : timer.start;
  const primaryLabel = timer.state.running ? 'Pause timer' : timer.remainingMs < timer.state.sessionDurationMs ? 'Resume timer' : 'Start timer';

  const saveDuration = (mode: TimerMode) => {
    const parsed = Number(drafts[mode]);
    if (!durationIsValid(parsed)) {
      setDurationErrors((current) => ({ ...current, [mode]: 'Use a whole number from 1 to 180.' }));
      setDrafts((current) => ({ ...current, [mode]: String(timer.state.durations[mode]) }));
      return;
    }
    setDurationErrors((current) => ({ ...current, [mode]: undefined }));
    timer.setDuration(mode, parsed);
    setDrafts((current) => ({ ...current, [mode]: String(parsed) }));
  };

  const toggleNotifications = async (enabled: boolean) => {
    setNotificationMessage(await timer.setNotificationsEnabled(enabled));
  };

  return (
    <section id="timer" aria-labelledby="timer-heading" className="scroll-mt-24 rounded-[24px] border border-[#302e3c] bg-[#13121a] p-5 shadow-[0_16px_45px_rgba(0,0,0,.18)] sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-[13px] border border-[#3b3655] bg-[#211d33] text-[#b3a6ff]"><Clock3 size={19} /></div>
          <div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-[#827c99]">Study rhythm</p><h2 id="timer-heading" className="mt-0.5 font-display text-[22px] font-bold tracking-[-.03em] text-[#f0eef8]">Pomodoro timer</h2></div>
        </div>
        <button type="button" aria-expanded={settingsOpen} aria-controls="pomodoro-settings" onClick={() => setSettingsOpen((open) => !open)} className="rounded-lg border border-[#353341] bg-[#1b1a23] px-3 py-2 text-[11px] font-semibold text-[#d1cede] transition hover:bg-[#252330]">{settingsOpen ? 'Hide settings' : 'Timer settings'}</button>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(270px,.72fr)] lg:items-center">
        <div className="flex flex-col items-center">
          <div className="mb-4 inline-flex rounded-xl border border-[#302e3c] bg-[#191821] p-1" role="group" aria-label="Timer session">
            {modes.map((mode) => <button key={mode.id} type="button" aria-pressed={timer.state.mode === mode.id} onClick={() => timer.selectMode(mode.id)} className={`rounded-lg px-3 py-2 text-[11px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a99aff] ${timer.state.mode === mode.id ? 'bg-[#302a48] text-white shadow-sm' : 'text-[#9691a5] hover:bg-[#252330] hover:text-[#efedf6]'}`}>{mode.label}</button>)}
          </div>
          <div className="relative grid h-[230px] w-[230px] place-items-center" role="timer" aria-label={`${activeMode.label}: ${formatTime(timer.remainingMs)} remaining`}>
            <svg className="absolute inset-0 -rotate-90" viewBox="0 0 220 220" aria-hidden="true">
              <circle cx="110" cy="110" r="92" fill="none" stroke="#302e3c" strokeWidth="8" />
              <circle cx="110" cy="110" r="92" fill="none" stroke={activeMode.accent} strokeWidth="8" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - Math.max(0, Math.min(1, progress)))} className="pomodoro-progress" />
            </svg>
            <div className="text-center">
              <p className="text-[11px] font-bold uppercase tracking-[.15em]" style={{ color: activeMode.accent }}>{activeMode.label}</p>
              <p className="mt-1 font-display text-[54px] font-semibold leading-none tracking-[-.06em] text-[#f3f1f8]" aria-live="off">{formatTime(timer.remainingMs)}</p>
              <p className="mt-3 text-[10px] text-[#888397]">{timer.state.running ? 'Session in progress' : timer.remainingMs < timer.state.sessionDurationMs ? 'Paused · ready when you are' : 'Ready when you are'}</p>
            </div>
          </div>
          <div className="mt-5 flex w-full max-w-[390px] items-center gap-2">
            <button type="button" onClick={primaryAction} aria-label={primaryLabel} className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[#705de0] px-4 text-[12px] font-bold text-white transition hover:bg-[#806ef0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b6aaff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#13121a]">{timer.state.running ? <Pause size={15} /> : <Play size={15} />}{timer.state.running ? 'Pause' : timer.remainingMs < timer.state.sessionDurationMs ? 'Resume' : 'Start'}</button>
            <button type="button" onClick={timer.reset} aria-label="Reset timer" className="grid h-11 w-11 place-items-center rounded-xl border border-[#393744] bg-[#1b1a23] text-[#d0cdda] transition hover:bg-[#292733] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b6aaff]"><RotateCcw size={15} /></button>
            <button type="button" onClick={timer.skip} aria-label="Skip to next session without completing this one" className="grid h-11 w-11 place-items-center rounded-xl border border-[#393744] bg-[#1b1a23] text-[#d0cdda] transition hover:bg-[#292733] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b6aaff]"><SkipForward size={15} /></button>
          </div>
          <p className="mt-3 text-center text-[11px] text-[#898498]">{timer.state.completedFocusSessions} focus {timer.state.completedFocusSessions === 1 ? 'session' : 'sessions'} completed · {timer.state.focusSessionsInCycle} of 4 in this cycle</p>
          {timer.state.notice && <div role="status" className="mt-3 flex items-center gap-2 rounded-xl border border-[#3a3552] bg-[#201d2c] px-3 py-2.5 text-[11px] text-[#d9d2ff]"><Check size={14} className="shrink-0" />{timer.state.notice}<button type="button" onClick={timer.clearNotice} aria-label="Dismiss timer notification" className="ml-2 text-[#aaa2c7] hover:text-white">Dismiss</button></div>}
        </div>

        <aside className="rounded-2xl border border-[#302e3c] bg-[#191821] p-4 sm:p-5">
          <div><p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#817b94]">Session plan</p><p className="mt-1 text-[12px] leading-5 text-[#aaa6b7]">Four completed focus sessions lead into a long break. Skipping never counts a session as complete. If you return after a timer expires, it records that session and advances once; it does not replay missed sessions.</p></div>
          <div className="mt-5 grid grid-cols-3 gap-2">
            {modes.map((mode) => <div key={mode.id} className="rounded-xl border border-[#302e3c] bg-[#13121a] px-2.5 py-3 text-center"><p className="text-[10px] text-[#918ca1]">{mode.label}</p><p className="mt-1 text-[17px] font-bold text-[#eae8f1]">{timer.state.durations[mode.id]}<span className="ml-1 text-[10px] font-medium text-[#858094]">min</span></p></div>)}
          </div>
          <p className="mt-3 text-[10px] leading-4 text-[#817c91]">Duration changes apply to the next session while a timer is running. Editing the selected duration while idle resets that session to its new full length.</p>
          <div className="mt-5 border-t border-[#302e3c] pt-4">
            <label className="flex cursor-pointer items-center justify-between gap-3 text-[11px] font-semibold text-[#d4d0df]"><span>Auto-start next session</span><input type="checkbox" checked={timer.state.autoStart} onChange={(event) => timer.setAutoStart(event.target.checked)} className="h-4 w-4 accent-[#806ef0]" /></label>
            <label className="mt-3 flex cursor-pointer items-center justify-between gap-3 text-[11px] font-semibold text-[#d4d0df]"><span className="flex items-center gap-2">{timer.state.soundEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}Completion sound</span><input type="checkbox" checked={timer.state.soundEnabled} onChange={(event) => timer.setSoundEnabled(event.target.checked)} className="h-4 w-4 accent-[#806ef0]" /></label>
            <label className="mt-3 flex cursor-pointer items-center justify-between gap-3 text-[11px] font-semibold text-[#d4d0df]"><span className="flex items-center gap-2">{timer.state.notificationsEnabled ? <Bell size={14} /> : <BellOff size={14} />}Browser notification</span><input type="checkbox" checked={timer.state.notificationsEnabled} onChange={(event) => { void toggleNotifications(event.target.checked); }} className="h-4 w-4 accent-[#806ef0]" /></label>
            {notificationMessage && <p role="status" className="mt-2 text-[10px] leading-4 text-[#aaa4bb]">{notificationMessage}</p>}
          </div>
        </aside>
      </div>

      {settingsOpen && <div id="pomodoro-settings" className="mt-6 rounded-2xl border border-[#302e3c] bg-[#191821] p-4 sm:p-5">
        <div className="mb-4"><h3 className="text-[12px] font-bold text-[#ebe9f2]">Session durations</h3><p className="mt-1 text-[10px] text-[#8f8a9e]">Choose whole minutes from 1 to 180.</p></div>
        <div className="grid gap-3 sm:grid-cols-3">
          {modes.map((mode) => <label key={mode.id} className="text-[10px] font-semibold text-[#b8b4c5]">{mode.label} (minutes)<input type="number" min={1} max={180} step={1} value={drafts[mode.id]} onChange={(event) => setDrafts((current) => ({ ...current, [mode.id]: event.target.value }))} onBlur={() => saveDuration(mode.id)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} aria-invalid={Boolean(durationErrors[mode.id])} aria-describedby={durationErrors[mode.id] ? `duration-error-${mode.id}` : undefined} className="mt-1.5 h-10 w-full rounded-lg border border-[#3a3746] bg-[#121118] px-3 text-[12px] text-[#f0eef8] outline-none focus:border-[#8f7cf2] focus:ring-2 focus:ring-[#8f7cf2]/20" />{durationErrors[mode.id] && <span id={`duration-error-${mode.id}`} className="mt-1 block text-[10px] text-[#ffaaa4]">{durationErrors[mode.id]}</span>}</label>)}
        </div>
      </div>}
    </section>
  );
}
