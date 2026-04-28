# Requirements Document

## Introduction

The Surveyor extraction system currently treats any non-zero number of parsed job-like links as sufficient evidence that extraction is complete. This produces false positives where careers landing pages, partial HTML content, and navigation or CTA links are incorrectly treated as fully enumerated job listings — resulting in `NO_MATCH_SCAN_COMPLETED` when the correct outcome is `UNVERIFIED`.

This feature tightens the definition of extraction completion so the system remains conservative and trustworthy. The core invariant is:

- `completed = true` only when the page is a confident listings surface with meaningful enumeration
- Otherwise `completed = false`, with a deterministic reason explaining why
- `completed = false` flows to `UNVERIFIED` in finalization

This spec is scoped strictly to the extraction completion problem. It does not govern discovery classification, resolver behavior, or ATS detection — only whether extraction may claim completion given what it observed.

## Glossary

- **Extraction_System**: The module responsible for fetching a careers page, parsing job-like links from HTML, and returning a structured result including a `completed` flag, job list, and diagnostic fields.
- **Confident_Listings_Surface**: A page that the Extraction_System has deterministically verified as a real job listings surface with meaningful enumeration — not a landing page, partial page, or navigation shell.
- **Minimum_Confident_Listings_Threshold**: The minimum number of parsed job listings required before the Extraction_System may consider a generic surface confidently enumerated (value: 3 for generic surfaces).
- **Weak_Extraction**: An extraction result where `jobs.length > 0` but the page does not meet the confidence threshold for a Confident_Listings_Surface. Weak extraction is not silent — it carries a deterministic failure reason.
- **Completion_Reason**: A short deterministic string included in trace payloads that documents why extraction was or was not marked complete (e.g. `CONFIDENT_SURFACE`, `INSUFFICIENT_LISTINGS`, `NOT_CONFIDENT_SURFACE`).
- **Finalization_Engine**: The module that applies the ordered outcome rules to produce a final company status (`MATCHES_FOUND`, `NO_MATCH_SCAN_COMPLETED`, or `UNVERIFIED`).
- **Playwright_Fallback**: A secondary extraction path using a headless browser, attempted only when the primary HTTP extraction fails to produce confident results under explicitly allowed conditions.
- **Worker**: The background process that orchestrates discovery, extraction, matching, and finalization for a single company.

## Requirements

### Requirement 1: Core Completion Invariant

**User Story:** As a system operator, I want extraction completion to be gated by confident enumeration evidence, so that the system only claims completion when it has strong, deterministic proof of a real listings surface.

#### Acceptance Criteria

1. THE Extraction_System SHALL set `completed = true` only when the page is a Confident_Listings_Surface with meaningful enumeration evidence.
2. WHEN the page is not a Confident_Listings_Surface, THE Extraction_System SHALL set `completed = false` regardless of how many job-like links were parsed.
3. WHEN the Extraction_System returns `completed = false`, THE Finalization_Engine SHALL produce `UNVERIFIED` as the final company status.
4. WHEN the Extraction_System returns `completed = true` and zero matches are found, THE Finalization_Engine SHALL produce `NO_MATCH_SCAN_COMPLETED`.
5. WHEN the Extraction_System returns `completed = true` and matches are found, THE Finalization_Engine SHALL produce `MATCHES_FOUND`.

### Requirement 2: Listings Surface Confidence Check

**User Story:** As a system operator, I want a deterministic confidence check that evaluates multiple signals before declaring a page a real listings surface, so that landing pages and partial content do not produce false completions.

#### Acceptance Criteria

1. THE Extraction_System SHALL expose a deterministic function that accepts HTML content, URL, parsed jobs, and extractor name, and returns a boolean indicating whether the surface is confident.
2. WHEN the parsed job count equals 0, THE Extraction_System SHALL return `false` from the confidence check regardless of other signals.
3. THE Extraction_System SHALL require meaningful enumeration — parsed job listings meeting the applicable threshold — as a necessary condition for confidence. Structural signals alone (URL patterns, HTML structure) SHALL NOT be sufficient to return `true`.
4. THE Extraction_System SHALL evaluate confidence using only deterministic signals and SHALL NOT use LLM-based or probabilistic logic.
5. THE Extraction_System SHALL produce identical confidence results for identical inputs across all invocations.

### Requirement 3: Minimum Listing Threshold for Generic Surfaces

**User Story:** As a system operator, I want generic extraction to require a minimum number of parsed listings before marking extraction complete, so that single links or sparse pages do not produce false confidence.

#### Acceptance Criteria

1. THE Extraction_System SHALL enforce a minimum confident listings threshold (value = 3 for generic surfaces).
2. WHILE the Extraction_System is using a generic extractor on a non-ATS-board URL, THE Extraction_System SHALL require the parsed job count to meet or exceed the minimum confident listings threshold before the confidence check returns `true`.
3. WHEN the parsed job count is greater than 0 but below the minimum confident listings threshold on a generic surface, THE Extraction_System SHALL return `completed = false` with a deterministic failure reason indicating insufficient listings.

### Requirement 4: Named ATS Extractor Completion Rules

**User Story:** As a system operator, I want named ATS extractors to not automatically imply completion, so that extraction still requires strong evidence of enumeration even on ATS-associated pages.

#### Acceptance Criteria

1. WHEN a named ATS extractor is used, THE Extraction_System SHALL NOT treat the extractor name alone as sufficient evidence for completion.
2. THE Extraction_System SHALL require meaningful enumeration evidence — not just structural signals — before the confidence check returns `true` for a named ATS extractor. The extractor must have parsed listings that demonstrate actual job enumeration occurred.
3. WHEN a named ATS extractor is used and meaningful enumeration evidence is not found, THE Extraction_System SHALL return `completed = false` with a deterministic failure reason.

### Requirement 5: Weak Extraction Produces a Deterministic Failure Reason

**User Story:** As a system operator, I want weak extraction to carry an explicit, deterministic reason for incompletion, so that traces, debugging, and UI transparency are not degraded by silent failures.

#### Acceptance Criteria

1. WHEN the Extraction_System parses jobs but the confidence check returns `false`, THE Extraction_System SHALL return `completed = false` with a non-null `failure_code` and `failure_reason` describing why the surface was not confident (e.g. `INSUFFICIENT_LISTINGS`, `NOT_CONFIDENT_SURFACE`).
2. THE Extraction_System SHALL NOT return `completed = false` with a null failure code when jobs were parsed but the surface was not confident.
3. THE Extraction_System SHALL include `listings_scanned` equal to the actual number of parsed jobs even when `completed` is `false`, so that trace data reflects what was found.
4. THE Extraction_System SHALL preserve existing failure-condition paths (`BLOCKED`, `CAP_REACHED`, `FETCH_FAILED`, `PLAYWRIGHT_FAILED`) unchanged — these paths SHALL continue to return `completed = false` with their existing failure codes.

### Requirement 6: Playwright Fallback for Weak Extraction

**User Story:** As a system operator, I want Playwright fallback to remain available when HTTP extraction produces a weak result, so that the system can recover by rendering JavaScript on pages that returned insufficient listings.

#### Acceptance Criteria

1. WHEN HTTP extraction produces a Weak_Extraction (jobs found but `completed = false`), THE Worker SHALL evaluate Playwright fallback eligibility.
2. THE Worker SHALL block Playwright fallback only when extraction is confident (`completed = true`), not merely when `jobs.length > 0`.
3. WHEN Playwright fallback is attempted after a Weak_Extraction, THE Extraction_System SHALL apply the same confidence check to the Playwright result.
4. IF Playwright fallback is not eligible after a Weak_Extraction, THEN THE Worker SHALL finalize with the weak result (`completed = false`), producing `UNVERIFIED`.

### Requirement 7: Finalization Alignment

**User Story:** As a system operator, I want the existing finalization rules to remain unchanged, so that the tighter extraction completion definition flows through to correct final statuses without structural changes.

#### Acceptance Criteria

1. THE Finalization_Engine SHALL continue to apply the ordered outcome rules: (1) no careers URL → `UNVERIFIED`, (2) extraction not completed → `UNVERIFIED`, (3) matches > 0 → `MATCHES_FOUND`, (4) else → `NO_MATCH_SCAN_COMPLETED`.
2. THE Finalization_Engine SHALL continue to enforce the existing defense-in-depth outcome assertions without modification.

### Requirement 8: Trace Visibility for Completion Decisions

**User Story:** As a system operator, I want extraction completion reasoning to be visible in existing trace payloads, so that I can diagnose why a company was marked complete or incomplete.

#### Acceptance Criteria

1. THE Worker SHALL include `completion_reason` in the existing `finalization_outcome` trace payload alongside the existing fields.
2. WHEN the confidence check returns `true`, THE Worker SHALL set `completion_reason` to a deterministic value describing the confidence basis (e.g. `ATS_BOARD_DIRECT`, `GENERIC_THRESHOLD_MET`).
3. WHEN the confidence check returns `false` and jobs were found, THE Worker SHALL set `completion_reason` to a deterministic value describing the reason (e.g. `INSUFFICIENT_LISTINGS`, `NOT_CONFIDENT_SURFACE`).
4. WHEN the confidence check returns `false` and no jobs were found, THE Worker SHALL set `completion_reason` to `NO_LISTINGS_PARSED`.
