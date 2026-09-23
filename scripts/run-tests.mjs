// 测试入口：`npm test -- --run`。`--run` 为兼容标志（本运行器始终一次性运行）。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const passthrough = process.argv.slice(2).filter((a) => a !== '--run');
const args = [
  '--disable-warning=ExperimentalWarning',
  '--test',
  '--test-reporter=spec',
  'tests/**/*.test.ts',
  ...passthrough,
];
const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
