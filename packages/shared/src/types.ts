import type {
  ApplicationPacketStatus,
  AtsType,
  CompanyStatus,
  FitAnalysisStatus,
  MonitoringExecutionStatus,
  ProfileItemType,
  RunStatus,
} from "./constants.js";

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

export interface FitAnalysisEvidenceItem {
  text: string;
  evidence: string;
}

export interface FitAnalysisResponse {
  id: string;
  job_row_id: string;
  status: FitAnalysisStatus;
  fit_summary: string | null;
  strengths: FitAnalysisEvidenceItem[] | null;
  gaps: FitAnalysisEvidenceItem[] | null;
  risks: FitAnalysisEvidenceItem[] | null;
  suggested_next_steps: FitAnalysisEvidenceItem[] | null;
  caveats: string[] | null;
  model_name: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  created_at: number;
}

export type FitAnalysisListResponse = FitAnalysisResponse[];

export type ApplicationPacketEvidenceItem = FitAnalysisEvidenceItem;

export interface ApplicationPacketResponse {
  id: string;
  job_row_id: string;
  job_fit_analysis_id: string | null;
  status: ApplicationPacketStatus;
  packet_summary: string | null;
  cover_letter_draft: string | null;
  positioning_notes: ApplicationPacketEvidenceItem[] | null;
  resume_bullet_suggestions: ApplicationPacketEvidenceItem[] | null;
  talking_points: ApplicationPacketEvidenceItem[] | null;
  questions_to_prepare: ApplicationPacketEvidenceItem[] | null;
  caveats: string[] | null;
  model_name: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  created_at: number;
}

export type ApplicationPacketListResponse = ApplicationPacketResponse[];

export interface SavedCompanyResponse {
  id: string;
  company_name: string;
  company_url: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export type SavedCompanyListResponse = SavedCompanyResponse[];

export interface SavedSearchCompanyResponse {
  id: string;
  saved_company_id: string | null;
  company_name: string;
  input_index: number;
}

export interface SavedSearchResponse {
  id: string;
  name: string;
  role_raw: string;
  include_adjacent: boolean;
  notes: string | null;
  companies: SavedSearchCompanyResponse[];
  created_at: number;
  updated_at: number;
}

export type SavedSearchListResponse = SavedSearchResponse[];

export interface MonitoringConfigResponse {
  enabled: boolean;
  last_checked_at: number | null;
}

export interface MonitoringExecutionResponse {
  id: string;
  run_id: string;
  status: MonitoringExecutionStatus;
  new_match_count: number;
  started_at: number;
  finished_at: number | null;
}

export type MonitoringExecutionListResponse = MonitoringExecutionResponse[];

export interface MonitoringMatchResponse {
  id: string;
  job_key: string;
  company_name: string;
  title: string;
  location: string | null;
  job_url: string;
  first_seen_run_id: string;
  last_seen_run_id: string;
  first_seen_at: number;
  last_seen_at: number;
  seen_count: number;
}

export type MonitoringMatchListResponse = MonitoringMatchResponse[];

export interface MonitoringRunNowResponse {
  execution: MonitoringExecutionResponse;
  runId: string;
}
