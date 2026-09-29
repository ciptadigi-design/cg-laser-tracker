# Phase 4 Acceptance Record — Firebase → Supabase Application Migration

**Implementation commit:** `82a93af97c6e5a01e839be0f1253c2d5ee9e7f7d` —
"feat: migrate laser tracker application to supabase"

**Supabase project:** `cg-laser-tracker` (ref `rnwsymwuktvtcpjtkvcx`, region
`ap-southeast-1`)

## Automated test results

- `npm test` — 26/26 passing (19 original CSV round-trip/validation tests +
  7 new: Supabase payload mapping, generated-column omission,
  `legacy_firebase_id` export mapping).
- `npm run lint` — clean, 0 errors (including the two pre-existing
  `set-state-in-effect` errors present at the Phase 4 baseline, resolved as
  part of the data-fetching rewrite).
- `npm run build` — succeeds.

## Owner-attested manual smoke test

Performed by the product owner directly in a running browser session
against the real Supabase project and the real admin account
(`ciptadigi@gmail.com`). This was **not** agent-executed browser
automation — no browser tooling was available to this session, and the
account password was never requested, seen, or handled by the agent.
The owner confirmed the following passed:

- Login with the real admin account
- Session persistence after browser refresh
- Create job
- Read / history
- Edit job
- Delete job
- Dashboard KPI calculations
- CSV fixture import
- CSV fixture export
- Logout

All temporary records created during the smoke test were deleted by the
owner as part of testing.

## Database / security verification (agent-run, live, read-only except where noted)

- `auth.users` = 1, `public.profiles` = 1 — exactly the one admin
  identity, no unexpected accounts.
- `ciptadigi@gmail.com` → `profiles.role = 'admin'`, account confirmed.
- RLS enabled on both `public.laser_jobs` and `public.profiles`; policy
  set unchanged from the Phase 3A/3C-audited matrix (verified against
  `pg_policy` directly, not re-derived from source).
- Anonymous access confirmed denied via live REST calls against the real
  anon key: SELECT returns zero rows, INSERT returns `42501` RLS
  violation, UPDATE/DELETE against a temporary probe row (inserted and
  removed via trusted SQL, not through the app) affected zero rows.
- No Firebase imports remain in active application code; the `firebase`
  package was removed from `package.json`.
- No hardcoded `ADMIN_PASSWORD` remains.
- No `service_role` key appears anywhere in frontend code (only
  cautionary comments referencing it by name).
- `.env.local` remains gitignored and was never committed; only
  `.env.example` (placeholders) is tracked.

## Final database state

`public.laser_jobs` = 0 rows. No Firebase production data was migrated or
modified at any point in this phase.

## Known limitation: CSV migration import atomicity

CSV migration writes go through `insertMigrationRows` in
`src/lib/laserJobs.js`. Each chunk of up to 500 rows is sent as one
`INSERT` statement, which is atomic on its own. A file that fits in a
single chunk is therefore fully atomic. A file spanning multiple chunks is
**not** atomic end-to-end — an earlier chunk can already be committed if a
later chunk fails. This is surfaced to the user in the import failure
message and documented in code; no database RPC for whole-file atomicity
was implemented in this phase.

## Production cutover status

**Not started.** This phase covers application implementation and
controlled testing only:

- No production CSV has been imported.
- No deployment has occurred.
- Firebase production data and security rules are untouched.
- The legacy repository has not been modified.
