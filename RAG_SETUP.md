# Private Study Library (RAG) setup

The private study library is an API feature backed by PostgreSQL and the `vector` extension. It uses the existing Node.js API and `pg` connection pool. Room materials remain separate from personal library documents.

## Server environment

Configure these values in the API server environment. Keep provider API keys on the server and out of `VITE_*` variables.

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Existing PostgreSQL connection used by the API. For Neon, use the pooled URL for the running app. |
| `GOOGLE_CLIENT_ID` | Yes | OAuth web client ID used to verify Google Identity Services ID tokens. |
| `EMBEDDING_API_KEY` | Yes | Credential for an OpenAI-compatible embeddings endpoint. |
| `EMBEDDING_API_BASE_URL` | No | Embedding API base ending before `/embeddings`; defaults to `https://api.openai.com/v1`. |
| `EMBEDDING_MODEL` | No | Embedding model; defaults to `text-embedding-3-small`. It must return 1,536-dimensional vectors. |
| `GROQ_API_KEY` | Yes for answers | Existing LectureLens AI key used to generate answers grounded in retrieved passages. |

Set `VITE_GOOGLE_CLIENT_ID` to the same web client ID for the frontend build. This client ID is public; API provider credentials are not. Add the deployed app origin and local development origin to the OAuth client's authorized JavaScript origins in Google Cloud Console.

## Database migration

Review [`lib/db/migrations/0001_user_scoped_rag.sql`](lib/db/migrations/0001_user_scoped_rag.sql) before applying it. It creates the `vector` extension and the `rag_documents`, `rag_chunks`, and `rag_usage_limits` tables and their indexes. It does not drop or rewrite existing tables.

Apply to a development or test database first. For Neon migrations, use a direct (unpooled) connection in `DATABASE_URL_UNPOOLED`; keep the pooled `DATABASE_URL` for the app. Run from the repository root:

```sh
DATABASE_URL="$DATABASE_URL_UNPOOLED" psql "$DATABASE_URL_UNPOOLED" -v ON_ERROR_STOP=1 -f lib/db/migrations/0001_user_scoped_rag.sql
```

Do not point this command at production until the SQL has been reviewed and the production migration has been explicitly approved. The `vector` extension must be available to the database role running the migration.

## Behavior and limits

- Ownership is derived from the verified Google `sub` claim; clients cannot choose an owner ID.
- Documents are limited to 250,000 extracted characters and 180 chunks. Uploads accept TXT, PDF, and DOCX files up to 15 MB.
- Embedding responses must contain exactly 1,536 finite values per input. Configure a compatible model or change the database vector dimension and API validation together in a reviewed migration.
- Retrieval and citation quotes are scoped to the signed-in user's selected documents and subject. Study Rooms data is not indexed automatically.
- Users explicitly choose when to save current material or import browser-stored flashcards and mind maps. Retrieved passages can be handed to the existing Practice, Flashcards, and Mind Maps tools.
- The API enforces per-user database-backed request limits: 30 ingestion attempts per hour and 12 retrieval/answer attempts per minute.
