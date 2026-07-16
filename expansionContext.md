# Surveyor Agent Expansion Implementation Context

## Purpose

This document defines the durable product and implementation context for Surveyor's Agent Workflow.

The Pre-Agent Expansion Readiness Pass established that Agent Workflow development may proceed without replacing or weakening the Core Scanner contract. This is a durable product boundary, not a moving implementation checkpoint.

It is not a progress tracker.

It should not record:

1. Which milestone is currently active
2. Which milestones are complete
3. Which milestone comes next
4. Temporary implementation checkpoints
5. Task-specific instructions

Current implementation state should be determined from the repository code. Current work should be determined by the user's explicit request. Milestone sequencing and broader planning belong in `agentExpansionRoadmap.md`, while temporary checkpoints belong in implementation prompts or separate checkpoint notes.

This document does not replace the Core Scanner contract. It defines how Agent Workflow capabilities may be built around the scanner without contaminating or weakening it.

## Authority

For current Core Scanner behavior:

1. `CLAUDE.md`
2. `operatingContext.md`
3. Current repository code

For completed scanner readiness context:

1. `agentReadiness.md`

For durable Agent Workflow direction and boundaries:

1. This `expansionContext.md`

For broad future planning and sequencing:

1. `agentExpansionRoadmap.md`

The user's current explicit request overrides repository documentation when the request is unambiguous.

If this file conflicts with the Core Scanner contract, the Core Scanner contract wins.

The existence of a capability in this document or the roadmap does not authorize implementing or expanding it automatically. Product work must remain limited to the user's explicit request.

## Product direction

Surveyor is becoming a private AI-assisted job search workflow.

The long-term product spine is:

1. Verified opportunities
2. Grounded fit analysis
3. Truthful application materials
4. User-controlled next actions

Surveyor should not become:

1. A generic job board
2. A broad web crawler
3. An auto-apply bot
4. A recruiter outreach automation tool
5. A social graph or referral network
6. A product that hides uncertainty from the user

## Two-layer model

Surveyor has two layers.

### Layer 1: Core Scanner

The Core Scanner is the verification engine.

It answers:

Given this role and this short list of companies, can Surveyor check official company careers surfaces or clearly associated ATS systems and tell the user whether there are relevant openings, no relevant openings, or whether the scan could not be verified?

The scanner must remain:

1. Conservative
2. Deterministic after role spec generation
3. Evidence based
4. Source authoritative
5. Traceable
6. Explicit about uncertainty

### Layer 2: Agent Workflow

The Agent Workflow is the action and preparation layer.

It answers:

Given who the user is, which verified opportunities are worth acting on, what is missing, and what truthful application materials should the user prepare?

Agent Workflow capabilities may include:

1. Accounts and user ownership
2. Private profile and resume memory
3. Job fit and job understanding
4. Application packet generation
5. Saved companies and searches
6. Continuous monitoring
7. Application tracking

The Agent Workflow must consume scanner evidence without changing scanner truth.

## Non-negotiable scanner boundaries

Agent Workflow development must preserve these rules:

1. The scanner run creation API creates ordinary scanner runs only.
2. The worker owns scanner processing transitions after creation.
3. SQLite is currently the source of truth.
4. Backend persisted state is the source of truth for the UI.
5. Matching remains deterministic.
6. LLM use in the scanner remains limited to role spec generation.
7. Companies cannot process without valid `role_spec_json`.
8. Discovery accepts only official company careers surfaces or clearly associated ATS systems.
9. Job boards are not authoritative scanner sources.
10. Company lists remain capped at ten companies per run unless explicitly changed.
11. Company processing concurrency remains capped at two unless explicitly changed.
12. Once finalized, a company is never reprocessed for that run.
13. Uncertain scans become `UNVERIFIED`.
14. `NO_MATCH_SCAN_COMPLETED` is allowed only after confident completed extraction and zero matches.
15. Trace events must remain durable evidence.
16. Restart recovery must not touch final companies.
17. Job detail ingestion must not change company final status.
18. Agent Workflow features must not reinterpret scanner outcomes.

## Scanner evidence contract

The scanner produces durable evidence that Agent Workflow capabilities can rely on:

1. `runs`
2. `run_companies`
3. `job_rows`
4. `job_details`
5. `trace_events`

For matched jobs, `job_details` stores either:

1. `description_text`
2. `failure_code` and `failure_reason`

A detail fetch failure is still useful evidence. It means the scanner found the job, but the detail layer could not fetch the full description.

Agent Workflow features should consume stored job detail evidence. They should not fetch job descriptions ad hoc unless an explicitly requested feature adds a retry or refresh path.

A completed scanner run should not have matched `job_rows` missing corresponding `job_details` rows. A failed detail row counts as recorded evidence.

## Agent Workflow capability boundaries

### Accounts and ownership

User-specific scanner data and private workflow data must be owned and isolated.

Ownership enforcement must be real. Do not create fake placeholder ownership that is not enforced through storage and API access.

### Profile and resume memory

Profile and resume data are private user context.

Stored user context should remain user controlled, retrievable, editable, and deletable according to the product scope being implemented.

Do not treat vague model memory as a substitute for durable user-owned data.

### Job fit and job understanding

Fit analysis should use:

1. Stored scanner job evidence
2. User-owned profile and resume context
3. Evidence-linked reasoning

It must not invent user experience, qualifications, or job facts.

### Application preparation

Application materials should be:

1. Grounded in stored user evidence
2. Grounded in stored job evidence
3. Saved for user review
4. Truthful and user-controlled
5. Never submitted automatically

### Saved companies and searches

Saved targets should remain user owned and reusable.

Starting a scanner run from saved targets must create an ordinary scanner run and preserve all scanner rules.

Saving targets does not imply background monitoring.

### Continuous monitoring

Repeat scanning must remain a wrapper around ordinary scanner runs.

Monitoring must preserve scanner uncertainty, evidence, ownership, and finalization rules.

A monitoring layer must not create a second scanner truth model.

### Application tracking

Application tracking should link user actions back to verified opportunities and generated materials when available.

Tracking state is user workflow state. It must not modify scanner outcomes.

## Dependency principles

These are durable dependency rules, not milestone status:

1. User ownership should exist before storing private profile, resume, saved target, or application data.
2. Job fit analysis should rely on both stored job evidence and user context.
3. Application materials should rely on user evidence and job evidence.
4. Saved targets should exist before repeat monitoring depends on them.
5. Monitoring should execute ordinary scanner runs rather than bypassing the scanner.
6. Application tracking should link to durable jobs and generated materials where available.

## Implementation philosophy

Avoid fake tiny slices.

The goal is not to create busywork or placeholders that get replaced later.

The goal is to build minimum meaningful product boundaries.

A meaningful implementation slice:

1. Adds real product behavior
2. Preserves scanner behavior
3. Has clear acceptance criteria
4. Is reviewable
5. Creates a stable foundation
6. Reduces rewrite risk

Avoid:

1. Placeholder tables nobody uses
2. Fake ownership that will be replaced
3. Scaffolding without product behavior
4. Splitting work so narrowly that implementation becomes harder
5. Building abstractions before the product needs them
6. Expanding scope beyond the explicit request

Minimum meaningful does not mean giant. It means the work should create a real, usable boundary rather than a throwaway intermediate state.

## Privacy and grounding principles

1. Private user data must be scoped to its owner.
2. Generated outputs must be grounded in stored evidence.
3. Unsupported user claims must not be invented.
4. Scanner uncertainty must remain visible.
5. Generated materials require user review.
6. Agent outputs must not silently become scanner facts.
7. Trace and logging behavior must avoid unnecessarily exposing private user data.

## Referral intelligence parking lot

Referral intelligence remains outside the active product boundary unless explicitly requested.

Do not add by default:

1. Social graphs
2. Mutual connection discovery
3. Private contact ingestion
4. Referral request automation
5. Public profiles
6. Social feeds
7. Recruiter outreach automation

Future-compatible data choices are acceptable only when they do not add referral behavior or unnecessary complexity.

## How to use this document

Use this file to answer durable questions about:

1. The relationship between the Core Scanner and Agent Workflow
2. Scanner protections that expansion work must preserve
3. Evidence, ownership, privacy, and grounding expectations
4. Broad capability boundaries
5. Durable dependency principles

Do not use this file to determine:

1. The current implementation step
2. Completed milestone status
3. The next implementation task
4. Whether a planned capability already exists in code

For those questions:

1. Inspect the current repository code.
2. Read the user's explicit request.
3. Use `agentExpansionRoadmap.md` for broad planning.
4. Use a separate checkpoint or implementation prompt for temporary progress state.
