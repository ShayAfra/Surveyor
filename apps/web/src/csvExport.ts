import type { JobRowResponse, RunCompanyResponse, RunDetailResponse } from "@surveyor/shared";
import { CompanyStatus } from "@surveyor/shared";

const COMPANY_HEADERS = [
  "company_name",
  "input_index",
  "company_status",
  "careers_url",
  "ats_type",
  "extractor_used",
  "listings_scanned",
  "pages_visited",
  "failure_code",
  "failure_reason",
] as const;

const JOB_HEADERS = ["job_title", "job_location", "job_url", "match_reason"] as const;

const MATCHES_HEADERS = [...COMPANY_HEADERS, ...JOB_HEADERS] as const;

function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function companyRow(c: RunCompanyResponse): string[] {
  return [
    escapeCsvField(c.company_name),
    escapeCsvField(c.input_index),
    escapeCsvField(c.status),
    escapeCsvField(c.careers_url),
    escapeCsvField(c.ats_type),
    escapeCsvField(c.extractor_used),
    escapeCsvField(c.listings_scanned),
    escapeCsvField(c.pages_visited),
    escapeCsvField(c.failure_code),
    escapeCsvField(c.failure_reason),
  ];
}

function sortCompaniesByInputIndex(companies: RunCompanyResponse[]): RunCompanyResponse[] {
  return [...companies].sort((a, b) => a.input_index - b.input_index);
}

function sortJobsById(jobs: JobRowResponse[]): JobRowResponse[] {
  return [...jobs].sort((a, b) => a.id.localeCompare(b.id));
}

function jobsByCompanyId(matched_jobs: JobRowResponse[]): Map<string, JobRowResponse[]> {
  const map = new Map<string, JobRowResponse[]>();
  for (const job of matched_jobs) {
    const list = map.get(job.company_id);
    if (list) {
      list.push(job);
    } else {
      map.set(job.company_id, [job]);
    }
  }
  return map;
}

function toCsv(headers: readonly string[], rows: string[][]): string {
  const lines = [headers.map(escapeCsvField).join(","), ...rows.map((r) => r.join(","))];
  return lines.join("\r\n");
}

function triggerDownload(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function exportMatchesCsv(detail: RunDetailResponse, runId: string): void {
  const byCompany = jobsByCompanyId(detail.matched_jobs);
  const rows: string[][] = [];
  for (const c of sortCompaniesByInputIndex(detail.companies)) {
    if (c.status !== CompanyStatus.MATCHES_FOUND) {
      continue;
    }
    const jobs = sortJobsById(byCompany.get(c.id) ?? []);
    for (const j of jobs) {
      rows.push([
        ...companyRow(c),
        escapeCsvField(j.title),
        escapeCsvField(j.location),
        escapeCsvField(j.url),
        escapeCsvField(j.match_reason),
      ]);
    }
  }
  triggerDownload(`run-${runId}-matches.csv`, toCsv(MATCHES_HEADERS, rows));
}

export function exportNoMatchCsv(detail: RunDetailResponse, runId: string): void {
  const rows: string[][] = [];
  for (const c of sortCompaniesByInputIndex(detail.companies)) {
    if (c.status !== CompanyStatus.NO_MATCH_SCAN_COMPLETED) {
      continue;
    }
    rows.push(companyRow(c));
  }
  triggerDownload(`run-${runId}-no-match.csv`, toCsv(COMPANY_HEADERS, rows));
}

export function exportUnverifiedCsv(detail: RunDetailResponse, runId: string): void {
  const rows: string[][] = [];
  for (const c of sortCompaniesByInputIndex(detail.companies)) {
    if (c.status !== CompanyStatus.UNVERIFIED && c.status !== CompanyStatus.CANCELLED) {
      continue;
    }
    rows.push(companyRow(c));
  }
  triggerDownload(`run-${runId}-unverified.csv`, toCsv(COMPANY_HEADERS, rows));
}

export function exportCombinedCsv(detail: RunDetailResponse, runId: string): void {
  const byCompany = jobsByCompanyId(detail.matched_jobs);
  const rows: string[][] = [];
  for (const c of sortCompaniesByInputIndex(detail.companies)) {
    const jobs = sortJobsById(byCompany.get(c.id) ?? []);
    if (jobs.length > 0) {
      for (const j of jobs) {
        rows.push([
          ...companyRow(c),
          escapeCsvField(j.title),
          escapeCsvField(j.location),
          escapeCsvField(j.url),
          escapeCsvField(j.match_reason),
        ]);
      }
    } else {
      rows.push([
        ...companyRow(c),
        escapeCsvField(""),
        escapeCsvField(""),
        escapeCsvField(""),
        escapeCsvField(""),
      ]);
    }
  }
  triggerDownload(`run-${runId}-combined.csv`, toCsv(MATCHES_HEADERS, rows));
}
