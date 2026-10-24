import { type ReactNode, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { useAskLecture, useGenerateQuiz, useGenerateStudyNotes, useEvaluateShortAnswer } from '@workspace/api-client-react';
import {
  ArrowDownToLine, ArrowRight, BookOpen, Check, CheckCircle2, CircleHelp, Clipboard,
  FileText, GraduationCap, Lightbulb, Link2, LoaderCircle, MessageCircle, RotateCcw,
  Sparkles, X, Youtube,
} from 'lucide-react';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();
type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  foundInTranscript?: boolean;
};

function getApiErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'data' in error) {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') {
      const retryAfter = 'retryAfter' in data && typeof data.retryAfter === 'number' ? data.retryAfter : undefined;
      if (retryAfter) {
        return `${data.error} Please wait ${retryAfter}s before retrying.`;
      }
      return data.error;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

function Home() {
  const [title, setTitle] = useState('');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [transcript, setTranscript] = useState('');
  const [question, setQuestion] = useState('');
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<number, number | string>>({});
  const [quizSubmitted, setQuizSubmitted] = useState(false);
  const [questionType, setQuestionType] = useState<'mcq' | 'short_answer' | 'mixed'>('mcq');
  const [questionCount, setQuestionCount] = useState('5');
  const [customQuestionCount, setCustomQuestionCount] = useState('');
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard' | 'mixed'>('medium');
  const [evaluations, setEvaluations] = useState<Record<number, Awaited<ReturnType<ReturnType<typeof useEvaluateShortAnswer>['mutateAsync']>>>>({});
  const [evaluationError, setEvaluationError] = useState('');
  const [copied, setCopied] = useState(false);
  const notes = useGenerateStudyNotes();
  const quiz = useGenerateQuiz();
  const evaluateAnswer = useEvaluateShortAnswer();
  const ask = useAskLecture();
  const ready = transcript.trim().length > 0;
  const lengthLabel = `${transcript.length.toLocaleString()} / 40,000`;

  const clearWorkspace = () => {
    setTitle('');
    setYoutubeUrl('');
    setTranscript('');
    setQuestion('');
    setChatHistory([]);
    setSelectedAnswers({});
    setQuizSubmitted(false);
    setCopied(false);
    notes.reset();
    quiz.reset();
    ask.reset();
  };

  const makeNotes = () => {
    if (!ready || notes.isPending) return;
    notes.mutate({ data: { title: title.trim() || undefined, transcript: transcript.trim(), youtubeUrl: youtubeUrl.trim() || undefined } });
  };

  const makeQuiz = () => {
    const count = questionCount === 'custom' ? Number(customQuestionCount) : Number(questionCount);
    if (!ready || quiz.isPending || !Number.isInteger(count) || count < 1 || count > 30) return;
    setSelectedAnswers({});
    setEvaluations({});
    setEvaluationError('');
    setQuizSubmitted(false);
    quiz.mutate({ data: { title: title.trim() || undefined, transcript: transcript.trim(), questionType, questionCount: count, difficulty } });
  };
  const score = quiz.data?.questions.reduce((total, item, index) => total + (item.type === 'short_answer' ? (evaluations[index]?.isCorrect ? 1 : 0) : (selectedAnswers[index] === item.correctIndex ? 1 : 0)), 0) ?? 0;
  const submitQuiz = async () => {
    if (!quiz.data || evaluateAnswer.isPending) return;
    setEvaluationError('');
    try {
      const shortAnswers = await Promise.all(quiz.data.questions.map(async (item, index) => {
        if (item.type !== 'short_answer') return null;
        return evaluateAnswer.mutateAsync({ data: { question: item.question, studentAnswer: String(selectedAnswers[index] ?? ''), expectedAnswer: item.expectedAnswer ?? '', keyPoints: item.keyPoints ?? [] } }).then((result) => [index, result] as const);
      }));
      setEvaluations(Object.fromEntries(shortAnswers.filter((entry): entry is NonNullable<typeof entry> => entry !== null)));
      setQuizSubmitted(true);
    } catch {
      setEvaluationError('Some answers could not be evaluated. Please try checking your answers again.');
    }
  };
  const askQuestion = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submittedQuestion = question.trim();
    if (!submittedQuestion || ask.isPending) return;
    ask.mutate(
      {
        data: {
          title: title.trim() || undefined,
          transcript: transcript.trim() || undefined,
          conversation: chatHistory.slice(-10).map(({ role, content }) => ({ role, content })),
          question: submittedQuestion,
        },
      },
      {
        onSuccess: (answer) => {
          const userMessage: ChatMessage = { role: 'user', content: submittedQuestion };
          const assistantMessage: ChatMessage = {
            role: 'assistant',
            content: answer.answer,
            foundInTranscript: answer.foundInTranscript,
          };
          setChatHistory((current) => [...current, userMessage, assistantMessage].slice(-12));
          setQuestion('');
        },
      },
    );
  };
  const getNotesText = () => {
    const result = notes.data;
    if (!result) return '';
    return [
      title.trim() || 'Lecture notes',
      'OVERVIEW', result.overview,
      ...result.topics.flatMap((topic) => [`\n${topic.title}`, ...topic.notes.map((line) => `• ${line}`)]),
      '\nKEY CONCEPTS', ...result.keyConcepts.map((concept) => `${concept.term}: ${concept.definition}`),
      '\nTAKEAWAYS', ...result.takeaways.map((takeaway) => `• ${takeaway}`),
      '\nQUICK REVISION', result.quickRevision,
    ].join('\n');
  };
  const copyNotes = async () => {
    try {
      await navigator.clipboard.writeText(getNotesText());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  const downloadNotes = () => {
    const file = new Blob([getNotesText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(title.trim() || 'lecture-notes').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };


  return (
    <main className="lecture-lens-dark min-h-[100dvh] bg-[#f8f7fc] text-[#282641]">
      <header className="sticky top-0 z-20 border-b border-[#eae8f1] bg-[#faf9fd]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-[68px] max-w-[1320px] items-center justify-between gap-2 px-3 sm:px-8">
          <a href="#" className="flex items-center gap-2.5 no-underline" data-testid="link-home">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#6754d9] text-white shadow-[0_5px_12px_rgba(103,84,217,.22)]"><GraduationCap size={20} /></span>
            <span className="font-display text-[18px] font-extrabold tracking-[-.04em] text-[#292641]">LectureLens</span>
          </a>
          <nav aria-label="Main navigation" className="flex items-center gap-1.5 whitespace-nowrap text-[9px] font-semibold text-[#77738c] sm:gap-5 sm:text-[12px]">
            <a href="#workspace" data-testid="link-workspace" className="transition hover:text-[#6754d9]">Workspace</a>
            <a href={notes.data || notes.isPending ? '#notes-output' : '#notes-preview'} data-testid="link-notes-preview" className="transition hover:text-[#6754d9]">Notes</a>
            <a href="#practice" data-testid="link-practice" className="transition hover:text-[#6754d9]">Practice</a>
            <a href="#ask" data-testid="link-ask" className="transition hover:text-[#6754d9]">Ask</a>
          </nav>
          <div className="hidden items-center gap-2 rounded-full border border-[#e9e6f2] bg-white px-3 py-1.5 text-[12px] font-medium text-[#77738c] sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-[#7c68e6]" /> Your personal study space
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1320px] px-5 pb-20 sm:px-8">
        <section className="relative overflow-hidden pb-10 pt-12 sm:pb-14 sm:pt-[68px]">
          <div className="pointer-events-none absolute -right-10 -top-16 h-72 w-72 rounded-full bg-[#ece8ff] opacity-65 blur-3xl" />
          <div className="pointer-events-none absolute right-[18%] top-16 h-40 w-40 rounded-full border border-[#e5dfff]" />
          <div className="relative grid gap-8 lg:grid-cols-[1fr_350px] lg:items-end">
            <div className="rise-in">
              <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#e6e1fa] bg-white/80 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[.13em] text-[#7565cb]">
                <Sparkles size={13} /> A clearer way to study
              </div>
              <h1 className="font-display max-w-[720px] text-[42px] font-extrabold leading-[1.06] tracking-[-.055em] text-[#292641] sm:text-[58px] lg:text-[66px]">Turn lectures into learning.</h1>
              <p className="mt-5 max-w-[600px] text-[16px] leading-7 text-[#77748c] sm:text-[18px]">Transform lecture transcripts into clear notes, quizzes, and answers.</p>
            </div>
            <div className="rise-in-delay hidden lg:block">
              <div className="relative ml-auto w-[310px] rounded-[22px] border border-[#e9e4fb] bg-white p-5 shadow-[0_18px_55px_rgba(69,55,135,.09)]">
                <div className="absolute -right-3 -top-3 grid h-10 w-10 place-items-center rounded-[14px] border border-[#e9e4fb] bg-[#f4f1ff] text-[#6b58d7]"><Lightbulb size={19} /></div>
                <p className="text-[10px] font-bold uppercase tracking-[.16em] text-[#a09bb2]">A little more clarity</p>
                <p className="mt-3 font-display text-[20px] font-bold leading-snug tracking-[-.03em] text-[#393553]">From a wall of words to a way forward.</p>
                <div className="mt-5 flex items-center gap-2 text-[12px] font-semibold text-[#7664cf]"><span className="h-px w-7 bg-[#c9c0f3]" /> Make the next study session count</div>
              </div>
            </div>
          </div>
        </section>

        <section id="workspace" className="grid scroll-mt-24 gap-5 lg:grid-cols-[minmax(0,1.58fr)_minmax(290px,.82fr)]">
          <div className="rounded-[22px] border border-[#e9e7ef] bg-white p-5 shadow-[0_5px_24px_rgba(55,48,94,.045)] sm:p-7">
            <div className="mb-6 flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-[13px] bg-[#f0edff] text-[#6c59d4]"><FileText size={19} /></div>
                <div><h2 className="font-display text-[20px] font-bold tracking-[-.03em]">Start with your transcript</h2><p className="mt-0.5 text-[13px] text-[#88849a]">Paste lecture text and choose what to make.</p></div>
              </div>
              <span className="hidden rounded-full bg-[#f6f5fa] px-3 py-1 text-[11px] font-semibold text-[#8a869c] sm:inline-flex">Private workspace</span>
            </div>
            <label className="mb-2 block text-[12px] font-bold text-[#4b4861]" htmlFor="lecture-title">Lecture title <span className="font-medium text-[#aaa6b7]">· optional</span></label>
            <input id="lecture-title" data-testid="input-lecture-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} placeholder="e.g. Week 4 — Memory & cognition" className="h-11 w-full rounded-xl border border-[#e8e6ef] bg-[#fcfbfe] px-3.5 text-[14px] text-[#302d48] outline-none transition focus:border-[#a89aed] focus:ring-4 focus:ring-[#7765df]/10" />
            <label className="mb-2 mt-5 block text-[12px] font-bold text-[#4b4861]" htmlFor="youtube-url"><span className="inline-flex items-center gap-1.5"><Youtube size={14} className="text-[#8e79d8]" /> YouTube link</span><span className="ml-1 font-medium text-[#aaa6b7]">· optional, reference only</span></label>
            <div className="relative">
              <Link2 size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#aaa6b7]" />
              <input id="youtube-url" data-testid="input-youtube-url" value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)} maxLength={2048} placeholder="https://youtube.com/watch?v=..." className="h-11 w-full rounded-xl border border-[#e8e6ef] bg-[#fcfbfe] pl-10 pr-3.5 text-[14px] text-[#302d48] outline-none transition focus:border-[#a89aed] focus:ring-4 focus:ring-[#7765df]/10" />
            </div>
            <div className="mb-2 mt-5 flex items-center justify-between">
              <label className="text-[12px] font-bold text-[#4b4861]" htmlFor="lecture-transcript">Transcript</label>
              <div className="flex items-center gap-3">
                <span data-testid="text-transcript-count" className={`font-mono text-[10px] font-medium ${transcript.length > 40000 ? 'text-red-500' : 'text-[#aaa6b7]'}`}>{lengthLabel}</span>
                <button type="button" data-testid="button-clear-transcript" onClick={clearWorkspace} disabled={!title && !youtubeUrl && !transcript && !question && !notes.data && !quiz.data && !ask.data} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#8177a4] transition hover:text-[#6754d9] disabled:cursor-not-allowed disabled:opacity-40">
                  <X size={13} /> Clear
                </button>
              </div>
            </div>
            <textarea id="lecture-transcript" data-testid="input-lecture-transcript" value={transcript} onChange={(event) => setTranscript(event.target.value.slice(0, 40000))} placeholder="Paste your lecture transcript here. The more context you include, the more useful your study materials will be." className="min-h-[190px] w-full resize-y rounded-xl border border-[#e8e6ef] bg-[#fcfbfe] p-4 text-[14px] leading-6 text-[#302d48] outline-none transition placeholder:text-[#aaa6b7] focus:border-[#a89aed] focus:ring-4 focus:ring-[#7765df]/10 sm:min-h-[220px]" />
            <p className="mt-2 flex items-center gap-1.5 text-[11px] leading-5 text-[#9995a8]"><CircleHelp size={13} /> YouTube links are saved as context only. LectureLens never retrieves a transcript from a link.</p>
            <div className="mt-5 flex flex-col gap-2.5 sm:flex-row">
              <button data-testid="button-generate-notes" onClick={makeNotes} disabled={!ready || notes.isPending} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[#6754d9] px-4 text-[13px] font-bold text-white shadow-[0_5px_14px_rgba(103,84,217,.19)] transition hover:bg-[#5845c8] disabled:cursor-not-allowed disabled:opacity-45">
                {notes.isPending ? <LoaderCircle size={16} className="animate-spin" /> : <Sparkles size={16} />} {notes.isPending ? 'Making your notes…' : 'Generate study notes'} <ArrowRight size={15} />
              </button>
            </div>
            {notes.isError && <div data-testid="status-notes-error" role="alert" className="mt-4 flex items-center gap-2 rounded-xl border border-[#f2d8d6] bg-[#fff8f7] px-3.5 py-3 text-[12px] text-[#a94e48]"><X size={15} /> {getApiErrorMessage(notes.error, 'Study notes could not be generated. Please try again.')}</div>}
            {quiz.isError && <div data-testid="status-quiz-error" role="alert" className="mt-4 flex items-center gap-2 rounded-xl border border-[#f2d8d6] bg-[#fff8f7] px-3.5 py-3 text-[12px] text-[#a94e48]"><X size={15} /> {getApiErrorMessage(quiz.error, 'The quiz could not be generated. Please try again.')}</div>}
          </div>

          <aside id="notes-preview" className="scroll-mt-24 rounded-[22px] border border-[#e9e4f5] bg-[#f2efff] p-5 sm:p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[.1em] text-[#7164b5]"><BookOpen size={15} /> Study notes preview</div>
              <span className="rounded-full border border-[#ded7f5] bg-white/70 px-2.5 py-1 text-[9px] font-bold uppercase tracking-[.12em] text-[#8a7dc2]">Illustrative</span>
            </div>
            <p className="mt-1.5 text-[11px] text-[#938bb6]">Example format only · not generated from your transcript</p>
            <div className="mt-5 rounded-[16px] border border-white/90 bg-white/80 p-4">
              <div className="flex items-center gap-2"><span className="grid h-7 w-7 place-items-center rounded-lg bg-[#f0edff] text-[#7665d8]"><Lightbulb size={14} /></span><span className="text-[11px] font-bold text-[#77718f]">OVERVIEW</span></div>
              <p className="mt-3 text-[13px] leading-[1.7] text-[#625e78]">A concise orientation to the lecture’s central idea, written to help you see the big picture first.</p>
              <div className="my-4 h-px bg-[#eeebf5]" />
              <p className="text-[11px] font-bold text-[#77718f]">KEY CONCEPTS</p>
              <div className="mt-2.5 space-y-2.5">
                <div className="flex gap-2.5"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#8f7ce3]" /><p className="text-[12px] leading-5 text-[#67627d]"><strong className="text-[#49445f]">Core term</strong> — a short, lecture-grounded definition.</p></div>
                <div className="flex gap-2.5"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#b09fe9]" /><p className="text-[12px] leading-5 text-[#67627d]"><strong className="text-[#49445f]">Key takeaway</strong> — the idea worth carrying forward.</p></div>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2 rounded-xl border border-[#e1dcf3] bg-white/55 px-3.5 py-3 text-[11px] leading-5 text-[#8179a2]"><Sparkles size={14} className="shrink-0 text-[#8977df]" /> Your notes will appear here after generation.</div>
          </aside>
        </section>

        {(notes.data || notes.isPending) && <section id="notes-output" className="mt-6 scroll-mt-24 rounded-[22px] border border-[#e9e7ef] bg-white p-5 shadow-[0_5px_24px_rgba(55,48,94,.045)] sm:p-7">
          <div className="flex flex-col gap-4 border-b border-[#efedf4] pb-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-[13px] bg-[#f0edff] text-[#6c59d4]"><FileText size={19} /></div><div><div className="flex flex-wrap items-center gap-2"><h2 className="font-display text-[20px] font-bold tracking-[-.03em]">{title || 'Your study notes'}</h2><span className="rounded-full bg-[#eeebff] px-2.5 py-1 text-[9px] font-bold uppercase tracking-[.1em] text-[#725fcf]">Generated from transcript</span></div><p className="mt-0.5 text-[12px] text-[#908c9f]">A structured guide to what your lecture covered.</p></div></div>
            {notes.data && <div className="flex gap-2"><button onClick={copyNotes} data-testid="button-copy-notes" className="inline-flex h-9 items-center gap-2 rounded-lg border border-[#e8e5ef] px-3 text-[12px] font-semibold text-[#625d79] hover:bg-[#faf9fc]">{copied ? <Check size={14} /> : <Clipboard size={14} />}{copied ? 'Copied' : 'Copy'}</button><button onClick={downloadNotes} data-testid="button-download-notes" className="inline-flex h-9 items-center gap-2 rounded-lg border border-[#e8e5ef] px-3 text-[12px] font-semibold text-[#625d79] hover:bg-[#faf9fc]"><ArrowDownToLine size={14} /> Download</button></div>}
          </div>
          {notes.isPending ? <div className="grid gap-4 pt-6 sm:grid-cols-2"><div className="space-y-3"><div className="h-4 w-24 animate-pulse rounded bg-[#efedf5]" /><div className="h-3 w-full animate-pulse rounded bg-[#f3f1f7]" /><div className="h-3 w-5/6 animate-pulse rounded bg-[#f3f1f7]" /></div><div className="space-y-3"><div className="h-4 w-32 animate-pulse rounded bg-[#efedf5]" /><div className="h-3 w-full animate-pulse rounded bg-[#f3f1f7]" /><div className="h-3 w-4/6 animate-pulse rounded bg-[#f3f1f7]" /></div></div> : notes.data && <div className="grid gap-x-12 gap-y-7 pt-6 md:grid-cols-2">
            <article className="md:col-span-2"><h3 className="mb-2 text-[11px] font-bold uppercase tracking-[.14em] text-[#8176bb]">Overview</h3><p className="max-w-4xl text-[14px] leading-7 text-[#59566f]">{notes.data.overview}</p></article>
            {notes.data.topics.map((topic, index) => <article key={`${topic.title}-${index}`}><h3 className="mb-3 font-display text-[16px] font-bold tracking-[-.02em]">{topic.title}</h3><ul className="space-y-2.5">{topic.notes.map((line, lineIndex) => <li key={`${line}-${lineIndex}`} className="flex gap-2.5 text-[13px] leading-6 text-[#666279]"><span className="mt-[10px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#8a78dc]" />{line}</li>)}</ul></article>)}
            <article><h3 className="mb-3 text-[11px] font-bold uppercase tracking-[.14em] text-[#8176bb]">Key concepts & definitions</h3><div className="space-y-3">{notes.data.keyConcepts.map((concept, index) => <div key={`${concept.term}-${index}`} className="rounded-xl bg-[#f8f7fc] p-3.5"><p className="text-[13px] font-bold text-[#45415b]">{concept.term}</p><p className="mt-1 text-[12px] leading-5 text-[#716d82]">{concept.definition}</p></div>)}</div></article>
            <article><h3 className="mb-3 text-[11px] font-bold uppercase tracking-[.14em] text-[#8176bb]">Takeaways</h3><ul className="space-y-2.5">{notes.data.takeaways.map((line, index) => <li key={`${line}-${index}`} className="flex gap-2.5 text-[13px] leading-6 text-[#666279]"><CheckCircle2 size={16} className="mt-1 shrink-0 text-[#8170d8]" />{line}</li>)}</ul></article>
            <article className="rounded-2xl border border-[#e8e2fc] bg-[#f7f4ff] p-4 md:col-span-2"><h3 className="mb-2 text-[11px] font-bold uppercase tracking-[.14em] text-[#7565c7]">Quick revision</h3><p className="text-[13px] leading-6 text-[#5e5879]">{notes.data.quickRevision}</p></article>
          </div>}
        </section>}

        <section className="mt-6 grid gap-5 lg:grid-cols-2">
          <div id="practice" className="scroll-mt-24 rounded-[22px] border-2 border-[#dcd5f7] bg-white p-5 shadow-[0_8px_28px_rgba(103,84,217,.09)] sm:p-6">
            <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-[13px] bg-[#f0edff] text-[#6c59d4]"><BookOpen size={19} /></div><div><h2 className="font-display text-[19px] font-bold tracking-[-.03em]">Practice what you learned</h2><p className="text-[12px] text-[#908c9f]">Set up your quiz before generating it.</p></div></div>
            <div className="mt-5 rounded-2xl border border-[#e8e2fc] bg-[#faf9ff] p-4">
              <h3 className="mb-3 text-[11px] font-extrabold uppercase tracking-[.13em] text-[#7164b5]">Quiz settings</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-[11px] font-bold text-[#5b5672]">Question type<select aria-label="Question type" data-testid="select-quiz-type" value={questionType} onChange={(event) => setQuestionType(event.target.value as typeof questionType)} className="mt-1.5 h-10 w-full rounded-lg border border-[#e0dcef] bg-white px-3 text-[12px]"><option value="mcq">MCQ</option><option value="short_answer">Short Answer</option><option value="mixed">Mixed</option></select></label>
                <label className="text-[11px] font-bold text-[#5b5672]">Number of questions<select aria-label="Number of questions" data-testid="select-quiz-count" value={questionCount} onChange={(event) => setQuestionCount(event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-[#e0dcef] bg-white px-3 text-[12px]"><option value="5">5</option><option value="10">10</option><option value="15">15</option><option value="20">20</option><option value="custom">Custom</option></select></label>
                {questionCount === 'custom' && <label className="text-[11px] font-bold text-[#5b5672]">Custom count (1–30)<input aria-label="Custom question count (1–30)" data-testid="input-custom-quiz-count" type="number" min="1" max="30" step="1" value={customQuestionCount} onChange={(event) => setCustomQuestionCount(event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-[#e0dcef] bg-white px-3 text-[12px]" placeholder="Enter 1–30" /></label>}
                <label className="text-[11px] font-bold text-[#5b5672]">Difficulty<select aria-label="Difficulty" data-testid="select-quiz-difficulty" value={difficulty} onChange={(event) => setDifficulty(event.target.value as typeof difficulty)} className="mt-1.5 h-10 w-full rounded-lg border border-[#e0dcef] bg-white px-3 text-[12px]"><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option><option value="mixed">Mixed</option></select></label>
              </div>
              {questionCount === 'custom' && customQuestionCount !== '' && (!Number.isInteger(Number(customQuestionCount)) || Number(customQuestionCount) < 1 || Number(customQuestionCount) > 30) && <p role="alert" className="mt-2 text-[11px] text-[#a94e48]">Enter a whole number from 1 to 30.</p>}
            </div>
            <button type="button" data-testid="button-generate-quiz" onClick={makeQuiz} disabled={!ready || quiz.isPending || (questionCount === 'custom' && (!Number.isInteger(Number(customQuestionCount)) || Number(customQuestionCount) < 1 || Number(customQuestionCount) > 30))} className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#6754d9] text-[13px] font-bold text-white transition hover:bg-[#5845c8] disabled:cursor-not-allowed disabled:opacity-45">{quiz.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />}{quiz.isPending ? 'Generating quiz…' : 'Generate Quiz'}</button>
            {!ready && !quiz.data && <p className="mt-2 text-center text-[11px] text-[#908c9f]">Add a transcript above to enable quiz generation.</p>}
            {!quiz.data && !quiz.isPending && <div className="mt-4 rounded-xl border border-dashed border-[#ded9ed] bg-white px-4 py-4 text-center"><p className="text-[13px] font-semibold text-[#68637d]">Your practice quiz will appear here.</p></div>}
            {quiz.isPending && <div className="mt-5 space-y-3" aria-label="Building quiz">{[0, 1, 2].map((item) => <div key={item} className="h-16 animate-pulse rounded-xl bg-[#f4f2f8]" />)}</div>}
            {quiz.isError && <div role="alert" className="mt-4 rounded-xl border border-[#f2d8d6] bg-[#fff8f7] p-3 text-[12px] text-[#a94e48]">{getApiErrorMessage(quiz.error, 'The quiz could not be generated. Please try again.')}</div>}
            {quiz.data && <div className="mt-5">
              {quizSubmitted && <div className="mb-5 flex items-center justify-between rounded-xl bg-[#f3f0ff] px-4 py-3"><div><p className="text-[11px] font-bold uppercase tracking-[.12em] text-[#796cc1]">Your score</p><p className="mt-0.5 font-display text-[21px] font-extrabold text-[#453b80]">{score} <span className="text-[13px] font-semibold text-[#827aa7]">/ {quiz.data.questions.length}</span></p></div><button onClick={() => { setSelectedAnswers({}); setQuizSubmitted(false); }} data-testid="button-retry-quiz" className="inline-flex items-center gap-1.5 text-[12px] font-bold text-[#6f5ec7]"><RotateCcw size={14} /> Try again</button></div>}
              <div className="space-y-5">{quiz.data.questions.map((item, index) => {
                const picked = selectedAnswers[index];
                const isShortAnswer = item.type === 'short_answer';
                const answeredCorrectly = isShortAnswer ? evaluations[index]?.isCorrect : picked === item.correctIndex;
                return <article key={`quiz-${index}`} className="border-b border-[#f0eef5] pb-5 last:border-0 last:pb-0">
                  <p className="text-[13px] font-bold leading-5 text-[#403c56]"><span className="mr-2 font-mono text-[11px] text-[#8d80d3]">{String(index + 1).padStart(2, '0')}</span>{item.question}</p>
                  {isShortAnswer ? <textarea aria-label={`Answer for question ${index + 1}`} disabled={quizSubmitted} value={String(picked ?? '')} onChange={(event) => setSelectedAnswers((current) => ({ ...current, [index]: event.target.value }))} placeholder="Type your answer…" className="mt-3 min-h-20 w-full rounded-lg border border-[#e8e6ef] bg-[#fcfbfe] p-3 text-[12px] leading-5 disabled:opacity-75" /> : <div className="mt-3 space-y-2">{(item.options ?? []).map((option, optionIndex) => {
                    const isPicked = picked === optionIndex;
                    const isCorrect = optionIndex === item.correctIndex;
                    let optionStyle = 'border-[#eceaf2] bg-white text-[#68647a] hover:border-[#c8c0ed]';
                    if (quizSubmitted && isCorrect) optionStyle = 'border-[#bce4d2] bg-[#f1fbf6] text-[#327854]';
                    else if (quizSubmitted && isPicked && !isCorrect) optionStyle = 'border-[#f1ceca] bg-[#fff5f4] text-[#a54e49]';
                    else if (isPicked) optionStyle = 'border-[#9a89e5] bg-[#f5f2ff] text-[#55469e]';
                    return <button type="button" key={optionIndex} disabled={quizSubmitted} onClick={() => setSelectedAnswers((current) => ({ ...current, [index]: optionIndex }))} data-testid={`button-quiz-${index}-option-${optionIndex}`} className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left text-[12px] leading-5 transition ${optionStyle}`}><span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${isPicked ? 'border-[#8875de] bg-[#8875de] text-white' : 'border-[#d9d6e2] bg-white'}`}>{isPicked && <Check size={10} />}</span>{option}{quizSubmitted && isCorrect && <CheckCircle2 size={15} className="ml-auto mt-0.5 shrink-0" />}</button>;
                  })}</div>}
                  {quizSubmitted && <div className={`mt-2.5 rounded-lg px-3 py-2.5 text-[11px] leading-5 ${answeredCorrectly ? 'bg-[#f2faf6] text-[#4a785f]' : 'bg-[#f6f4fb] text-[#6b6680]'}`}><strong>{answeredCorrectly ? 'That’s right.' : isShortAnswer ? `Expected answer: ${item.expectedAnswer ?? 'See key points below.'}` : `Correct answer: ${item.options?.[item.correctIndex ?? -1] ?? 'Unavailable'}.`}</strong> {isShortAnswer && evaluations[index] ? `${evaluations[index].feedback} ` : null}{item.explanation} {isShortAnswer && item.keyPoints?.length ? <span> Key points: {item.keyPoints.join('; ')}.</span> : null}</div>}
                </article>;
              })}</div>
              {evaluationError && <p role="alert" className="mt-3 text-[12px] text-[#a94e48]">{evaluationError}</p>}
              {!quizSubmitted && <button data-testid="button-submit-quiz" onClick={submitQuiz} disabled={quiz.data.questions.some((item, index) => item.type === 'short_answer' ? !String(selectedAnswers[index] ?? '').trim() : selectedAnswers[index] === undefined) || evaluateAnswer.isPending} className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[#6754d9] text-[12px] font-bold text-white transition hover:bg-[#5845c8] disabled:cursor-not-allowed disabled:opacity-45">{evaluateAnswer.isPending ? <LoaderCircle size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}{evaluateAnswer.isPending ? 'Evaluating answers…' : 'Check my answers'}</button>}
            </div>}
          </div>

          <div id="ask" className="scroll-mt-24 rounded-[22px] border border-[#e9e7ef] bg-white p-5 shadow-[0_5px_24px_rgba(55,48,94,.045)] sm:p-6">
            <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-[13px] bg-[#f0edff] text-[#6c59d4]"><MessageCircle size={19} /></div><div><h2 className="font-display text-[19px] font-bold tracking-[-.03em]">Ask your AI tutor</h2><p className="text-[12px] text-[#908c9f]">Your AI study companion — ask anything about your lecture or beyond.</p></div></div>
            <form onSubmit={askQuestion} className="mt-5">
              <label htmlFor="lecture-question" className="mb-2 block text-[12px] font-bold text-[#4b4861]">What would you like to understand?</label>
              <textarea id="lecture-question" data-testid="input-lecture-question" value={question} onChange={(event) => setQuestion(event.target.value.slice(0, 2000))} maxLength={2000} placeholder="Ask anything — about a lecture concept, JDK, or another topic…" className="min-h-[105px] w-full resize-y rounded-xl border border-[#e8e6ef] bg-[#fcfbfe] p-3.5 text-[13px] leading-6 text-[#302d48] outline-none transition placeholder:text-[#aaa6b7] focus:border-[#a89aed] focus:ring-4 focus:ring-[#7765df]/10" />
              <div className="mt-2 flex items-center justify-between"><span className="text-[10px] text-[#a39fb0]">{question.length} / 2,000</span><button type="submit" data-testid="button-ask-lecture" disabled={!question.trim() || ask.isPending} className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#6754d9] px-3.5 text-[12px] font-bold text-white transition hover:bg-[#5845c8] disabled:cursor-not-allowed disabled:opacity-45">{ask.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <ArrowRight size={14} />}{ask.isPending ? 'Thinking…' : 'Ask question'}</button></div>
            </form>
            {!ready && <div className="mt-4 rounded-xl border border-dashed border-[#ded9ed] bg-[#fbfaff] px-4 py-3 text-center text-[12px] text-[#8e899f]">No transcript added — ask a general question, or paste lecture text above for extra context.</div>}
            {ask.isError && <div data-testid="status-ask-error" role="alert" className="mt-4 rounded-xl border border-[#f2d8d6] bg-[#fff8f7] px-3.5 py-3 text-[12px] text-[#a94e48]">{getApiErrorMessage(ask.error, 'We couldn’t answer just now. Please try again.')}</div>}
            {chatHistory.length > 0 && <div className="mt-5 space-y-3" aria-live="polite">
              {chatHistory.map((message, index) => message.role === 'user'
                ? <div key={`chat-${index}`} className="ml-auto max-w-[90%] rounded-xl border border-[#e5e1f3] bg-[#f5f2ff] px-3.5 py-3 text-[13px] leading-6 text-[#51467c]">{message.content}</div>
                : <article key={`chat-${index}`} className="rounded-xl border border-[#e9e7ef] bg-[#faf9fe] p-4">
                  <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.1em] text-[#7166ab]">
                    {message.foundInTranscript ? <CheckCircle2 size={13} /> : <Sparkles size={13} />}
                    {message.foundInTranscript ? 'Lecture context used' : 'AI tutor answer'}
                  </div>
                  <p className="mt-2.5 whitespace-pre-wrap text-[13px] leading-6 text-[#5d596f]">{message.content}</p>
                </article>)}
              {ask.isPending && <div className="flex items-center gap-2 rounded-xl border border-[#e9e7ef] bg-[#faf9fe] px-4 py-3 text-[12px] text-[#77738c]" role="status"><LoaderCircle size={14} className="animate-spin" /> Thinking through your question…</div>}
            </div>}
          </div>
        </section>
        <footer className="mt-10 flex flex-col items-center justify-between gap-2 border-t border-[#ebe9f1] pt-5 text-[11px] text-[#a09cad] sm:flex-row"><span className="font-display font-bold tracking-[-.02em] text-[#716c83]">LectureLens</span><span>Make sense of what you heard. Remember what matters.</span></footer>
      </div>
    </main>
  );
}

function Router() {
  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
