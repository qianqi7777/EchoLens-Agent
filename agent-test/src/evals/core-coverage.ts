const CORE_DIRECTORIES = ['runtime', 'orchestration', 'providers', 'session', 'sandbox', 'skills'] as const;

/** 固定核心目录和完整 LCOV 分母，避免缩小范围后仍声称核心行覆盖率达标。 */
export function coreCoverage(lcov: string): { covered: number; total: number; percent: number; passed: boolean } {
  const directories = new Set<string>();
  const files = new Set<string>();
  let covered = 0;
  let total = 0;
  for (const record of lcov.split('end_of_record')) {
    const source = /^SF:(.+)$/mu.exec(record)?.[1]?.replaceAll('\\', '/').trim();
    const directory = source && /(?:^|\/)src\/([^/]+)\//u.exec(source)?.[1];
    if (!source || !CORE_DIRECTORIES.some((name) => name === directory)) continue;
    if (files.has(source)) throw new Error(`核心覆盖率含重复文件：${source}`);
    files.add(source);
    directories.add(directory!);
    const hit = /^LH:(\d+)$/mu.exec(record)?.[1];
    const found = /^LF:(\d+)$/mu.exec(record)?.[1];
    if (hit === undefined || found === undefined || Number(hit) > Number(found)) throw new Error('核心 LCOV 行计数无效');
    covered += Number(hit);
    total += Number(found);
  }
  if (!total || CORE_DIRECTORIES.some((name) => !directories.has(name))) throw new Error('核心 LCOV 缺少固定目录或行计数');
  return { covered, total, percent: covered / total * 100, passed: covered * 100 >= total * 95 };
}
