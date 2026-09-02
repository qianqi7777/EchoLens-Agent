import type { IssueSet } from './types.js';

export async function loadGithubIssues(repo: string, limit = 20): Promise<IssueSet> {
  const match = /^([^/]+)\/([^/]+)$/.exec(repo.trim());
  if (!match) throw new Error('仓库格式应为 owner/repo');
  const response = await fetch(`https://api.github.com/repos/${match[1]}/${match[2]}/issues?state=all&per_page=${Math.min(limit, 100)}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'echolens-agent-test' },
  });
  if (!response.ok) throw new Error(`GitHub Issues 请求失败：HTTP ${response.status}`);
  const payload = await response.json() as Array<Record<string, unknown>>;
  return {
    repo,
    issues: payload.filter((item) => !item.pull_request).map((item) => ({
      id: `github-${String(item.number)}`,
      number: typeof item.number === 'number' ? item.number : undefined,
      title: typeof item.title === 'string' ? item.title : '未命名 Issue',
      body: typeof item.body === 'string' ? item.body : '',
      state: typeof item.state === 'string' ? item.state : undefined,
      checks: [],
    })),
  };
}
