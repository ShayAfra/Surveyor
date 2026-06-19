# Surveyor Agent Expansion Roadmap

## Document status

This document is a draft implementation roadmap for the Surveyor Agent Expansion phase.

This roadmap is not active until the Core Scanner readiness gate has passed.

The current Core Scanner documents remain authoritative until this roadmap is explicitly activated.

Current Core Scanner documents:

1. `CLAUDE.MD`
2. `operatingContext.md`

This roadmap must not be used to rewrite the Core Scanner. It exists so the next phase can begin without losing the intended product direction.

## CTO framing

Surveyor should not become an AI agent by making the scanner less deterministic.

Surveyor becomes an AI agent based project by adding an account based agent layer around a trusted scanner.

The scanner remains the verification engine.

The agent layer becomes the action engine.

The scanner answers:

```text
Are there verified relevant openings at these target companies?
```

The agent layer answers:

```text
Given who the user is, which openings are worth acting on, what is missing, and what application materials should the user prepare?
```

This distinction is important. The scanner should stay conservative and evidence based. The agent should use scanner output, job detail text, and user profile memory to create useful next actions.

## Purpose

The purpose of the Agent Expansion phase is to turn Surveyor from a verified job scanning tool into a private AI assisted job application workflow system.

The future product should help a user move through this path:

```text
Set up profile
Scan or monitor target companies
Review verified matched jobs
Understand fit and gaps
Generate application materials
Track application progress
```

The roadmap should support that path without turning Surveyor into a social network, a general job board, or an uncontrolled web crawler.

## Core principle

The Core Scanner remains the source of truth for job discovery confidence.

The Agent Expansion layer may interpret, summarize, compare, prioritize, draft, and recommend.

The Agent Expansion layer must not:

1. Change scanner finalization rules
2. Change scanner result buckets
3. Treat uncertain scans as verified opportunities
4. Invent user background
5. Submit applications automatically
6. Contact recruiters automatically
7. Build social networking features
8. Depend on future referral intelligence

The agent must be grounded in stored evidence.

Grounding sources include:

1. User provided resume text
2. User edited profile fields
3. User provided background notes
4. Stored job detail text
5. Scanner match evidence
6. User selected preferences

Unsupported claims must be marked as needing user confirmation instead of written as fact.

## What counts as agentic in this roadmap

A feature is not agentic just because it calls an LLM.

A Surveyor feature is agentic when it has most of these qualities:

1. It starts from a user goal.
2. It uses stored context about the user.
3. It uses tools or structured system data.
4. It performs multiple steps.
5. It records inputs and outputs.
6. It makes a recommendation or produces an action plan.
7. It preserves evidence and failure reasons.
8. It lets the user review the result before acting.

The Application Packet Agent and Continuous Monitoring Agent are the first true agent workflows in this roadmap.

The scanner itself should remain mostly deterministic. It does not need to be retrofitted into an open ended agent.

## Activation gate

Do not activate this roadmap until the following are true:

1. Discovery does not select unrelated or non authoritative pages.
2. Extraction completion is strict.
3. Uncertain scans become `UNVERIFIED`.
4. `NO_MATCH_SCAN_COMPLETED` only happens after confident completed extraction.
5. Runs and companies finalize reliably.
6. Trace events explain the scanner decision path.
7. Matched jobs can store or attempt to store full job description text.
8. Job detail failure does not change company final status.
9. No accounts, profile memory, monitoring, or application packet logic has been mixed into the scanner prematurely.

If any of these are not true, stop and finish scanner readiness first.

## Execution rules

These rules apply to every phase in this roadmap.

1. Execute one phase at a time.
2. Do not anticipate later phases.
3. Do not refactor unrelated code unless required for the current phase.
4. Each phase must leave the app runnable.
5. Each phase must preserve existing scanner behavior.
6. Do not let agent features change company finalization rules.
7. Do not let agent features change scanner result buckets.
8. Do not let LLM output decide scanner truth.
9. Persist agent inputs, outputs, and failure reasons when practical.
10. Prefer small durable data models over temporary in memory behavior.
11. Treat user profile data and resume data as private by default.
12. No social feed, public profile, mutual connection graph, or networking feature is included in this roadmap.
13. Future referral intelligence remains parked unless explicitly unparked later.
14. If a phase requires a new cross cutting infrastructure decision, write the decision first before implementing code.
15. If a phase creates user private data, add privacy and ownership checks in the same phase.

## Product boundary

This roadmap includes:

1. Infrastructure decisions for the account based agent product
2. Job detail storage for matched jobs
3. Database and ownership foundation for multi user data
4. User accounts
5. Resume and profile memory
6. Agent run persistence
7. Application packet generation
8. Saved companies
9. Saved searches
10. Continuous monitoring
11. Application tracking
12. Privacy and safety hardening

This roadmap does not include:

1. Public social profiles
2. Social media feed
3. Mutual connection graph
4. Automatic job application submission
5. Browser automation for filling application forms
6. Scraping private user accounts
7. Paid subscriptions
8. Team or enterprise features
9. Admin dashboard
10. Mobile app
11. Referral intelligence implementation

## Dependency map

The future features have real dependencies. They should not be built in random order.

### Application Packet Agent depends on

1. Job detail text
2. User accounts
3. User profile memory
4. Resume memory
5. Agent run persistence

### Continuous Monitoring Agent depends on

1. User accounts
2. Saved companies
3. Saved role targets or saved searches
4. Durable job identity or seen job records
5. Scanner reliability
6. Notification records

### Application tracking depends on

1. User accounts
2. Durable job records or job row references
3. Application packet records if packets can be attached

### Future referral intelligence depends on

1. User accounts
2. Normalized company entities
3. Application records tied to companies
4. A separate future privacy and relationship model

Referral intelligence must not influence current implementation beyond avoiding schema choices that make normalized companies impossible later.

## Target architecture after Agent Expansion

The intended architecture after this roadmap is complete:

1. React remains the main frontend.
2. Node remains the main backend application server.
3. The scanner pipeline remains a separate service layer inside the backend or a separable worker later.
4. User accounts own private user data.
5. User profile and resume memory are stored separately from scanner runs.
6. Jobs become durable enough to support saved jobs, application packets, application tracking, and monitoring.
7. Agent runs are persisted with source inputs and generated outputs.
8. Monitoring runs as scheduled backend work, not as a UI only feature.
9. Notifications begin as in app records and may later become email notifications.
10. Referral intelligence remains architecturally possible but not implemented.

# Phase 0: Infrastructure decision layer

## Goal

Create the infrastructure decisions that must be settled before accounts, profile memory, and agent workflows are implemented.

This phase is mostly documentation and architecture validation. It should not create a major code rewrite.

## Why this phase exists

The next features require persistent user memory. That changes Surveyor from a scanner into a personal application system.

Before writing account code, the project needs decisions about database direction, auth approach, resume storage, agent run persistence, background jobs, and privacy expectations.

## Required decisions

### Decision 0.1: Database direction

Decide whether the Agent Expansion phase will remain on SQLite temporarily or move to Postgres before accounts and profile memory.

Recommended decision:

```text
Keep SQLite for the Core Scanner MVP.
Move to Postgres before or during the account and profile memory foundation.
```

Reason:

Accounts, saved jobs, job details, application packets, monitoring, and application tracking create a real relational product. Postgres is the better long term foundation for that data model.

### Decision 0.2: Migration timing

Decide when the database migration happens.

Recommended decision:

```text
Do not build a full account based product on top of throwaway SQLite tables if the known target is Postgres.
Choose either:
1. Stay SQLite for a local portfolio demo and explicitly accept that migration comes later.
2. Move to Postgres before implementing accounts and profile memory.
```

The project should not accidentally build accounts, profiles, resumes, packets, saved jobs, and monitoring on a database foundation that must immediately be replaced.

### Decision 0.3: Auth approach

Decide the first account system.

Recommended options:

1. Email and password with secure password hashing
2. OAuth through a trusted provider
3. Hosted auth provider if speed matters more than control

The account system should be boring. Do not build social identity, public profiles, mutual connections, or networking features in this phase.

### Decision 0.4: Resume storage approach

Decide how resume files and extracted resume text are stored.

Recommended decision:

```text
Store file metadata in the database.
Store resume files in object storage when deploying beyond local development.
Store extracted resume text in the database for agent use.
Store structured profile fields separately from raw resume text.
```

Reason:

The agent should not repeatedly parse a resume file every time it runs. It should use extracted text and structured profile memory.

### Decision 0.5: Agent run persistence

Decide how agent executions are stored.

Recommended decision:

```text
Every application packet generation should create an agent_run record.
Important agent steps should be persisted as agent_step records.
```

Reason:

This is what makes the project a real agent workflow instead of a one time LLM text generator.

### Decision 0.6: Background job path

Decide how monitoring will run later.

Recommended decision:

```text
Keep the current in process worker for the scanner while the app is local and simple.
Introduce a real background job system before continuous monitoring becomes active.
```

Reason:

Monitoring needs scheduled work, retry behavior, and notification generation. It should not depend on a user keeping a browser open.

### Decision 0.7: Private data logging policy

Decide what private content must not go into ordinary logs.

Recommended decision:

```text
Do not log full resume text, profile notes, generated cover letters, generated packets, or user private background into general server logs.
```

Agent workflow persistence should be user scoped. General debug logs should not become a private data leak.

## Deliverable

Create a document named:

```text
Surveyor Infrastructure Decisions.md
```

The document must include:

1. Current scanner infrastructure
2. Future account requirements
3. Database decision
4. Migration timing decision
5. Auth decision
6. Resume storage decision
7. Agent run persistence decision
8. Monitoring worker decision
9. Private data logging policy
10. Deferred decisions
11. Migration path
12. Non goals

## Exit criteria

This phase is complete when:

1. The infrastructure decision document exists.
2. It does not conflict with the Core Scanner MVP docs.
3. It clearly says whether accounts will start on SQLite or Postgres.
4. It clearly says how resume files and extracted resume text will be stored.
5. It clearly says how agent runs will be persisted.
6. It keeps referral intelligence parked.

# Phase 1: Scanner to agent data bridge

## Goal

Confirm that matched jobs can store full job description text or a recorded fetch failure.

This phase may already be complete if the pre agent readiness pass added job detail ingestion.

## Why this phase exists

The Application Packet Agent cannot do useful fit analysis from only title, location, URL, and match reason.

It needs the full job description or a clear failure reason explaining why the description could not be fetched.

## Required behavior

1. Matched jobs should have a detail ingestion attempt.
2. Successful detail fetches should store normalized description text.
3. Failed detail fetches should store failure code and failure reason.
4. Job detail failure must not change company status.
5. Company finalization must remain scanner owned.
6. Job detail ingestion must not use the LLM.
7. Job detail ingestion must not create application packets.
8. Job detail ingestion must not run inside the company finalization transaction.

## Data model

If not already implemented, add a table similar to:

```text
job_details
```

Required fields:

1. `id`
2. `run_id`
3. `company_id`
4. `job_row_id`
5. `job_url`
6. `description_text`
7. `fetched_at`
8. `failure_code`
9. `failure_reason`
10. `created_at`

There should be at most one detail row per `job_row_id`.

## Implementation notes

The first implementation can be HTTP only.

Do not add Playwright detail fetching unless the scanner already has a clean pattern for it and it can be done without broad refactoring.

Do not block scanner finalization on job detail fetching.

## Exit criteria

This phase is complete when:

1. A matched job can have stored detail text.
2. A failed detail fetch records failure fields.
3. Existing scanner results still render.
4. Existing CSV export still works or is intentionally unchanged.
5. No account, profile, or application agent feature is introduced.

# Phase 2: Data platform and ownership foundation

## Goal

Prepare the backend for user owned private data before implementing accounts, resumes, profiles, application packets, saved companies, monitoring, or application tracking.

## Why this phase exists

Accounts are not just a login screen. Once accounts exist, most future records must belong to a user.

The project needs a clean ownership pattern before private user data appears.

This phase prevents the app from growing a scattered set of tables where some records are user scoped, some are global by accident, and some cannot be safely protected.

## Required decisions from Phase 0

Before this phase starts, Phase 0 must answer:

1. Will the account based app use SQLite temporarily or Postgres now?
2. What migration system will be used?
3. What auth approach will be used?
4. How will private data be logged safely?

## Required implementation areas

### Area 2.1: Migration system

The app needs a repeatable migration pattern.

Requirements:

1. Schema changes must be versioned.
2. Migrations must run predictably in local development.
3. Existing scanner tables must not be silently broken.
4. The project should be able to add account and profile tables without manual database editing.

### Area 2.2: User ownership convention

Define the convention for user owned records.

Future user owned records should include `user_id` unless there is a deliberate reason not to.

Examples:

1. Resumes belong to a user.
2. Profiles belong to a user.
3. Saved companies belong to a user.
4. Saved searches belong to a user.
5. Application packets belong to a user.
6. Applications belong to a user.
7. Notifications belong to a user.
8. Monitoring settings belong to a user.

Scanner runs may temporarily remain anonymous, but authenticated scanner runs should eventually be attachable to a user.

### Area 2.3: Company normalization direction

Do not fully build referral intelligence.

Do begin moving toward normalized company entities when it helps monitoring and job deduping.

Future compatible concepts:

1. `companies`
2. `company_aliases`
3. `company_domains`
4. `company_careers_surfaces`
5. `job_posts`

The first slice does not need all of these. The important rule is to avoid assuming company names will remain raw strings forever.

### Area 2.4: Private data access pattern

Protected endpoints must filter by the current authenticated user.

No future route should return another user's profile, resume, packets, saved jobs, applications, notifications, or monitoring settings.

## Exit criteria

This phase is complete when:

1. The database direction from Phase 0 has been implemented or explicitly deferred.
2. The migration system is clear.
3. The codebase has a clear user ownership convention.
4. Future private tables have an obvious `user_id` pattern.
5. The scanner still works.
6. No public profile, social feature, or referral feature has been added.

# Phase 3: User accounts

## Goal

Add private user accounts so future resume memory, saved jobs, application packets, and monitoring belong to a user.

## Why this phase exists

The current scanner can be accountless because each run is self contained.

The agent expansion cannot stay accountless because the app needs to remember who the user is and what they are trying to do.

Accounts are needed for:

1. Resume memory
2. Background information
3. Target role preferences
4. Saved companies
5. Saved jobs
6. Application packets
7. Application tracking
8. Monitoring preferences
9. In app notifications

## Scope

This phase should create only the minimum account foundation.

It should not create public profiles, connection requests, social search, feeds, endorsements, messaging, or referral intelligence.

## Required data model

Create a user model with fields similar to:

1. `id`
2. `email`
3. `password_hash` if using email and password
4. `created_at`
5. `updated_at`
6. `last_login_at`

Optional fields if simple:

1. `display_name`
2. `timezone`

Do not store sensitive resume or profile data directly on the users table.

## Required backend behavior

1. A user can create an account.
2. A user can log in.
3. A user can log out.
4. Authenticated routes can identify the current user.
5. Private user data cannot be read by another user.
6. Existing scanner behavior continues to work.

## Scanner integration

Decide whether scanner runs are still allowed without login.

Recommended first decision:

```text
Allow anonymous scanner runs temporarily.
Require login for saved profile, saved jobs, application packets, and monitoring.
```

Reason:

This preserves the current MVP while allowing the agent layer to use accounts.

## Exit criteria

This phase is complete when:

1. Users can sign up.
2. Users can log in.
3. Users can log out.
4. Auth state is available to the frontend.
5. Protected backend routes are possible.
6. Existing scanner runs still work.
7. No profile memory or application agent has been added yet.

# Phase 4: User profile and resume memory

## Goal

Create a private user profile that stores the information the agent needs to evaluate jobs and prepare truthful application materials.

## Why this phase exists

The application agent needs persistent user context.

Without profile memory, the user must repeatedly paste their resume, background, target roles, and preferences. That makes the agent feel like a generic one time tool instead of a personal workflow system.

## Profile principles

1. The user owns the profile.
2. Profile data is private by default.
3. The agent may use profile data only for user facing application assistance.
4. The profile should distinguish raw evidence from generated interpretation.
5. The agent must not invent facts that are not supported by user provided data.
6. The user should be able to edit profile information.

## Required data areas

The profile system should support:

1. Resume text
2. Work history
3. Projects
4. Skills
5. Education
6. Certifications if provided
7. Target roles
8. Preferred locations
9. Remote or hybrid preference
10. Seniority target
11. Industries of interest
12. Dealbreakers
13. General background notes

## Resume storage

The system should support at least one resume record per user.

Resume records should include:

1. `id`
2. `user_id`
3. `resume_name`
4. `source_type`
5. `raw_text`
6. `file_storage_key` if files are supported
7. `created_at`
8. `updated_at`

The first slice may allow the user to paste resume text instead of uploading a file.

## Structured profile memory

Create structured tables or fields for:

1. Skills
2. Projects
3. Work experiences
4. Education
5. Preferences

The first implementation can be simple. It does not need a perfect resume parser.

## Evidence model

The system should preserve where profile claims came from when practical.

Examples:

1. Skill came from resume text.
2. Project came from user edited profile field.
3. Preference came from onboarding answers.
4. Background note came from chat or manual entry.

The agent should be able to distinguish supported facts from unsupported suggestions.

## Agent safety requirement

Every generated application suggestion should be grounded in one of these sources:

1. Resume text
2. User edited profile field
3. User provided background note
4. Job description text
5. Scanner evidence

If the agent wants to make a claim that is not grounded, it should mark it as needing user confirmation.

## Exit criteria

This phase is complete when:

1. A logged in user can create or update profile information.
2. A logged in user can save resume text or a resume record.
3. Profile data is private to the user.
4. The backend can retrieve the profile for future agent workflows.
5. The profile model is good enough to support application packet generation.
6. No application packet agent has been added yet unless explicitly starting Phase 6.

# Phase 5: Agent run foundation

## Goal

Create the persistence layer for AI agent workflows before adding the Application Packet Agent.

## Why this phase exists

A serious AI agent project should not hide its workflow inside one LLM call.

The system should record what the agent was asked to do, what inputs it used, what steps it performed, what outputs it produced, and what failed.

This makes the project easier to debug, safer to explain, and stronger as a portfolio project.

## Required data model

Create an `agent_runs` table or equivalent model.

Suggested fields:

1. `id`
2. `user_id`
3. `agent_type`
4. `status`
5. `source_job_row_id`
6. `source_job_detail_id`
7. `source_resume_id`
8. `started_at`
9. `finished_at`
10. `error_code`
11. `error_message`
12. `created_at`

Create an `agent_steps` table or equivalent model.

Suggested fields:

1. `id`
2. `agent_run_id`
3. `step_index`
4. `step_type`
5. `status`
6. `input_json`
7. `output_json`
8. `error_code`
9. `error_message`
10. `created_at`

## Required agent statuses

Use a small set of statuses.

Suggested values:

1. `CREATED`
2. `RUNNING`
3. `COMPLETED`
4. `FAILED`

Do not reuse scanner company statuses for agent runs.

## Required step types

For the Application Packet Agent, likely step types are:

1. `LOAD_USER_PROFILE`
2. `LOAD_JOB_DETAIL`
3. `EXTRACT_JOB_REQUIREMENTS`
4. `COMPARE_PROFILE_TO_JOB`
5. `IDENTIFY_GAPS`
6. `GENERATE_RESUME_SUGGESTIONS`
7. `GENERATE_COVER_LETTER`
8. `GENERATE_OUTREACH_MESSAGE`
9. `BUILD_APPLICATION_CHECKLIST`
10. `FINALIZE_PACKET`

These do not all need to be implemented in this phase. The schema should be ready to record them.

## Exit criteria

This phase is complete when:

1. Agent runs can be created and persisted.
2. Agent steps can be persisted in order.
3. Failures can be recorded.
4. The data model is separate from scanner traces.
5. No application packet generation is required yet.

# Phase 6: Application Packet Agent

## Goal

Build the first true AI agent workflow in Surveyor.

The Application Packet Agent should help a user act on a matched job by comparing the job description against the user profile and generating grounded application materials.

## Why this phase exists

This is the clearest agent feature for Surveyor.

The scanner finds verified opportunities.

The profile tells the system who the user is.

The job detail tells the system what the role requires.

The agent creates useful next actions.

## Inputs

The agent should use:

1. User profile
2. Resume text
3. Job detail text
4. Job title
5. Company name
6. Job location
7. Job URL
8. Scanner match reason
9. User target role preferences if available

## Outputs

The agent should create an application packet with:

1. Fit summary
2. Matched qualifications
3. Missing or weak areas
4. Resume bullet suggestions
5. Cover letter draft
6. Recruiter or hiring manager message draft
7. Application checklist
8. User confirmation notes for unsupported claims

## Data model

Create an `application_packets` table or equivalent model.

Suggested fields:

1. `id`
2. `user_id`
3. `agent_run_id`
4. `job_row_id`
5. `job_detail_id`
6. `resume_id`
7. `fit_summary`
8. `matched_qualifications_json`
9. `gaps_json`
10. `resume_suggestions_json`
11. `cover_letter_text`
12. `outreach_message_text`
13. `checklist_json`
14. `unsupported_claims_json`
15. `created_at`
16. `updated_at`

## Agent workflow

The first version should follow this workflow:

1. Load the user profile.
2. Load the selected job detail.
3. Extract the job requirements from the job description.
4. Compare job requirements against the user profile.
5. Identify strong matches.
6. Identify gaps or weak areas.
7. Generate resume bullet suggestions grounded in the user profile.
8. Generate a cover letter draft grounded in the user profile.
9. Generate an outreach message draft if appropriate.
10. Generate an application checklist.
11. Persist the packet.
12. Show the packet to the user for review.

## Hard rules

1. The agent must not invent work history.
2. The agent must not invent education.
3. The agent must not invent skills.
4. The agent must not claim the user has credentials unless the profile supports it.
5. Unsupported suggestions must be marked as needing user confirmation.
6. The user must review application materials before using them.
7. The agent must not submit applications.
8. The agent must not contact recruiters automatically.
9. The agent must not modify the scanner result.
10. The agent must not hide unverified scanner status.

## UI requirements

The UI should show:

1. Selected job
2. Fit summary
3. Matched qualifications
4. Gaps
5. Resume suggestions
6. Cover letter draft
7. Outreach message draft
8. Checklist
9. Unsupported claims or confirmation needed section

## Exit criteria

This phase is complete when:

1. A logged in user can generate an application packet for a matched job.
2. The packet uses stored profile data and stored job detail text.
3. The agent run and important steps are persisted.
4. The generated materials are stored.
5. The agent flags unsupported claims.
6. The UI lets the user review the packet.
7. No auto apply behavior exists.

# Phase 7: Saved companies and saved searches

## Goal

Allow users to save companies and role targets so Surveyor can later monitor them.

## Why this phase exists

Continuous monitoring requires persistent targets.

The system needs to know which companies and roles the user cares about before it can check them repeatedly.

## Required concepts

Saved companies should include:

1. User
2. Company name
3. Normalized company identity when available
4. Careers URL if known
5. Notes if needed
6. Active or inactive status
7. Created timestamp

Saved searches should include:

1. User
2. Raw role
3. Include adjacent setting
4. Target locations if supported
5. Remote preference if supported
6. Active or inactive status
7. Created timestamp

## Company normalization

This phase should begin moving toward companies as real entities.

Suggested future model:

1. `companies`
2. `company_aliases`
3. `company_domains`
4. `company_careers_surfaces`
5. `saved_companies`

The first implementation can be simpler, but do not assume company strings will remain raw forever.

## Required behavior

1. A user can save a company.
2. A user can remove or deactivate a saved company.
3. A user can save a target role or search.
4. A user can run the scanner from saved companies.
5. Saved companies are private to the user.

## Exit criteria

This phase is complete when:

1. A user can save companies.
2. A user can save role targets.
3. A user can start a scanner run from saved companies and a saved role target.
4. Saved data is private to the user.
5. No continuous monitoring is running yet unless Phase 8 has started.

# Phase 8: Continuous Monitoring Agent

## Goal

Create a monitoring workflow that checks saved companies for relevant new roles and alerts the user when something worth acting on appears.

## Why this phase exists

The long term value of Surveyor is not only running one scan manually.

The stronger agent workflow is:

```text
Watch these companies for me.
Tell me when something worth applying to appears.
Explain why it matters.
Offer to prepare an application packet.
```

## Required inputs

The monitoring agent should use:

1. Saved companies
2. Saved role targets
3. User profile
4. Existing scanner pipeline
5. Previously seen jobs
6. Existing saved jobs
7. Existing application history

## Required outputs

The monitoring agent should produce:

1. Newly seen relevant jobs
2. Changed jobs if tracked
3. Jobs that are no longer visible if tracked
4. Recommendation summary
5. Fit explanation
6. In app notification
7. Option to generate an application packet

## Required data model

Suggested models:

1. `monitoring_runs`
2. `monitoring_run_companies`
3. `seen_jobs`
4. `job_post_snapshots`
5. `notifications`

The exact schema can be decided during implementation, but the system must be able to answer:

1. Has this job been seen before?
2. Is this job new for this user?
3. Is this job relevant to the user's saved role target?
4. Has the user already applied?
5. Has the user ignored this job?
6. Should the user be notified?

## Monitoring rules

1. Monitoring must be opt in.
2. Monitoring must be tied to saved companies or saved searches.
3. Monitoring must not spam the user with weak matches.
4. Monitoring must preserve scanner conservatism.
5. Unverified companies should be reported as unverified, not silently treated as no match.
6. Monitoring should not run endlessly or aggressively scrape sites.
7. The user should be able to pause monitoring.
8. Monitoring should have a clear schedule and should not depend on the browser being open.

## Notification behavior

Start with in app notifications.

Email notifications can come later.

An in app notification should include:

1. Company
2. Job title
3. Location
4. Why it matched
5. Confidence or verification status
6. Link to job
7. Action to generate application packet

## Exit criteria

This phase is complete when:

1. A user can enable monitoring for saved companies and role targets.
2. The system can run scheduled checks.
3. Newly found relevant jobs are recorded.
4. The user receives an in app notification.
5. The notification can lead to application packet generation.
6. Monitoring does not weaken scanner finalization rules.

# Phase 9: Application tracking

## Goal

Allow users to track what they did with jobs discovered by Surveyor.

## Why this phase exists

Once Surveyor helps users find jobs and generate packets, it should also help them avoid losing track of applications.

Application tracking also improves monitoring because the system can avoid repeatedly recommending jobs the user already applied to or rejected.

## Required statuses

Suggested application statuses:

1. `INTERESTED`
2. `PACKET_GENERATED`
3. `APPLIED`
4. `INTERVIEWING`
5. `REJECTED`
6. `OFFER`
7. `CLOSED`
8. `IGNORED`

Do not reuse scanner company statuses here.

## Required data model

Create an `applications` table or equivalent model.

Suggested fields:

1. `id`
2. `user_id`
3. `job_row_id`
4. `job_detail_id`
5. `application_packet_id`
6. `company_name`
7. `job_title`
8. `job_url`
9. `status`
10. `notes`
11. `applied_at`
12. `created_at`
13. `updated_at`

## Required behavior

1. A user can save a matched job as an application target.
2. A user can update application status.
3. A user can attach a generated packet to an application.
4. A user can add private notes.
5. Monitoring can recognize jobs already tracked by the user.

## Exit criteria

This phase is complete when:

1. Users can track applications.
2. Users can update statuses.
3. Application packets can be associated with tracked applications.
4. Monitoring can avoid recommending jobs already tracked or ignored.

# Phase 10: Agent centered user experience

## Goal

Make the account based workflow understandable in the UI.

## Why this phase exists

After accounts, profiles, packets, saved companies, monitoring, and applications exist, the UI can become confusing unless the user has a clear path.

The product should feel like a guided job application workflow, not a pile of disconnected features.

## Required screens

Likely screens:

1. Profile
2. Resume memory
3. Scanner run
4. Saved companies
5. Saved searches
6. Matched jobs
7. Application packets
8. Applications tracker
9. Notifications

## UX principle

The main flow should be:

```text
Set up profile
Run or monitor target companies
Review matched jobs
Generate application packet
Track application
```

Do not turn the product into a social feed or general job board.

## Exit criteria

This phase is complete when the user can understand the product flow without reading implementation docs.

# Phase 11: Privacy, safety, and hardening

## Goal

Harden the app once it stores user resumes, profile memory, generated materials, and application history.

## Why this phase exists

The moment Surveyor stores resumes and background information, it becomes meaningfully more sensitive.

Privacy and safety cannot be treated as polish.

This phase is listed late because the full hardening pass happens after the private data surface is known, but privacy checks must still be included in every earlier phase that introduces private data.

## Required areas

1. User data isolation
2. Auth security
3. Secure password handling if applicable
4. Session security
5. Resume data access rules
6. Agent output disclaimers where needed
7. Deletion behavior
8. Export behavior if needed
9. Logging rules that avoid leaking resume content
10. Rate limits on expensive agent actions
11. Access checks for packets, applications, notifications, and saved searches

## Logging rule

Do not log full resume text, cover letters, private background notes, or generated application packets into general server logs.

Agent run persistence should store private outputs in user scoped database records, not broad debug logs.

## Exit criteria

This phase is complete when:

1. Private user data is isolated by user.
2. Sensitive content is not accidentally logged.
3. Users can control or delete core profile data if implemented.
4. Agent outputs remain reviewable before use.
5. Expensive agent actions have reasonable guardrails.

# Parking lot: Future referral intelligence

## Status

Referral intelligence is intentionally parked.

Do not build it in this roadmap.

## Why it is parked

Referral and connection features create major product complexity.

They introduce:

1. Privacy concerns
2. Trust concerns
3. Relationship visibility rules
4. Spam risk
5. Cold start problems
6. Product drift toward LinkedIn style social networking
7. More complex identity and permission systems

## What to preserve architecturally

Even though referral intelligence is parked, the architecture should avoid blocking it forever.

Helpful future compatible choices:

1. Companies should eventually become normalized entities.
2. Applications should be tied to companies and jobs.
3. User accounts should be private by default.
4. Public profiles should not be assumed.
5. Relationship data should not be required by the core product.

## Possible future version

A future version might say:

```text
You are applying to Company X.
Surveyor found possible relationship or referral context.
Do you want help drafting a message?
```

But the source of that context is undecided and should not be designed now.

Possible future sources could include:

1. User imported contacts
2. User provided contacts
3. External integrations
4. Mutual Surveyor users
5. Manual company notes

No source is approved in this roadmap.

# CTO risk register

## Risk 1: Product sprawl

Surveyor could accidentally become a job board, resume builder, CRM, LinkedIn clone, and monitoring product all at once.

Mitigation:

Build around one spine:

```text
Verified opportunities to grounded application action.
```

## Risk 2: Agent output becomes generic

The agent could become just another cover letter generator.

Mitigation:

Ground outputs in scanner evidence, job detail text, and user profile memory. Persist agent runs and steps.

## Risk 3: Scanner trust gets weakened

Future agent features could pressure the scanner to produce confident results even when extraction is uncertain.

Mitigation:

Keep scanner finalization rules separate and absolute. Agent features can explain uncertainty but cannot override it.

## Risk 4: Accounts arrive without data privacy discipline

Resume and background information are sensitive.

Mitigation:

Add user ownership checks, logging rules, and private data boundaries as soon as accounts and profile memory are introduced.

## Risk 5: Monitoring becomes noisy

A monitoring agent that alerts on weak matches will lose trust.

Mitigation:

Notify only on meaningful matches. Keep unverified results clearly labeled. Let users pause monitoring.

## Risk 6: Referral intelligence pulls the product off course

Connections and referral features can turn Surveyor into a social networking project.

Mitigation:

Keep referral intelligence parked. Normalize companies for future compatibility, but do not build relationship features now.

# Final definition of done for Agent Expansion

The Agent Expansion phase is complete when Surveyor can support this workflow:

1. A user creates an account.
2. A user stores resume and profile context.
3. Surveyor scans target companies for verified openings.
4. Surveyor stores job detail text for matched jobs when available.
5. The agent compares a matched job against the user's real background.
6. The agent identifies fit, gaps, and next steps.
7. The agent generates a reviewable application packet.
8. The user can save companies and searches.
9. The system can monitor saved companies for new relevant roles.
10. The user can track application progress.
11. The system remains conservative when scanner confidence is uncertain.
12. The agent does not invent user experience.
13. Referral intelligence remains parked unless explicitly activated in a later roadmap.
