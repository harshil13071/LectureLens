CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS rag_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id char(64) NOT NULL,
  source_key varchar(160) NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('note', 'document', 'flashcards', 'mindmap')),
  title varchar(200) NOT NULL,
  subject varchar(120),
  content_text text NOT NULL,
  content_sha256 char(64) NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
  error_code varchar(48),
  page_count integer,
  chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_key)
);

CREATE INDEX IF NOT EXISTS rag_documents_user_status_idx
  ON rag_documents (user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS rag_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id char(64) NOT NULL,
  document_id uuid NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  page_number integer CHECK (page_number IS NULL OR page_number > 0),
  section varchar(200),
  chunk_text text NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS rag_chunks_user_document_idx
  ON rag_chunks (user_id, document_id);

CREATE INDEX IF NOT EXISTS rag_chunks_embedding_hnsw_idx
  ON rag_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS rag_usage_limits (
  user_id char(64) NOT NULL,
  action varchar(24) NOT NULL,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (user_id, action)
);
