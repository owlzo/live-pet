#!/usr/bin/env node
/**
 * 清理构建产物：默认只清 `lib/types`（声明文件），`--all` 连 `lib/*.js` 一起清。
 *
 * 为什么单独做一个脚本：`npm run build` 里 gen-types 会先 `rmSync(lib/types)` 再重写，
 * 但有些环境（沙箱、被安全软件盯上的目录、文件被占用）会在「一次删上百个文件」这一步失败，
 * 于是构建卡在一个说不清的报错上。这里把「删产物」拆成可单独执行、可重复执行的一步，
 * 删完再构建就行；脚本自己只碰 lib 目录，不碰源码。
 *
 * 边界：
 * - 只删 `<包根>/lib` 下的东西，路径越界一律拒绝；
 * - 幂等：目录本来就不存在也算成功（退出码 0）；
 * - 不删 `node_modules`、不删 `runtime/`、不删 `src/`——那些不是产物。
 *
 * 用法：
 *   npm run clean:types        # 只清 lib/types
 *   npm run clean:build        # 清 lib 下的全部构建产物
 * @module live-pet/scripts/clean-types
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包根目录（本脚本在 scripts/ 下）。 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 构建产物目录。 */
const libDir = join(root, 'lib');
/** 类型声明目录（默认清理目标）。 */
const typesDir = join(libDir, 'types');

/** 是否连 lib 下的 js 产物一起清。 */
const cleanAll = process.argv.includes('--all') || process.argv.includes('-a');

/**
 * 递归数一下目录里有多少文件（给「清掉了几个」一个可读数字）。
 *
 * @param dir - 目录；不存在返回 0。
 * @returns 文件数。
 */
function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += countFiles(full);
    else total += 1;
  }
  return total;
}

/**
 * 删除一个目录，并把「删了多少」打出来。
 *
 * @param dir - 目标目录。
 * @param label - 日志里的名字。
 * @returns 删掉的文件数。
 */
function removeDir(dir, label) {
  // 安全兜底：只允许删 lib 及其子目录
  const inside = resolve(dir).startsWith(libDir);
  if (!inside) throw new Error(`拒绝删除 ${dir}：不在 lib 目录内`);
  const files = countFiles(dir);
  if (files === 0) {
    console.log(`[clean] ${label}：本来就没有，跳过`);
    return 0;
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`[clean] ${label}：已删除 ${files} 个文件`);
  return files;
}

/**
 * 删除 lib 顶层的构建产物（js / d.ts / 各类 chunk），保留子目录交给调用方决定。
 *
 * @returns 删掉的文件数。
 */
function removeLibFiles() {
  if (!existsSync(libDir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(libDir, { withFileTypes: true })) {
    const full = join(libDir, entry.name);
    if (entry.isDirectory()) continue; // types 单独处理
    if (statSync(full).isFile()) {
      rmSync(full, { force: true });
      removed += 1;
    }
  }
  if (removed > 0) console.log(`[clean] lib 顶层产物：已删除 ${removed} 个文件`);
  return removed;
}

/** 主流程。 */
function main() {
  if (!existsSync(libDir)) {
    console.log('[clean] 没有 lib 目录，无需清理');
    return;
  }
  let removed = removeDir(typesDir, 'lib/types');
  if (cleanAll) {
    removed += removeLibFiles();
    removed += removeDir(join(libDir, 'chunks'), 'lib/chunks');
  }
  console.log(removed === 0 ? '[clean] 完成：没有需要清理的东西' : `[clean] 完成：共清理 ${removed} 个文件`);
  if (!cleanAll) console.log('[clean] 需要连 js 产物一起清就跑：npm run clean:build');
}

try {
  main();
} catch (error) {
  console.error(`[clean] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
