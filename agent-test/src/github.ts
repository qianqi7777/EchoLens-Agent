import type { IssueSet } from './types.js';

export async function loadGithubIssues(repo: string, limit = 20, signal?: AbortSignal): Promise<IssueSet> {
  const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})$/u.exec(repo.trim());
  if (!match) throw new Error('仓库格式应为 owner/repo');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Issue 数量必须是 1-100 的整数');
  const response = await fetch(`https://api.github.com/repos/${match[1]}/${match[2]}/issues?state=all&per_page=${Math.min(limit, 100)}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'echolens-agent-test' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub Issues 请求失败：HTTP ${response.status}`);
  const payload = await response.json() as Array<Record<string, unknown>>;
  if (!Array.isArray(payload)) throw new Error('GitHub 返回的数据格式无效');
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
