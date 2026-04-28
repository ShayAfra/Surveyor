End to end run lifecycle for Surveyor MVP

What happens when the user clicks Run

When the user clicks Run, the web UI sends a single HTTP request to the backend to create a new run. This request contains the raw role string, the adjacent roles toggle value, and the company list exactly as entered by the user. The company list is sent as an ordered array. Display order must be preserved exactly as entered by the user, but processing order is not guaranteed because of concurrency.

The backend immediately validates the request. It rejects the request if the company count is greater than 10, if the role string is empty, or if the company list contains empty entries after trimming. If validation fails, the backend returns a 4xx response with a human readable error. No run is created.

If validation succeeds, the backend creates the run, persists it, and returns a run_id to the UI. The UI transitions into a run detail view keyed by that run_id and begins polling for updates.

What data is written immediately

Immediately after validation succeeds, before any LLM call or crawling begins, the backend writes the following records to SQLite in a single transaction.

A runs row is inserted with:

The run id  
The creation timestamp  
The raw role string  
The adjacent roles toggle boolean  
A run status of CREATED  
The company count  
role_spec_json set to null  
error_code set to null  
error_message set to null

A run_companies row is inserted for each company with:

The run id foreign key  
The company name as entered  
A normalized company name field used for deterministic logging and display if implemented  
An input_index field that preserves the original company order for display  
A company status of PENDING  
All discovery and scanning fields set to null or zero  
A created timestamp

This means that once the create request returns successfully, the database already contains a durable run record and durable per company records, even if the system crashes immediately afterward.

The POST /runs endpoint is responsible only for validation and durable creation. It does not call the LLM inline and it does not start scanning inline. Every successful POST creates a new run_id. There is no dedupe across runs in the MVP.

Authoritative ownership of run state transitions

The backend API owns only run creation.

POST /runs is allowed to:
Validate input  
Insert the run row in CREATED  
Insert company rows in PENDING  
Return run_id

The worker loop owns all run initialization and active processing transitions after creation.

The worker loop is responsible for:
CREATED to READY  
CREATED to FAILED_ROLE_SPEC  
READY to RUNNING  
RUNNING to COMPLETED

This ownership model is authoritative and must not be split between API handlers and worker logic.

Authoritative transition table

Run transitions

CREATED to READY when the worker successfully generates and validates role_spec_json  
CREATED to FAILED_ROLE_SPEC when the worker cannot generate or validate role_spec_json  
READY to RUNNING when the first eligible company is successfully claimed  
RUNNING to COMPLETED when all companies in the run are in a final state

Company transitions

PENDING to IN_PROGRESS when the worker transactionally claims the company  
PENDING to CANCELLED if role spec generation fails for the run  
IN_PROGRESS to MATCHES_FOUND after successful completed extraction and at least one deterministic match  
IN_PROGRESS to NO_MATCH_SCAN_COMPLETED after successful completed extraction and zero matches  
IN_PROGRESS to UNVERIFIED if discovery fails or extraction is incomplete or blocked or capped or unsupported

Once a company reaches a final state, it is never reprocessed for that run. Finalization must update the existing row only. Worker reclaim must never create duplicate company rows.

When the LLM is called and what happens if it fails

After the initial transaction commits, the worker loop is responsible for run initialization. It looks for runs in CREATED state that do not yet have a valid role_spec_json. For each such run, it calls the LLM exactly once per run to generate the structured role specification. This call happens before any company scanning begins, because the role spec is required to produce deterministic matching and consistent reasoning.

The call takes the raw role and the adjacent roles toggle as input. The LLM must return a strict JSON object conforming to the locked schema, including inclusion titles, exclusion titles, and seniority handling rules. The backend validates the output. Validation includes:

The JSON must parse  
All required keys must exist  
All arrays must be arrays of strings  
Strings must be non empty after trimming  
The object must not contain unexpected keys if strict mode is enabled

If the LLM call fails due to API error, timeout, or invalid JSON output, the run is not started. The worker marks the runs row as FAILED_ROLE_SPEC and writes an error_code and error_message. Every run_companies row for that run is marked CANCELLED with failure reason role spec generation failed. This is a hard stop because continuing would make outcomes inconsistent and harder to trust.

If the LLM succeeds, the worker writes the validated role_spec_json into the runs row, sets run status to READY, and emits a trace event indicating role spec generation succeeded.

Eligibility rule for company processing

A company is eligible to be claimed for processing only if all of the following are true:

The run status is READY or RUNNING  
The company status is PENDING  
The run has a valid role_spec_json

This rule is authoritative. A company that does not satisfy all three conditions must not be claimed.

How companies are queued and picked up

The system uses the database as the source of truth for work state. A company is considered queued when its run_companies.status is PENDING.

A worker loop runs continuously inside the backend process. It does not rely on in memory state to decide what to work on. Instead, on each iteration it queries SQLite for up to COMPANY_CONCURRENCY companies across all runs that are eligible to be processed.

When the worker selects a company to process, it claims the row in a transaction by updating:

Status from PENDING to IN_PROGRESS  
Started timestamp to now  
A worker token value used to detect stale work if needed

Because claiming happens transactionally, two workers cannot process the same company at the same time even if the system is later split into multiple worker processes.

When the first company in a run is successfully claimed, the worker sets that run status to RUNNING if it is not already RUNNING.

How discovery works

Discovery exists to determine the authoritative careers entry point on the company official domain. Discovery never uses third party job boards as sources. Discovery may use search results only as a method to locate the official careers entry point.

Discovery runs in a strict sequence and stops as soon as it finds a careers URL that is both plausible and allowed.

First, the system tries deterministic URL guesses on the official company domain. It attempts a small set of patterns, such as:

https://company.com/careers  
https://company.com/jobs  
https://company.com/careers jobs pages and localized variants if present

These are attempted with standard HTTP requests using strict timeouts.

If deterministic guesses fail, the system performs a search query using the company name and careers related keywords. The search output is used only to select a candidate careers URL. The system then applies the allowed sources rule. It only accepts results that are on the company official domain or on a supported ATS domain that is clearly associated with the company’s careers page. If the search results only return job boards or aggregators, discovery fails.

When discovery selects a careers URL, it writes that URL into run_companies.careers_url and emits a trace event containing the attempted URLs and the chosen URL.

If discovery cannot find an allowed careers URL, the company is finalized immediately as UNVERIFIED with failure code CAREERS_NOT_FOUND.

How platform detection works

Once a careers URL is established, the system fetches the careers page using HTTP and runs platform detection on the response.

Platform detection is deterministic. It does not use the LLM. It relies on a fixed set of signatures such as:

Known hostname patterns for supported ATS providers  
Known script URLs included in the page  
Known HTML structures and attributes  
Known URL path formats for job detail links

Platform detection returns one of:

GREENHOUSE  
LEVER  
ASHBY  
SMARTRECRUITERS  
UNKNOWN

The detected platform is written to run_companies.ats_type. The chosen extractor name is written to run_companies.extractor_used. A trace event is written explaining why the platform was detected.

If the platform is UNKNOWN, the system does not guess. It moves to a conservative generic HTTP extractor. If that cannot confidently extract listings, the company becomes UNVERIFIED.

How extraction works

Extraction is the step where the system enumerates job postings and collects structured fields. Extraction is performed by a platform specific extractor when available, otherwise by a generic extractor.

Every extractor returns the same normalized result object:

A list of job postings containing title, location text, and job URL  
Counts for pages visited and listings scanned  
A boolean completed indicating whether the scan completed without hitting caps or timing out  
A failure reason if completed is false

Extraction proceeds with strict limits:

Per company total time budget  
Maximum pagination depth  
Maximum listings scanned  
Per request timeout  
Per domain pacing

If the extractor hits pagination depth limit or listing cap before it can confidently assert it has scanned all available listings, it must set completed to false and include failure reason cap reached. This forces the company outcome to be UNVERIFIED later.

If the extractor encounters blocking signals such as CAPTCHA pages or access denied responses, it sets completed to false with failure code BLOCKED.

If HTTP extraction fails due to JavaScript rendered content, the system may invoke the Playwright fallback. Playwright is used only if:

The platform is supported but the HTTP extractor failed  
Or the platform is unknown but there is evidence listings exist and are JS rendered

Playwright fallback has its own strict time and page limits. If Playwright cannot finish within those limits, extraction returns completed false, which forces UNVERIFIED.

The extracted job list is not yet a match. It is simply the set of postings that were reachable and parseable.

How matching happens

Matching happens after extraction and is fully deterministic.

The system normalizes each job title by lowercasing, trimming, collapsing whitespace, and removing obvious punctuation variants. It then applies exclusions first. If the normalized title matches any exclusion phrase or exclusion token rule, the job is rejected.

If the title passes exclusion, the system checks inclusion. A job is considered a match if it meets the inclusion rule derived from the role spec. Inclusion rules are simple and explainable. They include exact phrase matches and token based matches.

Seniority is treated according to the role spec. By default, all seniorities are included. If the user specified a seniority constraint, the system rejects titles outside that constraint.

For every job processed, the system can produce a match reason. Match reason is a short deterministic statement such as:

Matched inclusion phrase full stack engineer  
Rejected due to exclusion phrase data engineer  
Matched token set frontend plus engineer

Matched jobs are inserted into job_rows with their company linkage.

When a company is finalized and written as Matches, No Match, or Unverified

A company is finalized only after discovery, platform detection, extraction, and matching are completed or conclusively failed.

The final outcome is computed with the following rules, in this order.

First, if discovery failed, the company is UNVERIFIED.

Second, if extraction did not complete, meaning completed is false for any reason including timeouts, caps, blocking, or unsupported platform, the company is UNVERIFIED. This rule is absolute and is required by the MVP decisions.

Third, if extraction completed and produced at least one matched job, the company is finalized as MATCHES_FOUND.

Fourth, if extraction completed and produced zero matched jobs, the company is finalized as NO_MATCH_SCAN_COMPLETED.

When finalizing, the system writes:

The final status to run_companies.status  
The finished timestamp  
The listings scanned count  
The pages visited count  
The failure code and failure reason if unverified  
A trace event indicating finalization and the computed outcome

A company is never moved between outcomes after it is finalized for that run. The run is immutable once all companies are finalized.

How and when the UI updates

When the backend returns the run_id to the UI, the UI immediately navigates to a run results view. It renders the list of companies with initial status PENDING.

The UI polls the backend on a fixed interval for the run state. Each poll returns:

Run status  
Per company status and evidence fields  
Match rows accumulated so far

The run detail endpoint must return companies in stable display order using input_index ascending. Processing order may differ, but display order must remain stable across polls and refreshes.

As companies move from PENDING to IN_PROGRESS to a final state, the UI updates those rows. The three tables in the UI are derived directly from company statuses:

MATCHES_FOUND companies populate the Matches list, along with their job rows  
NO_MATCH_SCAN_COMPLETED companies populate the No Match list with evidence  
UNVERIFIED companies populate the Unverified list with failure reason and careers URL

The UI never invents state. It only renders what the backend persisted.

What happens on partial failure

Partial failure is expected and is handled at the company level.

If one company fails discovery, hits a cap, gets blocked, or times out, that company becomes UNVERIFIED. The run continues processing the remaining companies. The run is considered successful as long as at least one company was processed to a final state, even if many are unverified.

The only failure that aborts the entire run is role spec generation failure, because without a validated role spec the run cannot produce consistent matching.

What happens if the app restarts mid run

Because all run state is stored in SQLite on a Docker volume, the system is resilient to restarts.

On startup, the worker loop performs recovery before normal claiming begins. It checks for any runs that are in status READY or RUNNING. It then checks for companies in status IN_PROGRESS whose started timestamp is older than a defined stale threshold. This threshold exists because an app restart can leave a company stuck in IN_PROGRESS.

When stale in progress companies are found, the system resets them to PENDING, clears started_at, clears worker_token if present, and writes a trace event stating that the company was reclaimed after restart. This enables the worker to pick them up again and retry scanning.

Companies already finalized remain finalized. Jobs already written remain written. The system does not delete partial results. It continues until all companies have reached a final state.

The UI is also resilient because it polls by run id. After restart, the same run id continues to show current persisted state. If the run continues, the UI sees updates as companies are reclaimed and processed.

What happens when the run is complete

A run is complete when all run_companies rows for that run are in a final state of MATCHES_FOUND, NO_MATCH_SCAN_COMPLETED, UNVERIFIED, or CANCELLED.

At that point, the worker sets the run status to COMPLETED and writes a final trace event.

The UI stops showing an active scanning indicator and presents CSV export buttons for each list and for the combined export.

The data remains accessible by run id until it is removed by the retention policy.

Trace events and logging

Trace events are durable implementation level evidence for important system decisions and transitions. They are not optional in the lifecycle design.

Each trace event must capture at minimum:

The run id  
The run_company_id if the event is company scoped  
An event_type  
A human readable message  
Structured payload_json if needed  
A created_at timestamp

Trace events should be emitted for at least:

Role spec generation success  
Role spec generation failure  
Careers URL attempts and selected URL  
Platform detection result  
Extractor chosen  
Finalization outcome  
Restart recovery reclaim

If a dedicated trace_events table is not implemented in the earliest build slice, the app must still preserve the equivalent information in a temporary debug mechanism and then move to durable trace storage as soon as discovery work begins.

Summary of non negotiable rules

The API is the source of truth for all persisted state shown in the UI.  
The database is the source of truth for all queued and active work.  
POST /runs only creates persisted state and returns run_id.  
The worker owns run initialization and run progress transitions after creation.  
No company may start processing without a valid role_spec_json.  
Stable company display ordering is preserved using input_index.  
Once a company reaches a final state, it is never reprocessed for that run.  
A reclaim after restart resets stale IN_PROGRESS companies back to PENDING before new claiming begins.  
If scan completion is uncertain, the outcome must be UNVERIFIED, not No Match.
