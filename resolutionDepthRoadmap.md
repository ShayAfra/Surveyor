# Resolver Resolution Depth Roadmap (Follow-On Coverage Improvement)

## How to Execute This Roadmap

Each step is designed to be executed by a fresh Cursor agent.

Rules:

- Do exactly what the step says. Do not expand scope.
- Do not refactor unrelated modules.
- Do not redesign discovery classification again.
- Do not change API contracts, DB schema, or status enums.
- Keep discovery deterministic (no LLMs, no randomness).
- The app must remain runnable after each step.
- Follow existing lifecycle and worker ownership rules.

Time Standard:

- ALL timestamps use Date.now()

---

# PROBLEM THIS ROADMAP SOLVES

After correctness is restored, the system can avoid false confidence, but it can still stop short of the real listings surface in legitimate indirect cases.

Common remaining cases:

- careers page contains an embedded ATS board
- careers page contains a high confidence “view jobs” or “search openings” CTA
- careers page links to the real listings surface one step deeper
- careers page contains iframe or outbound ATS references that are authoritative enough to follow deterministically

Without deeper resolution support, the system may now behave conservatively and correctly end as UNVERIFIED, but still fail to reach listings that are actually available with one additional deterministic step.

This roadmap improves resolution depth without weakening correctness.

---

# DESIGN INTENT

We are NOT fixing false confidence here.
That was the job of the correctness roadmap.

We are now improving coverage in a narrow, deterministic way.

The system must:

- follow high confidence ATS embed references
- follow high confidence CTA targets
- re-verify the resolved destination before extraction
- stop after bounded, deterministic resolution steps
- never turn this into open ended crawling

This roadmap should increase successful resolution while preserving the rule:

If confidence is still uncertain, the result must remain UNVERIFIED.

---

# PHASE R1: ADD ATS EMBED RESOLUTION

## Step R1.1: Detect High Confidence ATS Embed References

Extend resolver logic so it can explicitly detect embedded ATS references inside weak surfaces.

Supported examples include:

- greenhouse embed markers
- lever embed markers
- ashby embed markers
- smartrecruiters embed markers
- iframe src values pointing to supported ATS domains
- script or data attributes containing clearly extractable ATS URLs

Rules:

- only supported ATS domains may be treated as high confidence embed references
- do not follow arbitrary third party links
- do not add browser automation
- detection must remain deterministic

Acceptance criteria:

- resolver can identify high confidence ATS embed references on a weak surface
- extracted candidate URLs are bounded and explainable

---

## Step R1.2: Resolve ATS Embed Candidates

When a high confidence ATS embed candidate is found:

- normalize the extracted ATS URL
- treat it as a resolver candidate
- fetch it directly
- re-run verification on that destination

Rules:

- follow only a single ATS candidate at a time
- do not recurse indefinitely
- do not treat detection alone as success
- destination must still pass verification

Acceptance criteria:

- weak container pages can resolve into actual ATS listings surfaces
- resolver no longer stops at the embed container when a clear ATS target exists

---

## Step R1.3: Preserve Resolver Safety Boundaries

Ensure ATS embed resolution remains bounded.

Rules:

- maximum one ATS resolution hop per weak surface
- no domain graph expansion
- no generic external crawling
- no following unsupported job boards
- if ATS destination fails verification, resolution must remain unresolved

Acceptance criteria:

- coverage improves without turning resolver into a crawler
- incorrect ATS guesses do not create false confidence

---

# PHASE R2: ADD CTA-BASED RESOLUTION

## Step R2.1: Detect High Confidence Careers CTAs

Extend resolver to identify high confidence CTA links on careers pages.

Supported CTA intent includes phrases such as:

- view openings
- search jobs
- see all jobs
- browse roles
- current openings
- open positions

Rules:

- CTA must be link backed with a concrete href
- CTA must be strongly job related
- weak generic marketing CTAs must not qualify
- detection must remain deterministic

Acceptance criteria:

- resolver can extract likely listings navigation targets from careers pages
- only high confidence job related CTAs are considered

---

## Step R2.2: Follow CTA Targets with Single-Hop Resolution

When a high confidence CTA target is found:

- normalize the target URL
- fetch the page
- re-run verification on that page
- if verified more strongly, use it as the resolved surface

Rules:

- single hop only
- do not chain multiple CTA hops
- do not follow low confidence internal links
- do not combine this with arbitrary crawling

Acceptance criteria:

- careers landing pages with explicit “jobs” buttons now resolve deeper
- one click listings surfaces become reachable deterministically

---

## Step R2.3: Rank CTA Candidates Conservatively

If multiple CTA candidates exist:

- prefer the most job specific target
- prefer targets whose paths look like careers, jobs, openings, or supported ATS routes
- prefer same domain or already supported ATS destinations

Rules:

- ranking must remain deterministic
- do not use heuristics that overfit a single site
- if no candidate is clearly trustworthy, do not follow any

Acceptance criteria:

- resolver chooses stable, conservative CTA targets
- ambiguous pages remain unresolved instead of being guessed through

---

# PHASE R3: RE-VERIFY RESOLVED DESTINATIONS

## Step R3.1: Re-run Verification After Each Resolution Hop

Any destination reached through:

- ATS embed resolution
- CTA resolution

must be re-verified before being treated as a listings surface.

Rules:

- resolution success requires verification of the destination page
- do not assume a followed link is automatically authoritative
- keep strong vs weak distinctions intact

Acceptance criteria:

- followed links only count if the resolved page passes verification
- deeper resolution remains consistent with correctness rules

---

## Step R3.2: Upgrade Resolved Surfaces Only on Strong Evidence

A resolved destination may be treated as extraction ready only if it is verified strongly enough.

Rules:

- strong listings surface → extraction may begin
- weak destination → still unresolved or weak
- unresolved destination → do not treat as final

Acceptance criteria:

- deeper resolution improves coverage without reviving false positive confidence
- weakly resolved pages still remain conservative

---

# PHASE R4: EXTEND RESOLUTION METHOD SEMANTICS

## Step R4.1: Add Explicit Resolution Outcomes

Extend resolver result semantics to distinguish outcomes such as:

- DIRECT_VERIFIED
- ATS_RESOLVED
- CTA_RESOLVED
- UNRESOLVED
- PLAYWRIGHT_REQUIRED if that concept already exists in current logic

Rules:

- do not change persisted DB schema
- these semantics are used to explain how the surface was reached
- each outcome must reflect a real bounded path, not a guess

Acceptance criteria:

- downstream logic and traces can distinguish direct discovery from one hop resolution
- resolution behavior becomes easier to inspect and debug

---

## Step R4.2: Ensure listings_url Reflects Real Resolved Surface

Rules:

- if ATS or CTA resolution succeeds, listings_url should point to that resolved destination
- careers_url should remain the discovered entry point
- do not collapse the two fields when they represent different pages

Acceptance criteria:

- extraction starts from the best resolved listings surface
- persisted evidence becomes more truthful and inspectable

---

# PHASE R5: INTEGRATE DEEPER RESOLUTION INTO EXTRACTION START

## Step R5.1: Prefer Resolved listings_url for Extraction

Update extraction start behavior so that:

- if resolver reaches ATS_RESOLVED or CTA_RESOLVED listings_url, extraction starts there
- if resolver remains unresolved, preserve conservative downstream behavior

Rules:

- do not override correctness safeguards
- do not force extraction on unverified targets
- extraction still depends on trustworthy resolution

Acceptance criteria:

- extraction begins on the most authoritative reachable surface
- one hop resolution actually improves end to end results

---

## Step R5.2: Preserve Conservative Failure Behavior

If deeper resolution still does not produce a trustworthy surface:

- do not degrade into false completion
- allow the company to remain unresolved and eventually unverified

Acceptance criteria:

- resolution depth increases coverage
- uncertainty still stays unverified

---

# PHASE R6: TRACE AND DEBUG VISIBILITY

## Step R6.1: Reflect Resolution Path in Trace Output

Ensure existing trace behavior can expose which path was used:

- direct verified
- ATS resolved
- CTA resolved
- unresolved

Rules:

- preserve current trace structure where possible
- do not require schema changes
- trace output should help explain why a page was or was not followed

Acceptance criteria:

- Reddit-like and future indirect cases are easier to diagnose
- trace evidence matches actual resolver behavior

---

## Step R6.2: Preserve Existing Lifecycle Contracts

Ensure:

- worker ownership is unchanged
- run statuses are unchanged
- company finalization logic is unchanged
- API response shapes are unchanged

Acceptance criteria:

- only resolver depth improves
- no drift into unrelated lifecycle changes

---

# FINAL DEFINITION OF DONE

This roadmap is complete when:

1. Weak surfaces with supported ATS embeds can resolve one step deeper
2. Careers pages with high confidence “view jobs” style CTAs can resolve one step deeper
3. Every resolved destination is re-verified before use
4. listings_url points to the actual resolved listings surface when one is reached
5. extraction starts from the best resolved surface available
6. resolver behavior stays bounded and deterministic
7. unsupported or ambiguous links are not followed
8. unresolved cases still remain conservative and can end as UNVERIFIED
9. coverage improves without reintroducing false confident NO_MATCH_SCAN_COMPLETED outcomes

---

# Suggested Cursor Execution Order

1. Step R1.1
2. Step R1.2
3. Step R1.3
4. Step R2.1
5. Step R2.2
6. Step R2.3
7. Step R3.1
8. Step R3.2
9. Step R4.1
10. Step R4.2
11. Step R5.1
12. Step R5.2
13. Step R6.1
14. Step R6.2
