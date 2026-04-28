import type { AtsType, CompanyStatus, RunStatus } from "./constants.js";

export type RoleSpecSeniority = "any" | "junior" | "mid" | "senior";

export interface RoleSpec {
  include_titles: string[];
  exclude_titles: string[];
  seniority: RoleSpecSeniority;
}

export interface RunResponse {
  id: string;
  status: RunStatus;
  role_raw: string;
  include_adjacent: boolean;
  error_code: string | null;
  error_message: string | null;
}

export interface RunCompanyResponse {
  id: string;
  company_name: string;
  status: CompanyStatus;
  input_index: number;
  failure_code: string | null;
  failure_reason: string | null;
  careers_url: string | null;
  ats_type: AtsType | null;
  extractor_used: string | null;
  listings_scanned: number | null;
  pages_visited: number | null;
}

export interface JobRowResponse {
  id: string;
  run_id: string;
  company_id: string;
  title: string;
  location: string | null;
  url: string;
  match_reason: string;
}

export interface RunDetailResponse {
  run: RunResponse;
  companies: RunCompanyResponse[];
  matched_jobs: JobRowResponse[];
}
