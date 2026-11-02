# Particle POC: patient data pull, parse and store

This is a standalone NestJS proof of concept. It pulls a patient's records from Particle Health, parses them into elevAID's clinical model, and stores the result. Building it outside `redox-backend-nest` lets the flows be refined first. Afterwards the modules drop into the main app with minimal change.

It mirrors the main app's conventions:

- NestJS 11 with `@nestjs/axios` and `class-validator`.
- A `configuration.ts` block for settings.
- `{ detail, code }` errors and `[Prefix]` log lines.
- Jest specs that sit next to each service.

The parser emits the main app's `RedoxParsedData` shape from `src/types/clinical.types.ts`. That means Particle data can feed the existing dedupe → categorise → summarise pipeline without changes.

> **Sandbox only.** Local storage writes PHI to `./data` as plain JSON. `data/` is gitignored. The app refuses production calls unless `PARTICLE_ALLOW_PRODUCTION=true` is set.

## What it covers

| Flow | Where |
|---|---|
| Auth: `GET /auth` returns a plain-text JWT. The token is cached in memory and refreshed 10 minutes before expiry. On a 401 it is refreshed once. | `particle/particle-auth.service.ts` |
| HTTP: retries with backoff on network errors, 429 (honours `Retry-After`) and 5xx. Failures map to typed errors. Request bodies are never logged. | `particle/particle-http.service.ts` |
| Registration: `POST /api/v2/patients`, sending our elevAID UUID as `patient_id`. Detects Particle's "overlay" error. Stores a hash of the demographics. | `particle-records.service.ts` → `particle.service.ts` |
| Pull: `POST /api/v2/patients/{id}/query` → poll status → `GET /fhir` (FHIR R4 Bundle). The raw payload is saved. Particle's 48-hour re-query rule is enforced. | `particle-query-loop.service.ts` |
| Parsing: the FHIR Bundle → `RedoxParsedData` via a copy of the main app's `FhirParserService` (`src/services/`, delete on merge). Care transitions and AI outputs have no FHIR form, so Signal webhooks still fetch them from Flat. | `particle-records.service.ts`, `particle-flat-parser.service.ts` |
| Signal: monitoring subscription, signed CloudEvents webhook, dedupe on event `id`, alerts routed to the right tenant. Transition and AI-output alerts are enriched in the background. | `particle-webhook.service.ts` |
| Storage: a tenant-scoped `ParticleStore` interface. The POC implementation writes local JSON files and keeps an audit log. | `storage/` |

Not covered yet: C-CDA parsing (the client method exists and saves the raw ZIP), the bi-directional document upload, and the Deltas API.

## Query state machine

```
QUEUED ──submit──▶ SUBMITTED ──status COMPLETE|PARTIAL──▶ RETRIEVING ──▶ COMPLETE | NO_DATA
   │                  │ status FAILED ───────────────────────────────▶ FAILED
   │                  │ poll errors > budget ────────────────────────▶ STALLED
   │                  │ poll ceiling (30 min) → try retrieval anyway ▶ COMPLETE | STALLED
   └ Particle unavailable: retry with backoff (5 tries) → STALLED; 4xx → FAILED
```

- A query-complete webhook makes the row due immediately. Polling stays in place as the fallback.
- Particle documents two vocabularies for query status:
  - `state`: PENDING / PROCESSING / COMPLETE / PARTIAL / FAILED
  - `status`: SCHEDULED / RUNNING / COMPLETE / TIMEOUT

  `normaliseQueryStatus` accepts both.

## Run it

```bash
npm install
cp .env.example .env        # add sandbox credentials locally; never commit .env
npm test                    # 92 specs, no network
npm run start:dev           # http://localhost:8100
```

### Test page

Open `http://localhost:8100/`. It has a demographics form, prefilled with the sandbox test patient. Clicking **Register & pull records** does three things:

1. It registers the patient, then starts the pull.
2. It shows the query status as it changes.
3. When the query completes, it shows tables of the parsed problems, medications, labs, allergies, encounters, care transitions and AI outputs. The raw parsed JSON is in a collapsible section.

A fresh elevAID patient id is generated on each page load, so the 48h re-query guard does not block repeat tests.

The page is inline HTML in `src/ui/ui.controller.ts`. It has no build step, adds no dependencies, and is not merged into the main app. It works only while `PARTICLE_POC_API_KEY` is unset.

### Try the parser without credentials

You can post Particle's sample data from `particle-connect-main/.../sample-data/flat_data.json` to `POST /particle-records/ingest-flat`. Then read the result back from `GET .../parsed`. See `requests.http`.

### Full sandbox round trip

1. `POST /particle-records/patients` with the sandbox test patient. Use Elvira Valadez-Nucleus from the Postman collection. Set `subscribeMonitoring: true`.
2. `POST /particle-records/pull` with a `requestedBy` clinician id. Then poll `GET .../status` until it shows `COMPLETE`.
3. `GET .../parsed` returns the parsed clinical data plus the extras.
4. To test Signal:
   1. Expose `POST /particle-records/webhook` over HTTPS, for example with ngrok.
   2. Ask Particle to register that callback URL. They issue the signing key; put it in `PARTICLE_WEBHOOK_SIGNING_KEY`.
   3. Call `POST /particle-records/sandbox/trigger` with `ADMIT_TRANSITION_ALERT`, `DISCHARGE_TRANSITION_ALERT` or `AI_OUTPUTS`.

## HTTP API

All routes except `/webhook` and `/health` take `x-api-key` when `PARTICLE_POC_API_KEY` is set.

| Method | Path | Notes |
|---|---|---|
| POST | `/particle-records/patients` | Register or update a patient. Body: `practiceId`, `elevaidId`, `firstName`, `lastName`, `dob`, `genderAtBirth` (M/F), `address{lines,city,state,zip}`. Optional: `phone`, `email`, `subscribeMonitoring`, `requestedBy`. |
| POST | `/particle-records/pull` | Returns 202. Body: `practiceId`, `elevaidId`, `requestedBy` (required, for treatment attribution). Returns 409 `REQUERY_TOO_SOON` inside the 48h window. |
| GET | `/particle-records/practices/:practiceId/patients/:elevaidId/status` | Registration state, query state and parsed counts. No clinical data. |
| GET | `/particle-records/practices/:practiceId/patients/:elevaidId/parsed` | The parsed `RedoxParsedData` plus extras. Contains PHI. |
| GET | `/particle-records/practices/:practiceId/patients/:elevaidId/signal-events` | Stored webhook events. |
| DELETE | `/particle-records/practices/:practiceId/patients/:elevaidId/subscription` | Stop Signal monitoring. |
| POST | `/particle-records/ingest-flat` | Sandbox only. Parses and stores a Flat payload you already have. |
| POST | `/particle-records/sandbox/trigger` | Sandbox only. Fires a simulated Signal workflow. |
| POST | `/particle-records/webhook` | Particle callback, verified by HMAC over the raw body. |

## Merge plan into `redox-backend-nest`

| POC | Main app |
|---|---|
| `src/particle/*` | `src/particle/` as-is. Add `HttpModule` from the global import that already exists. |
| `src/particle-records/*` | `src/particle-records/`. Split the loop into `src/particle-dq-loop/` if you want it to mirror `metriport-dq-loop`. |
| `config/configuration.ts` `particle` block | Paste it next to the `metriport` block. |
| `types/clinical.types.ts` | Delete the POC copy. Add `PARTICLE = 'particle'` to the main app's `DataSource` enum. |
| `storage/FileParticleStore` | Replace with a `DatabaseService`-backed `ParticleStore`. Tables: `particle_patients`, `particle_query_loop`, `particle_parsed_records`, `particle_signal_events`, `particle_webhook_events`, `particle_audit_log`. Every one is keyed by `practice_id` + `elevaid_id`. |
| `persistParsed()` | Call `dedupService.process` and `buildDedupedForElevaid` here, the same way `ingestConsolidatedForPatient` does for Metriport. |
| `PocApiKeyGuard` | Use the main app's `ClinicalServiceApiKeyGuard`. |
| `main.ts` raw-body + `cloudevents+json` parser | Add the `type` and `verify` options to the existing `json()` call in the main app's `main.ts`. |
| Webhook background enrichment | Move it to a durable queue or a DB-backed retry. In the POC, a crash during enrichment loses that enrichment; the failure is logged with `[RECONCILIATION REQUIRED]`. |

Things in the main app this design deliberately fixes:

- `practice_id` is carried on every stored row. The Metriport path relies on the elevAID UUID alone.
- The webhook is always signature-verified when a key is set, and it is never forwarded unauthenticated.
- Webhook events are de-duplicated on the CloudEvent `id`.

## Open items to confirm with Particle

- **Subscription body shape.** The Postman collection sends `{subscriptions:[{particle_patient_id,type}]}`. The docs also show a bare `{type}`.
- **Webhook signature encoding.** We expect hex; base64 is also accepted until confirmed. Also confirm the header format during key rotation.
- **Flat filter syntax.** Bare flags (`?TRANSITIONS`) or `resource_type=`? The POC uses bare flags for datasets and `resource_type`/`resource_id` for single resources, which follows the Postman collection.
- **Allergy and procedure status.** Flat has no status column for either. The POC defaults allergies to active and procedures to completed when a date is present.
- **How production re-queries monitored patients**, and whether the query-complete webhook carries a `query_id` we can match.
- **Rate limits** for our project, and how long Flat data is retained on the v2 API.

## Compliance notes baked into the code

- Purpose of use is `TREATMENT` from config. Every pull requires a `requestedBy` clinician id.
- An append-only audit log records every register, submit, retrieve, subscribe and webhook action. Entries hold ids only, no clinical data.
- No PHI in logs: log lines carry ids and counts only, and upstream error bodies are never logged.
- Care-transition records drop Particle's demographic columns (minimum necessary).
- AI outputs carry `isAiGenerated: true` and their citations, so the UI can label them and require clinician review.
