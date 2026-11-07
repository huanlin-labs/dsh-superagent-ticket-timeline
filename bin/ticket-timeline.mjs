#!/usr/bin/env node
// 薄壳：真正的逻辑在 src/cli.mjs（可被测试直接 import，不必起子进程）。
import { run } from '../src/cli.mjs';

process.exitCode = await run(process.argv.slice(2));