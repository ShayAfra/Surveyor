# Surveyor MVP Decision Document

## 1. Product scope

### Decision

Surveyor is a focused job search utility for an individual user. The user provides a target role, chooses whether to include adjacent roles, and provides a short list of companies to check. The system then attempts to find role matches on those companies’ official careers surfaces and classifies each company into one of three user facing result buckets.

This product is not a broad market intelligence platform, not a web scale crawler, and not a continuous monitoring system in the MVP.

### Explanation

The MVP is intentionally narrow. The goal is to solve one concrete problem well, which is helping a job seeker quickly check a small set of companies for relevant openings in a trustworthy way.

Keeping the product narrow gives you:

- a realistic build scope
- a simpler legal and operational posture
- more auditable outcomes
- less product drift during implementation

---

## 2. User input contract

### Decision

The MVP accepts exactly these primary inputs for a run:

- a raw role string
- an include adjacent roles toggle
- an ordered company list

The company list is capped at 10 companies per run.

Display order must be preserved exactly as entered by the user.

---

## 3. Role interpretation and matching boundary

### Decision

The LLM is used once per run to generate a structured role specification from the raw role input and the adjacent roles toggle.

All actual job matching after role specification generation must be deterministic.

### Explanation

Matching must be implemented using string normalization, inclusion lists, exclusion lists, and simple token or phrase rules. No probabilistic or model based evaluation is allowed.

---

## 4. Allowed sources and discovery policy

### Decision

Only official company careers surfaces and associated ATS systems are allowed.

Job boards are not authoritative sources.

---

## 5. Result buckets

### Decision

Each company must end in exactly one:

- MATCHES_FOUND
- NO_MATCH_SCAN_COMPLETED
- UNVERIFIED

---

### Persistence requirement

The system must persist:

- careers_url
- ats_type
- extractor_used
- listings_scanned
- pages_visited
- failure_code
- failure_reason

These fields are required for final states when available.

---

## 5A. Canonical persisted status values

Run statuses:

- CREATED
- READY
- RUNNING
- COMPLETED
- FAILED_ROLE_SPEC

Company statuses:

- PENDING
- IN_PROGRESS
- MATCHES_FOUND
- NO_MATCH_SCAN_COMPLETED
- UNVERIFIED
- CANCELLED

These are the only allowed persisted values.

---

## 6. Run ownership

API:

- creates run only

Worker:

- owns all transitions

---

## 7. Queue and concurrency model

### Decision

The database is the source of truth for work state.

Companies are claimed transactionally.

Concurrency is limited to 2.

### Additional requirement

Each claimed company must store a `worker_token` used to identify the worker instance that claimed the row. This is required for safe reclaim, debugging, and future multi-worker support.

---

## 8. Role spec generation safety

### Decision

Role spec generation must be:

- exactly once per run
- restart safe
- timeout recoverable

### Additional requirement

The system must persist a `role_spec_started_at` timestamp.

This field is used to:

- prevent duplicate role spec generation
- allow reclaim if generation stalls
- enforce timeout-based retry safety

---

## 9. Failure handling

- company-level failures → UNVERIFIED
- role spec failure → entire run FAILED_ROLE_SPEC

---

## 10. Scan completion rule

If completion is uncertain → UNVERIFIED

Never downgrade uncertainty to NO_MATCH_SCAN_COMPLETED

---

## 11. Persistence model

SQLite is the source of truth.

Must persist:

- run state
- company state
- evidence fields
- failure fields

---

## 12. Logging and trace

Trace events must exist.

---

## 13. UI contract

UI renders backend state only.

---

## 14. Restart safety

Stale IN_PROGRESS must be reset to PENDING.

Stale role spec attempts must be reclaimable via role_spec_started_at.

---

## 15. Architecture

- Node backend
- React frontend
- SQLite

---

## 16. Non negotiable rules

- API creates only
- worker owns state
- deterministic matching only
- DB is source of truth
- UI never infers state
- no job boards
- 10 company cap
- concurrency limited
