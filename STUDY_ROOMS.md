# Study Rooms setup

Study Rooms add three PostgreSQL tables: `study_rooms`, `study_room_members`, and `study_room_materials`. The API creates these tables and indexes on its first room request with `CREATE TABLE IF NOT EXISTS`; existing tables and app data are not altered. Room contents are stored as JSONB, and are returned only after the requesting signed guest session is confirmed as a room member. Invitation tokens are 256-bit random values; PostgreSQL stores only their SHA-256 hashes.

## Render API configuration

- `DATABASE_URL`: PostgreSQL connection string. Use a persistent PostgreSQL instance and a connection string reachable from Render.
- `ROOM_SESSION_SECRET`: random secret of at least 32 characters used to sign HTTP-only guest session cookies. If omitted, `SESSION_SECRET` is used. Use a separate secret from any unrelated session system.
- Existing `PORT` remains required. Existing AI keys remain server-side and are not used by room endpoints.

The browser sends only the signed room session cookie to the same-origin `/api` rewrite on Vercel. Choose a display name once per browser profile. It is a label, not a verified identity; clearing cookies creates a new guest identity. Members can share material explicitly by submitting it in a room. Personal browser notes are never copied automatically.

Room detail refreshes every 15 seconds; this is polling, not live presence or real-time collaboration. Removing a member also invalidates the active invite token; the owner can generate and share a fresh link afterward. Rate limits currently apply per IP and endpoint in each API process, so they reset on process restart and are not shared between multiple Render instances. If the service is scaled horizontally, replace this limiter with a shared store.

The first version stores shared notes, flashcards, mind maps, and quizzes as room-owned snapshots, because the existing personal study materials are held in browser state rather than in a server database. Flashcards, mind maps, and quizzes use JSON input; shared items can be viewed or copied from the room. The app does not yet link those snapshots back into the personal study tools.

## Local integration test

The database package currently has no application tables or migration files. Study Rooms creates only its own tables with idempotent DDL on the first request. Run integration tests only against a throwaway local PostgreSQL database; never point this test suite at the Render database.

Store `DATABASE_URL` and a random `ROOM_SESSION_SECRET` in the ignored `.env.test.local` file, then load it into the test process and run the API suite:

```sh
set -a
source .env.test.local
set +a
node artifacts/api-server/run-tests.mjs
```

The Study Rooms integration test is skipped when `DATABASE_URL` is absent. With a local database configured, it creates a room, joins another guest, shares a note, checks member and owner permissions, revokes the invite, removes the member, verifies access is denied, and deletes the test room.
