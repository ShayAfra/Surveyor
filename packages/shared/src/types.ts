import type { AtsType, CompanyStatus, ProfileItemType, RunStatus } from "./constants.js";

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
  job_detail_available: boolean;
  job_detail_failure_code: string | null;
  job_detail_failure_reason: string | null;
}

export interface RunDetailResponse {
  run: RunResponse;
  companies: RunCompanyResponse[];
  matched_jobs: JobRowResponse[];
}

export interface JobDetailResponse {
  job_row_id: string;
  job_url: string;
  description_text: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  fetched_at: number | null;
}

export interface UserProfileResponse {
  id: string;
  full_name: string | null;
  location: string | null;
  years_experience: number | null;
  target_titles: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export interface UserProfileItemResponse {
  id: string;
  item_type: ProfileItemType;
  title: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  created_at: number;
  updated_at: number;
}

export interface ResumeMemoryResponse {
  id: string;
  resume_text: string;
  created_at: number;
  updated_at: number;
}

export interface ProfileMemoryResponse {
  profile: UserProfileResponse | null;
  items: UserProfileItemResponse[];
  resume: ResumeMemoryResponse | null;
}
