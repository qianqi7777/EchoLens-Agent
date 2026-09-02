const defaultIssues = { repo: 'local/example', issues: [{ id: 'issue-1', number: 1, title: '修复问候函数返回值', body: 'greet 应该返回包含名字的问候语。', state: 'open', checks: [] }] };
const providers = [
  { id: 'echolens', label: 'EchoLens Agent', enabled: true },
  { id: 'local-sim', label: '本地模拟', enabled: false },
  { id: 'codex', label: 'Codex CLI', enabled: false },
  { id: 'claude', label: 'Claude Code', enabled: false },
  { id: 'cloudecode', label: 'Cloudecode', enabled: false },
];
const $ = (id) => document.getElementById(id);
$('issues').value = JSON.stringify(defaultIssues, null, 2);
renderProviders(); updateCount();
fetch('/api/health').then(() => { $('health').textContent = '本地服务正常'; });
$('issues').addEventListener('input', updateCount);
$('loadGithub').addEventListener('click', async () => {
  const repo = $('githubRepo').value.trim(); if (!repo) return;
  $('runState').textContent = '读取 GitHub Issues…';
  const response = await fetch(`/api/github/issues?repo=${encodeURIComponent(repo)}`);
  const data = await response.json(); $('issues').value = JSON.stringify(data, null, 2); updateCount(); $('runState').textContent = 'Issues 已加载';
});
$('run').addEventListener('click', async () => {
  let issueSet; try { issueSet = JSON.parse($('issues').value); } catch { $('runState').textContent = 'Issue JSON 格式错误'; return; }
  $('runState').textContent = '运行中…';
  const response = await fetch('/api/compare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ issueSet, providers, repoRoot: $('repoRoot').value || '.', execute: $('execute').checked }) });
  const data = await response.json(); if (data.error) { $('runState').textContent = data.error; return; }
  $('runState').textContent = '完成'; renderCards(data);
});
$('quality').addEventListener('click', async () => {
  $('runState').textContent = '运行完整质量测试…';
  const response = await fetch('/api/quality', { method: 'POST' });
  const data = await response.json();
  $('runState').textContent = data.error ? data.error : `${data.passed ? '质量测试通过' : '质量测试失败'} · ${data.durationMs} ms`;
});
function renderProviders() {
  $('providers').innerHTML = providers.map((provider, index) => `<div class="provider"><label><input type="checkbox" data-provider="${index}" ${provider.enabled ? 'checked' : ''}>${provider.label}</label></div>`).join('');
  $('providers').querySelectorAll('[data-provider]').forEach((input) => input.addEventListener('change', (event) => { providers[Number(event.target.dataset.provider)].enabled = event.target.checked; }));
}
function updateCount() { try { $('issueCount').textContent = `${JSON.parse($('issues').value).issues.length} 条`; } catch { $('issueCount').textContent = '格式错误'; } }
function renderCards(items) { $('cards').innerHTML = items.map((item) => `<article class="card"><h3>${escapeHtml(item.label)}</h3><div class="metric"><span>运行模式</span><strong>${item.results.some((result) => result.mode === 'executed') ? '真实执行' : '模拟'}</strong></div><div class="metric"><span>发现 Bug</span><strong>${item.foundBugs}</strong></div><div class="metric"><span>解决 Issue</span><strong>${item.resolvedBugs}/${item.totalIssues}</strong></div><div class="metric"><span>解决率</span><strong>${(item.resolutionRate * 100).toFixed(1)}%</strong></div><div class="metric"><span>平均耗时</span><strong>${Math.round(item.averageDurationMs)} ms</strong></div>${item.results.filter((result) => result.error).map((result) => `<div class="failure">${escapeHtml(result.issueId)}：${escapeHtml(result.error)}</div>`).join('')}</article>`).join(''); }
function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
