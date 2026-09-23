import { lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PathPolicy } from '../../src/runtime/path-policy.js';

const root = await mkdtemp(join(tmpdir(), 'echolens-link-probe-root-'));
const outside = await mkdtemp(join(tmpdir(), 'echolens-link-probe-outside-'));
const describeError = (error: unknown): unknown => error instanceof Error
  ? {
    name: error.name,
    message: error.message,
    stack: error.stack,
    properties: Object.fromEntries(Object.getOwnPropertyNames(error).map((key) => [key, (error as any)[key]])),
    cause: error.cause ? describeError(error.cause) : undefined,
  }
  : error;

try {
  const target = join(outside, 'secret.ts');
  const link = join(root, 'file-link.ts');
  const junction = join(root, 'junction');
  await writeFile(target, 'outside secret', 'utf8');
  const result: Record<string, unknown> = {
    nodeVersion: process.version,
    platform: process.platform,
    target,
    targetExists: true,
    fileLink: { path: link },
    junction: { path: junction },
  };
  for (const [label, path, to, type] of [
    ['fileLink', link, target, 'file'],
    ['junction', junction, outside, process.platform === 'win32' ? 'junction' : 'dir'],
  ] as const) {
    try {
      await symlink(to, path, type);
      const linkStat = await lstat(path, { bigint: true });
      Object.assign(result[label] as object, {
        create: 'success',
        lstat: {
          isSymbolicLink: linkStat.isSymbolicLink(),
          isDirectory: linkStat.isDirectory(),
          mode: linkStat.mode.toString(8),
          dev: linkStat.dev.toString(),
          ino: linkStat.ino.toString(),
        },
      });
      const policy = await PathPolicy.create(root);
      try {
        await policy.readTextFile(label === 'fileLink' ? 'file-link.ts' : 'junction\\secret.ts');
        Object.assign(result[label] as object, { read: 'unexpected success' });
      } catch (error) {
        Object.assign(result[label] as object, { readError: describeError(error) });
      }
    } catch (error) {
      Object.assign(result[label] as object, {
        create: 'failure',
        createError: describeError(error),
      });
    }
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]);
}
