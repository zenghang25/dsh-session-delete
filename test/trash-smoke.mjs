/**
 * Real Recycle Bin smoke test for index.js.
 *
 * Unlike host-smoke.mjs (which stubs the move), this drives the production
 * helper: a temporary Session-shaped directory is handed to Windows, and the
 * test then proves from the shell's Recycle Bin namespace that the directory
 * really landed there with its full subtree — not that it was permanently
 * deleted. It removes the recycled item afterwards, unless KEEP is set.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PLUGIN = path.resolve(import.meta.dirname, '..', 'index.js');
const { __testing } = await import(new URL(`file://${PLUGIN.replaceAll('\\', '/')}`));

assert.equal(typeof __testing.trashDirectory, 'function', 'the production Recycle Bin helper must be exported for verification');

const ROOT = path.resolve(
  import.meta.dirname,
  '..',
  'tmp',
  'trash-smoke',
  `dsd 回收站 测试 ${process.pid}-${Date.now()}`,
);
const NESTED = path.join(ROOT, 'nested');
await rm(ROOT, { recursive: true, force: true });
await mkdir(NESTED, { recursive: true });
await writeFile(path.join(ROOT, 'session.v4.jsonl.zstd'), '{"id":"smoke"}\n', 'utf8');
await writeFile(path.join(NESTED, 'payload 数据.txt'), 'keep me', 'utf8');

const result = await __testing.trashDirectory(ROOT);
assert.equal(result.ok, true, `the Recycle Bin move must succeed: ${result.detail ?? ''}`);

const gone = await stat(ROOT).then(
  () => false,
  () => true,
);
assert.equal(gone, true, 'the directory must be gone from its original path');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$name = $env:DSH_TRASH_NAME
$from = $env:DSH_TRASH_FROM
$shell = New-Object -ComObject Shell.Application
$bin = $shell.Namespace(10)
foreach ($item in $bin.Items()) {
  if ($item.Name -ne $name) { continue }
  if ($item.ExtendedProperty('System.Recycle.DeletedFrom') -ne $from) { continue }
  $log = Join-Path $item.Path 'session.v4.jsonl.zstd'
  $nested = Join-Path $item.Path 'nested\payload 数据.txt'
  if ((Test-Path -LiteralPath $log) -and (Test-Path -LiteralPath $nested)) {
    [Console]::Out.WriteLine($item.Path)
    exit 0
  }
  exit 3
}
exit 2
`;
const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
const { stdout } = await run(
  'powershell.exe',
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
  {
    env: { ...process.env, DSH_TRASH_NAME: path.basename(ROOT), DSH_TRASH_FROM: path.dirname(ROOT) },
    windowsHide: true,
  },
);
const recycledPath = stdout.trim();
assert.notEqual(recycledPath, '', 'the Recycle Bin must contain the directory with its full subtree');
console.log(`trash smoke: OK — recycled to ${recycledPath}`);

if (process.env.KEEP !== '1') {
  /* A Recycle Bin entry is the $R payload plus its $I metadata record. Removing
     both is how a script empties one entry without clearing the user's bin. */
  const infoPath = recycledPath.replace(/\\\$R([^\\]+)$/, '\\$I$1');
  await rm(recycledPath, { recursive: true, force: true });
  await rm(infoPath, { force: true });
}
