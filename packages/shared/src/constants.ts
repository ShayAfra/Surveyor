export const RunStatus = {
  CREATED: "CREATED",
  READY: "READY",
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED_ROLE_SPEC: "FAILED_ROLE_SPEC",
} as const;

export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

export const CompanyStatus = {
  PENDING: "PENDING",
  IN_PROGRESS: "IN_PROGRESS",
  MATCHES_FOUND: "MATCHES_FOUND",
  NO_MATCH_SCAN_COMPLETED: "NO_MATCH_SCAN_COMPLETED",
  UNVERIFIED: "UNVERIFIED",
  CANCELLED: "CANCELLED",
} as const;

export type CompanyStatus = (typeof CompanyStatus)[keyof typeof CompanyStatus];

export const AtsType = {
  GREENHOUSE: "GREENHOUSE",
  LEVER: "LEVER",
  ASHBY: "ASHBY",
  SMARTRECRUITERS: "SMARTRECRUITERS",
  UNKNOWN: "UNKNOWN",
} as const;

export type AtsType = (typeof AtsType)[keyof typeof AtsType];

export const ProfileItemType = {
  WORK_HISTORY: "WORK_HISTORY",
  PROJECT: "PROJECT",
  SKILL: "SKILL",
  EDUCATION: "EDUCATION",
} as const;

export type ProfileItemType = (typeof ProfileItemType)[keyof typeof ProfileItemType];

/** Local to job_fit_analyses. Not a scanner run/company status. */
export const FitAnalysisStatus = {
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;

export type FitAnalysisStatus = (typeof FitAnalysisStatus)[keyof typeof FitAnalysisStatus];

/** Local to application_packets. Not a scanner run/company status. */
export const ApplicationPacketStatus = {
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;

export type ApplicationPacketStatus =
  (typeof ApplicationPacketStatus)[keyof typeof ApplicationPacketStatus];

/**
 * Local to monitoring_executions. Not a scanner run/company status.
 * Derived from the linked scanner run: RUNNING while the run is
 * CREATED/READY/RUNNING, COMPLETED when the run reaches COMPLETED, FAILED
 * when the run reaches FAILED_ROLE_SPEC.
 */
export const MonitoringExecutionStatus = {
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;

export type MonitoringExecutionStatus =
  (typeof MonitoringExecutionStatus)[keyof typeof MonitoringExecutionStatus];

/**
 * Local to applications (application tracking). Not a scanner run/company
 * status and not ApplicationPacketStatus. Transitions are not enforced —
 * the user manually records what happened in any order.
 */
export const ApplicationTrackingStatus = {
  SAVED: "SAVED",
  APPLIED: "APPLIED",
  INTERVIEWING: "INTERVIEWING",
  OFFER: "OFFER",
  REJECTED: "REJECTED",
  WITHDRAWN: "WITHDRAWN",
} as const;

export type ApplicationTrackingStatus =
  (typeof ApplicationTrackingStatus)[keyof typeof ApplicationTrackingStatus];
