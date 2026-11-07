/** 共享：在 ~/.dsh/sessions 下按版本号收集 session.v*.jsonl.zstd（v 号大的在前）。 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function findSamples() {
  const root = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions');
  let dirs;
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  const found = [];
  for (const dir of dirs) {
    const sessionDir = join(root, dir);
    if (!statSync(sessionDir).isDirectory()) continue;
    for (const sub of readdirSync(sessionDir)) {
      const candidate = join(sessionDir, sub);
      if (!statSync(candidate).isDirectory()) continue;
      for (const file of readdirSync(candidate)) {
        const match = /^session\.v(\d+)\.jsonl\.zstd$/.exec(file);
        if (match) found.push({ version: Number(match[1]), path: join(candidate, file) });
      }
    }
  }
  return found.sort((a, b) => b.version - a.version);
}
