# Surveyor Agent Expansion Implementation Context

## Status

This document is the active implementation context for Surveyor's Agent Expansion phase.

The Pre-Agent Expansion Readiness Pass is complete.

Completed foundation:

1. Core Scanner MVP
2. Scanner readiness audit
3. Scanner blocker fixes
4. Minimal job detail ingestion
5. Run-completion race fix for job details
6. Gate 4 final readiness verification

Surveyor is now allowed to move from Core Scanner work into Agent Expansion work.

This document does not replace the Core Scanner contract. It defines how to begin Agent Expansion without contaminating or weakening the scanner.

## Authority

For current scanner behavior, these remain authoritative:

1. `CLAUDE.md`
2. `operatingContext.md`
3. Current repository code

For completed readiness context:

1. `agentReadiness.md`

For broad future planning reference:

1. `agentExpansionRoadmap.md`

This file is the active execution context for the next meaningful milestones.

If this file conflicts with the Core Scanner contract, the Core Scanner contract wins.

If this file conflicts with the user's current explicit request, the user's current explicit request wins.

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

Surveyor moves in two layers.

### Layer 1: Core Scanner

The Core Scanner is the verification engine.

It answers:

Given this role and this short list of companies, can Surveyor check official company careers surfaces or clearly associated ATS systems and tell the user whether there are relevant openings, no relevant openings, or whether the scan could not be verified?

The scanner must remain:

1. Conservative
2. Deterministic after role spec generation
3. Evidence based
4. Source-authoritative
5. Traceable
6. Explicit about uncertainty

### Layer 2: Agent Workflow

The Agent Workflow is the action and preparation layer.

It answers:

Given who the user is, which verified opportunities are worth acting on, what is missing, and what truthful application materials should the user prepare?

The agent layer may eventually support:

1. Accounts
2. Private profile memory
3. Resume memory
4. Job fit analysis
5. Application packet generation
6. Saved companies and searches
7. Continuous monitoring
8. Application tracking

The agent layer must not change scanner truth.

## Non-negotiable scanner boundaries

Agent Expansion must preserve these rules:

1. The API creates scanner runs only.
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
18. Future agent features must not reinterpret scanner outcomes.

## Current scanner output contract

The scanner now produces durable evidence that future agent features can rely on:

1. `runs`
2. `run_companies`
3. `job_rows`
4. `job_details`
5. `trace_events`

For matched jobs, `job_details` stores either:

1. `description_text`
2. `failure_code` and `failure_reason`

A detail fetch failure is still useful evidence. It means the scanner found the job, but the detail layer could not fetch the full description.

Future agents should consume stored job detail evidence. They should not fetch job descriptions ad hoc unless a future milestone explicitly adds a retry or refresh feature.

A completed scanner run should not have matched `job_rows` missing corresponding `job_details` rows. A failed detail row counts as recorded evidence.

## Implementation philosophy

We should avoid fake tiny slices.

The goal is not to create busywork or placeholders that get replaced later.

The goal is to build minimum meaningful milestones.

A milestone is meaningful if, after completing it, Surveyor becomes more real as a product even if work stops there.

Good milestones:

1. Add a durable product layer.
2. Preserve scanner behavior.
3. Have clear acceptance criteria.
4. Are reviewable.
5. Create a stable foundation for the next milestone.
6. Reduce future rewrite risk.

Bad milestones:

1. Add placeholder tables nobody uses.
2. Add fake ownership that will be replaced.
3. Create scaffolding without product behavior.
4. Split work so small that implementation takes longer than the feature.
5. Build future abstractions before the product needs them.

Minimum meaningful does not mean giant. It means the milestone should ship a real foundation boundary rather than a throwaway intermediate step.

## Active milestone sequence

### Milestone 1: Accounts and Owned Scanner Data

Purpose:

Turn Surveyor from global scanner data into user-owned scanner data.

This is the next implementation milestone.

This milestone should be real enough to avoid fake local-owner drift, but narrow enough to avoid building profile, resume, packet, monitoring, or tracking features too early.

Includes:

1. User/account data model
2. Authentication/session decision appropriate for the project stage
3. `runs` owned by a user
4. Existing scanner runs migrated or backfilled safely
5. New scanner runs created under the current user
6. Run detail access scoped to the owning user
7. Job rows and job details accessible only through owned runs
8. Scanner worker behavior preserved
9. Existing scanner behavior preserved
10. Tests proving ownership and isolation

Excludes:

1. Resume upload
2. Profile memory
3. Application packet generation
4. Saved companies
5. Saved searches
6. Continuous monitoring
7. Application tracking
8. Referral intelligence
9. Dashboard redesign
10. Browser automation

Definition of done:

1. A user can own scanner runs.
2. User-scoped run creation works.
3. User-scoped run detail retrieval works.
4. Job detail endpoint access is scoped through the owning run.
5. One user cannot read another user's runs or job details.
6. Existing scanner worker behavior is unchanged.
7. Job detail ingestion still works.
8. Existing scanner tests pass.
9. New ownership/isolation tests pass.
10. No profile, resume, packet, monitoring, tracking, or referral features are added.

Important design decision:

Do not build a fake placeholder owner model unless full account implementation proves too large for this milestone.

The preferred direction is a real account and ownership foundation, scoped tightly to scanner data.

This milestone may be implemented through multiple commits if needed, but those commits should be part of one meaningful milestone and should not create unused scaffolding.

### Milestone 2: Profile and Resume Memory

Purpose:

Give Surveyor durable user context.

This milestone should happen after ownership exists because profile and resume data are personal.

Includes:

1. User profile storage
2. Resume text or resume document storage decision
3. Basic create/update/read behavior
4. Deletion/privacy considerations
5. Clear relationship to the owning user

Excludes:

1. Application packet generation
2. Resume tailoring
3. Cover letter drafting
4. Continuous monitoring
5. Application tracking

Definition of done:

1. A user can store profile/resume context.
2. The data is owned and isolated.
3. The data can be retrieved for future agent work.
4. No packet generation is added yet.
5. Deletion and privacy implications are understood even if full account deletion is deferred.

### Milestone 3: Job Fit and Job Understanding Layer

Purpose:

Connect user-owned profile/resume context to stored job detail evidence.

This milestone may be implemented as its own layer or folded into the Application Packet Agent if keeping it separate becomes unnecessary. Decide after Milestone 2, not before.

Includes:

1. Fit analysis for a selected matched job
2. Use of stored `job_details`, not ad hoc fetching
3. Use of user-owned profile/resume context
4. Strengths, gaps, risks, or fit notes
5. Evidence-linked output

Excludes:

1. Full application packets
2. Cover letters
3. Resume rewrites
4. Auto-apply behavior

Definition of done:

1. Surveyor can explain fit for a job using stored job detail and user context.
2. The analysis is owned by the user.
3. The analysis is traceable to source evidence.
4. The output does not invent user background.

### Milestone 4: Application Packet Agent

Purpose:

Generate truthful, user-reviewed application materials for a selected verified opportunity.

Includes:

1. Application packet entity
2. Link to owning user
3. Link to source job/detail evidence
4. Link to source profile/resume evidence
5. Generated materials such as summary, cover letter draft, or resume bullet suggestions
6. Evidence metadata
7. User review requirement

Excludes:

1. Automatic application submission
2. Recruiter outreach
3. Browser automation
4. Referral intelligence
5. Monitoring

Definition of done:

1. A user can generate an application packet for a verified matched job.
2. The packet is grounded in stored user and job evidence.
3. The packet is saved and reviewable.
4. The system does not submit anything automatically.
5. The system does not invent user experience.

### Milestone 5: Saved Companies and Saved Searches

Purpose:

Let users define ongoing targets and reusable search intent.

Includes:

1. Saved companies
2. Saved role/search preferences
3. Relationship to user ownership
4. Ability to initiate scanner runs from saved targets

Excludes:

1. Scheduled monitoring
2. Notifications
3. Application tracking
4. Referral intelligence

Definition of done:

1. A user can save companies/searches.
2. A user can reuse saved targets to start scanner runs.
3. Saved data is user-owned and isolated.
4. No background monitoring is added yet.

### Milestone 6: Continuous Monitoring

Purpose:

Run saved searches repeatedly and surface new verified matches.

Includes:

1. Scheduled or repeat scan mechanism
2. Saved search execution history
3. New match detection
4. Monitoring status/evidence
5. Notification-ready events, if needed

Excludes:

1. Auto-apply
2. Recruiter outreach
3. Referral intelligence
4. Social graph

Definition of done:

1. A saved search can run repeatedly.
2. Surveyor can identify new verified matches.
3. Monitoring results preserve scanner uncertainty rules.
4. The user remains in control of next actions.

### Milestone 7: Application Tracking

Purpose:

Track what the user did with verified opportunities and generated packets.

Includes:

1. Applications table/entity
2. User ownership
3. Link to job rows/job details
4. Link to generated packets when available
5. Status, notes, and dates

Excludes:

1. Automatic submission
2. Browser automation
3. Recruiter outreach
4. Referral intelligence

Definition of done:

1. A user can track application status for a job.
2. Tracking records are user-owned.
3. Tracking can link back to the verified opportunity and application packet.

## Parking lot: Referral Intelligence

Referral intelligence remains parked.

Do not implement:

1. Social graph
2. Mutual connections
3. Private contact input
4. Referral systems
5. Public profiles
6. Social feeds
7. Referral request automation
8. Recruiter outreach automation

Future-compatible choices are allowed only when they do not add referral behavior now.

Examples of acceptable future-compatible choices:

1. Keep companies normalizable later.
2. Keep applications tied to jobs and companies.
3. Keep accounts private by default.
4. Avoid schema choices that would make referral features impossible later.

## Infrastructure decisions for Milestone 1

Milestone 1 should begin with a short implementation design pass, not a broad strategy rewrite.

Decisions needed before coding:

1. Authentication approach
2. Session model
3. Whether SQLite remains acceptable for this milestone
4. Migration strategy for adding user ownership to existing data
5. Whether existing runs are backfilled to a default/admin/demo user
6. API scoping pattern for current user
7. Job detail endpoint scoping pattern
8. Test strategy for cross-user isolation
9. Local/demo versus deployable multi-user posture

These decisions should be made as part of Milestone 1, not as a separate fake milestone.

The design pass should return a recommendation, not multiple open-ended alternatives unless there is a real blocker.

## Recommended Milestone 1 implementation shape

The first implementation prompt should ask for a design plan before code.

It should inspect the current repo and propose the exact approach for:

1. User/account schema
2. Session/auth mechanism
3. `runs.user_id` ownership
4. Backfill behavior
5. API request ownership boundary
6. Run detail scoping
7. Job detail endpoint scoping
8. Worker compatibility
9. Tests

The implementation should remain narrow:

1. Account-owned scanner data only
2. No profile/resume memory
3. No application packet generation
4. No monitoring
5. No saved searches
6. No application tracking

## Risks and tradeoffs

### Risk: Over-building accounts

Building full SaaS-grade auth, billing-like account structure, team support, password reset flows, and complex settings now would slow the project down.

Mitigation:

Build only the account/session layer needed for owned scanner data.

### Risk: Under-building ownership

Adding a fake owner placeholder that is not enforced by APIs could create drift and future rewrites.

Mitigation:

Milestone 1 must include real ownership enforcement and isolation tests.

### Risk: Building profile/resume before ownership

Profile and resume data are private. Adding them before ownership risks awkward migration and privacy holes.

Mitigation:

Ownership comes first.

### Risk: Building packet generation before user context

Application packets need user evidence and job evidence. The scanner now provides job evidence, but user evidence does not exist yet.

Mitigation:

Build profile/resume memory before packet generation.

### Risk: Agent layer contaminates scanner truth

Future AI outputs could accidentally reinterpret scanner states or hide uncertainty.

Mitigation:

Agents may consume scanner evidence, but must not change scanner finalization rules or result buckets.

### Risk: Roadmap drift

A long roadmap can become another source of confusion if it conflicts with the active implementation context.

Mitigation:

Use this file as the active execution context. Use `agentExpansionRoadmap.md` as supporting reference only.

## What not to build next

Do not build these in Milestone 1:

1. Resume upload
2. Profile memory
3. Application packet generation
4. Saved companies
5. Saved searches
6. Continuous monitoring
7. Application tracking
8. Referral intelligence
9. Browser automation
10. Dashboard redesign
11. Parsed job requirements
12. Job detail summarization
13. Auto-apply
14. Recruiter outreach

## Next action

Next implementation milestone:

Milestone 1: Accounts and Owned Scanner Data

Before coding, request a narrow implementation plan for this milestone only.

The plan should not ask whether Agent Expansion is allowed. Gate 4 has passed.

The plan should decide how to implement account-owned scanner data while preserving scanner behavior.

The plan should treat Milestone 1 as one minimum meaningful product milestone, even if implementation is split into practical commits.
