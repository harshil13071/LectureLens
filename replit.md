# LectureLens

LectureLens turns pasted lecture transcripts into study notes and practice quizzes, and provides an AI tutor that can answer lecture-related or general questions.

## Run & Operate

- Install workspace dependencies with `pnpm install --frozen-lockfile`.
- Start the `artifacts/api-server: API Server` and `artifacts/lecture-lens: web` artifact workflows to run the full app.
- The API is routed under `/api`; the web app is served at `/`.
- `pnpm run typecheck` checks shared libraries and all workspace packages.
- Build the API with `pnpm --filter @workspace/api-server run build`.
- The Vite build needs `PORT` and `BASE_PATH` supplied by its artifact workflow.
- AI generation requires the server-side `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` secrets.

## Stack

- pnpm workspaces, Node.js, TypeScript
- Frontend: React, Vite, Tailwind CSS, TanStack Query
- API: Express 5, Zod
- AI provider: OpenRouter, called only from the API server
- API contracts and generated clients: OpenAPI and Orval

## Where things live

- `artifacts/lecture-lens/src/App.tsx` — workspace, notes, quiz, and AI tutor UI.
- `artifacts/lecture-lens/src/index.css` — visual theme and print styles.
- `artifacts/api-server/src/routes/lectureLens.ts` — generation and Ask endpoints.
- `artifacts/api-server/src/lib/lectureLensAi.ts` — server-side OpenRouter requests and provider error handling.
- `lib/api-spec/openapi.yaml` — API contract source of truth.
- `lib/api-client-react/` and `lib/api-zod/` — generated frontend hooks and server schemas.

## Architecture decisions

- Pasted transcripts are the only lecture source. A YouTube link is saved as reference only; the app does not retrieve its transcript.
- Ask treats the transcript as optional context and retains a bounded set of recent turns in the browser for follow-up questions.
- OpenRouter credentials and requests remain server-side. The app has no user accounts, database, or subscriptions.

## Pointers

- See `.agents/memory/lecture-lens-scope.md` for the product constraints.
- See the `pnpm-workspace` skill for workspace and code-generation conventions.
