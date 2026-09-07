const $ = (id) => document.getElementById(id);
const providers = [
  { id: 'local-sim', label: '本地模拟', enabled: true },
  { id: 'echolens', label: 'EchoLens Agent', enabled: false },
  { id: 'codex', label: 'Codex CLI', enabled: false },
  { id: 'claude', label: 'Claude Code', enabled: false },
  { id: 'cloudecode', label: 'Cloudecode', enabled: false },
];
let current;
let healthy = false;
let externalEnabled = false;
let remoteActive;
let report;
let qualityReport;
let dirty = false;
let valid = false;
let activeTab = 'dataset';
let healthGeneration = 0;
const esc = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const icons = () => window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });
const duration = (ms) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

function status(message, tone = '') { $('runState').textContent = message; $('runState').parentElement.className = `activity ${tone}`; }
function showTab(id) {
  activeTab = id;
  for (const button of document.querySelectorAll('[data-tab]')) {
    const selected = button.dataset.tab === id;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    $(button.dataset.tab).hidden = !selected;
  }
}
for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => showTab(button.dataset.tab));
  button.addEventListener('keydown', (event) => {
    const ids = ['dataset', 'results', 'qualityLog'];
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (ids.indexOf(activeTab) + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
    showTab(ids[index]); $(`tab-${ids[index]}`).focus();
  });
}

function updateControls() {
  const busy = Boolean(current || remoteActive);
  $('run').disabled = busy || !healthy || !valid || !providers.some((p) => p.enabled);
  $('quality').disabled = busy || !healthy;
  for (const id of ['sample', 'import', 'format', 'loadGithub', 'issues', 'repoRoot', 'githubRepo', 'githubLimit']) $(id).disabled = busy;
  for (const input of document.querySelectorAll('[data-provider],input[name=mode]')) input.disabled = busy;
  $('execute').disabled = busy || !externalEnabled;
  $('cancel').hidden = !current;
  $('cancel').disabled = Boolean(current?.controller.signal.aborted);
  $('exportResults').disabled = !report;
  $('exportQuality').disabled = !qualityReport;
  $('exportIssues').disabled = !valid;
  $('providerCount').textContent = `${providers.filter((p) => p.enabled).length} 已选`;
  $('runMode').textContent = $('execute').checked ? '真实执行' : '模拟';
  $('runMode').className = `badge ${$('execute').checked ? 'warn' : ''}`;
  $('executionState').textContent = externalEnabled ? '真实执行可用 · 每次需确认' : '真实执行已锁定';
}

async function request(url, { body, signal } = {}) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', signal,
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-agent-test-request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`服务返回非 JSON 数据（HTTP ${response.status}）`); }
  if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
  return data;
}

async function updateHealth() {
  const generation = ++healthGeneration;
  try {
    const data = await request('/api/health', { signal: AbortSignal.timeout(3000) });
    if (generation !== healthGeneration) return;
    if (data.ok !== true) throw new Error('服务不可用');
    healthy = true; externalEnabled = data.externalEnabled === true; remoteActive = data.active;
    $('health').textContent = remoteActive ? '服务忙碌' : '本地服务正常'; $('health').className = 'badge good';
    if (!externalEnabled) document.querySelector('input[name=mode][value=simulated]').checked = true;
    if (remoteActive && !current) status('服务端任务仍在运行或清理中', 'running');
    else if (!current && $('runState').textContent === '服务端任务仍在运行或清理中') status('任务已结束，可重新运行');
  } catch {
    if (generation !== healthGeneration) return;
    healthy = false; $('health').textContent = '服务未连接'; $('health').className = 'badge bad';
  }
  updateControls();
}

async function action(label, operation) {
  if (current || remoteActive) return;
  const controller = new AbortController();
  current = { controller, started: Date.now() };
  status(label, 'running'); updateControls();
  try { await operation(controller.signal); }
  catch (error) {
    status(controller.signal.aborted ? '已请求取消；服务端正在停止任务' : (error.message || '操作失败'), controller.signal.aborted ? '' : 'error');
  } finally {
    $('elapsed').textContent = duration(Date.now() - current.started);
    current = undefined;
    await updateHealth();
  }
}

function parseIssues(text = $('issues').value) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('JSON 格式错误'); }
  if (!value || typeof value.repo !== 'string' || !value.repo.trim() || !Array.isArray(value.issues)) throw new Error('需要 repo 和 issues 数组');
  if (value.issues.length < 1 || value.issues.length > 100) throw new Error('任务数量应为 1-100 条');
  const ids = new Set();
  for (const issue of value.issues) {
    if (!issue || typeof issue.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(issue.id)
      || typeof issue.title !== 'string' || !issue.title.trim()) throw new Error('每条任务需要有效 ID 和标题');
    if (ids.has(issue.id)) throw new Error(`重复任务 ID：${issue.id}`);
    ids.add(issue.id);
    if (issue.checks !== undefined && !Array.isArray(issue.checks)) throw new Error(`${issue.id} 的 checks 必须是数组`);
  }
  return value;
}
function updateCount() {
  try {
    const data = parseIssues(); valid = true;
    $('issueCount').textContent = data.issues.length;
    const checks = data.issues.reduce((sum, issue) => sum + (issue.checks?.length ?? 0), 0);
    $('validation').textContent = `${data.repo} · JSON 有效`; $('issues').setAttribute('aria-invalid', 'false');
    $('checkCount').textContent = `${checks} 条验证命令`;
    $('issuePreview').innerHTML = data.issues.map((issue) => `<div class="issue-row"><span class="issue-id">${esc(issue.id)}</span><span class="issue-title">${esc(issue.title)}</span><span class="badge ${issue.checks?.length ? '' : 'warn'}">${issue.checks?.length ?? 0} checks</span></div>`).join('');
  } catch (error) {
    valid = false; $('issueCount').textContent = '0'; $('validation').textContent = error.message;
    $('issues').setAttribute('aria-invalid', 'true'); $('issuePreview').replaceChildren(); $('checkCount').textContent = '';
  }
  updateControls();
}

function download(value, filename, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function confirmExternal() {
  const dialog = $('confirmDialog');
  dialog.returnValue = 'cancel'; dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}

function renderResults() {
  const items = report.providers;
  $('resultMeta').textContent = `${new Date(report.createdAt).toLocaleString()} · ${report.issueSet.repo} · ${report.execute ? '含真实执行' : '模拟运行，未验证修复'} · ${duration(report.durationMs)}`;
  $('cards').innerHTML = items.map((item) => {
    const simulated = item.results.every((result) => result.mode === 'simulated');
    return `<article class="card"><div class="card-heading"><h3>${esc(item.label)}</h3><span class="badge ${simulated ? '' : 'warn'}">${simulated ? '模拟' : '真实 CLI'}</span></div><div class="score">${simulated ? '未验证' : `${item.resolvedBugs} / ${item.totalIssues}`} <small>${simulated ? '' : '已解决'}</small></div><div class="metric"><span>解决率</span><strong>${simulated ? '不适用' : `${(item.resolutionRate * 100).toFixed(1)}%`}</strong></div><div class="metric"><span>${simulated ? '题目关键词命中' : '声明 / 输出关键词'}</span><strong>${item.foundBugs}</strong></div><div class="metric"><span>平均任务耗时</span><strong>${simulated ? '不适用' : duration(item.averageDurationMs)}</strong></div></article>`;
  }).join('');
  const labels = { simulated: '未执行', passed: '验证通过', failed: '验证失败', missing: '缺少 checks', 'not-run': '执行失败' };
  $('resultDetails').innerHTML = items.flatMap((item) => item.results.map((result) => {
    const issue = report.issueSet.issues.find((issue) => issue.id === result.issueId);
    return `<details><summary>${esc(item.label)} · ${esc(issue?.title ?? result.issueId)} <span class="badge ${result.resolved ? 'good' : result.verification === 'simulated' ? '' : 'warn'}">${labels[result.verification] ?? '未验证'}</span></summary><div class="detail-body"><p>${esc(result.issueId)} · ${duration(result.durationMs)}${result.exitCode !== undefined ? ` · exit ${result.exitCode}` : ''}</p>${result.error ? `<p class="error-text">${esc(result.error)}</p>` : ''}<pre tabindex="0">${esc(result.output || '无标准输出')}${result.outputTruncated ? '\n[输出已截断]' : ''}</pre>${(result.checks ?? []).map((check) => `<p>${esc(check.id)} · ${check.passed ? 'PASS' : 'FAIL'} · exit ${check.exitCode}</p><pre tabindex="0">${esc(check.output || '无输出')}</pre>`).join('')}</div></details>`;
  })).join('');
}

$('providers').innerHTML = providers.map((provider, index) => `<label class="provider"><input type="checkbox" data-provider="${index}" ${provider.enabled ? 'checked' : ''}><span>${provider.label}</span><small>${provider.id === 'local-sim' ? '离线' : 'CLI'}</small></label>`).join('');
for (const input of document.querySelectorAll('[data-provider]')) input.addEventListener('change', () => { providers[Number(input.dataset.provider)].enabled = input.checked; updateControls(); });
for (const input of document.querySelectorAll('input[name=mode]')) input.addEventListener('change', updateControls);
$('issues').addEventListener('input', () => { dirty = true; updateCount(); });
$('cancel').addEventListener('click', () => { current?.controller.abort(); updateControls(); });
$('format').addEventListener('click', () => { try { $('issues').value = JSON.stringify(parseIssues(), null, 2); updateCount(); } catch (error) { status(error.message, 'error'); } });
$('exportIssues').addEventListener('click', () => { try { download(parseIssues(), 'issues.json'); } catch (error) { status(error.message, 'error'); } });
$('exportResults').addEventListener('click', () => { if (report) download(report, `comparison-${report.createdAt.replaceAll(':', '-')}.json`); });
$('exportQuality').addEventListener('click', () => { if (qualityReport) download(qualityReport.output, 'quality.log', 'text/plain'); });
$('import').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async () => {
  const file = $('file').files[0]; if (!file) return;
  try {
    if (file.size > 2_000_000) throw new Error('任务文件不能超过 2 MB');
    const text = await file.text(); parseIssues(text);
    if (current || remoteActive) throw new Error('任务运行中，暂不能替换任务集');
    $('issues').value = text; dirty = true; updateCount(); status(`已导入 ${file.name}`);
  } catch (error) { status(error.message, 'error'); }
  finally { $('file').value = ''; }
});

async function sample() {
  if (dirty && !window.confirm('替换当前任务集？尚未导出的修改将丢失。')) return;
  await action('加载示例中', async (signal) => {
    const data = await request('/example.json', { signal }); parseIssues(JSON.stringify(data));
    $('issues').value = JSON.stringify(data, null, 2); dirty = false; updateCount(); status('示例已加载');
  });
}
$('sample').addEventListener('click', sample);
$('loadGithub').addEventListener('click', () => action('读取 GitHub Issues 中', async (signal) => {
  const repo = $('githubRepo').value.trim();
  const limit = Number($('githubLimit').value);
  if (!repo) throw new Error('请输入 owner/repo');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('数量应为 1-100');
  if (dirty && !window.confirm('用 GitHub Issues 替换当前任务集？')) { status('已取消读取'); return; }
  const data = await request(`/api/github/issues?repo=${encodeURIComponent(repo)}&limit=${limit}`, { signal });
  if (!data.issues?.length) throw new Error('本页没有 Issue（可能均为 Pull Request），已保留当前任务集');
  parseIssues(JSON.stringify(data));
  $('issues').value = JSON.stringify(data, null, 2); dirty = true; updateCount(); status(`已读取 ${data.issues.length} 条 Issue`);
}));
$('run').addEventListener('click', async () => {
  if (current || remoteActive) return;
  const execute = $('execute').checked;
  if (execute && !await confirmExternal()) return;
  await action('对比运行中', async (signal) => {
    const issueSet = parseIssues();
    const started = Date.now();
    const selected = providers.map((provider) => ({ id: provider.id, enabled: provider.enabled }));
    const items = await request('/api/compare', { signal, body: { issueSet, providers: selected, repoRoot: $('repoRoot').value || '.', execute, confirmExternal: execute } });
    if (!Array.isArray(items) || !items.length) throw new Error('服务返回了空的对比结果');
    report = { version: 1, createdAt: new Date().toISOString(), durationMs: Date.now() - started, execute, issueSet, providers: items };
    renderResults(); showTab('results'); status(execute ? '对比完成' : '模拟完成，未执行 CLI 或验证');
  });
});
$('quality').addEventListener('click', () => action('质量检查运行中', async (signal) => {
  qualityReport = undefined; updateControls();
  showTab('qualityLog'); $('qualityMeta').textContent = '运行中'; $('qualityOutput').textContent = '等待 check:ci 完成…';
  try {
    qualityReport = await request('/api/quality', { signal, body: {} });
    $('qualityMeta').textContent = `${qualityReport.passed ? '通过' : '失败'} · ${duration(qualityReport.durationMs)}${qualityReport.timedOut ? ' · 超时' : ''}${qualityReport.truncated ? ' · 输出已截断' : ''}`;
    $('qualityOutput').textContent = qualityReport.output || '无输出'; status(qualityReport.passed ? '质量检查通过' : '质量检查失败', qualityReport.passed ? '' : 'error');
  } catch (error) { $('qualityMeta').textContent = signal.aborted ? '已取消' : '请求失败'; $('qualityOutput').textContent = signal.aborted ? '已请求停止任务' : error.message; throw error; }
}));

icons();
await updateHealth();
await sample();
setInterval(() => { if (current) $('elapsed').textContent = duration(Date.now() - current.started); }, 500);
setInterval(updateHealth, 4000);
