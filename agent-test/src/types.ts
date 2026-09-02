export interface IssueCheck {
  id: string;
  command: { executable: string; args: string[] };
  cwd?: string;
  timeoutMs?: number;
  expectedExitCode?: number;
  stdoutIncludes?: string;
}

export interface IssueCase {
  id: string;
  number?: number;
  title: string;
  body?: string;
  state?: string;
  checks?: IssueCheck[];
}

export interface IssueSet {
  repo: string;
  issues: IssueCase[];
}

export type ProviderId = 'echolens' | 'local-sim' | 'codex' | 'claude' | 'cloudecode';

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  command?: string;
  args?: string[];
  enabled?: boolean;
}

export interface ProviderIssueResult {
  providerId: ProviderId;
  issueId: string;
  mode: 'simulated' | 'executed';
  foundBugs: number;
  resolved: boolean;
  durationMs: number;
  exitCode?: number;
  timedOut?: boolean;
  output: string;
  error?: string;
}

export interface ProviderSummary {
  providerId: ProviderId;
  label: string;
  totalIssues: number;
  foundBugs: number;
  resolvedBugs: number;
  resolutionRate: number;
  averageDurationMs: number;
  results: ProviderIssueResult[];
}
