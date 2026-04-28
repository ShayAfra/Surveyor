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
