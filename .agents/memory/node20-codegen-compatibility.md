---
name: Node 20 codegen compatibility
description: Runtime compatibility issue encountered when regenerating OpenAPI client and Zod schemas.
---

The current Node 20 workspace runtime does not provide `Map.groupBy`, which the installed Orval Zod generator calls during API code generation. Generation completed with a temporary Node preload that polyfilled `Map.groupBy`; no app runtime or dependency versions needed changing.

**Why:** A normal `pnpm --filter @workspace/api-spec run codegen` failed after cleaning the Zod output directory, so generated API files must be restored through successful codegen before typechecking.

**How to apply:** Before future codegen, check whether the runtime now supports `Map.groupBy`; if it does not, use a temporary preload or deliberately fix/pin the generator compatibility. Do not leave partially cleaned generated files in place.
