---
name: LectureLens scope
description: User-stated constraints for LectureLens AI and product scope.
---

LectureLens uses pasted transcripts as its source. A YouTube URL is reference-only; never add automatic transcript retrieval. OpenRouter must use the server-side `OPENROUTER_API_KEY` and exact `OPENROUTER_MODEL`. Do not expose the key in browser code. Keep the app without accounts, a database, subscriptions, or a required paid AI service.

**Why:** The user explicitly set these constraints in the product brief.

**How to apply:** Preserve these limits in future LectureLens work; if AI settings are missing, explain the configuration requirement instead of faking a response.
