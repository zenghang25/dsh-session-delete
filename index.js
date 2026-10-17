/**
 * dsh-session-delete — Host half: move one conversation (Session) and its
 * local artifacts to the operating system's Recycle Bin.
 *
 * Why this plugin removes the artifact itself: DSH 0.2.1 publishes no
 * Session-deletion capability. The workspace controller exposes only
 * archive/unarchive/pin/unpin, and `workspaceRegistry.archiveSession` merely
 * hides a Session. Deleting therefore means disposing of the Session's own
 * artifact directory under the persistence root — the same filesystem work the
 * JSONL persistence backend does for its own artifacts.
 *
 * Unlike a permanent `rm`, the artifact is handed to the Windows Recycle Bin
 * (`SHFileOperationW` with `FOF_ALLOWUNDO`), so the user can restore it from
 * the Recycle Bin. Nothing is permanently removed by this plugin.
 *
 * Routes (registered on `ctx.webServer`, same-origin, behind the composition's
 * Host/Origin + browser-authentication fence):
 *
 *   POST /dsh-session-delete/probe
 *   body { "sessionId": string }
 *   200 { ok: true, deletable: boolean, code?: string, detail?: string,
 *         needsStop?: boolean, live?: boolean }
 *       — answers the preflight the confirmation dialog shows BEFORE the
 *         operator commits, so a refusal is explained instead of discovered by
 *         clicking. `needsStop` is a hint, not a refusal: the Session has
 *         running work, so the deletion will need the stop-and-delete form.
 *         `live` is likewise a notice, not a refusal: this process holds the
 *         Session, so it is flushed first.
 *
 *   POST /dsh-session-delete/delete
 *   body { "sessionId": string, "stopActivity"?: boolean }
 *   200 { ok: true }
 *   400 { ok: false, code: 'bad-body' | 'bad-args' }
 *   404 { ok: false, code: 'missing' }
 *   409 { ok: false, code: 'busy' }
 *   500 { ok: false, code: string, detail?: string }
 *
 * Both routes run the SAME preflight (`resolveDeletableTarget`), so the probe
 * can never disagree with the deletion about what is deletable.
 *
 * The order of operations in the deletion is deliberate and load-bearing:
 *
 *   1. Resolve the stored header. `sessionPersistence.list()` yields snapshots
 *      of the shape `{ header, formatStatus, revision, sizeBytes }`, so the id
 *      and cwd live on `snapshot.header` — never on the snapshot itself.
 *   2. Archive *before* touching the filesystem. `archiveSession` refuses a
 *      Session it can no longer find (`sessionKnown` re-lists persistence), so
 *      archiving after the move could never hide the row; and a row whose
 *      artifact is gone but which is still unarchived stays on screen as a
 *      ghost until the next registry reindex. The durable archive set is also
 *      the gate every later agent wake reads at `agent/pre-step`, so once it is
 *      written the Session cannot produce another event.
 *   3. Drain a LIVE Session. A Session that is live in this process (it was
 *      created or opened during this run) still holds in-memory events. The
 *      JSONL backend appends with `open(path, 'a')`, so removing the artifact
 *      while events remain buffered could later recreate a prefix-less log.
 *      `ctx.sessions.flush` is the documented durability barrier, so it runs
 *      after the archive gate is in place and before the move; a failed flush
 *      aborts the deletion rather than risk corrupting the log.
 *   4. Drop the workspace accounting slot (bookkeeping; the row is already
 *      hidden by the archive, and detaching keeps per-workspace order clean).
 *   5. Move the artifact directory to the Recycle Bin.
 *
 * A failure after step 2 leaves the Session hidden but still on disk: the
 * route reports it, and retrying completes the move, because an already
 * archived id resolves without writing.
 */
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, parse as parsePath, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const MODULE = 'dsh-session-delete';
const ROUTE_DELETE = '/dsh-session-delete/delete';
const ROUTE_PROBE = '/dsh-session-delete/probe';
/** Refuse bodies larger than this; the only legitimate body is one small object. */
const MAX_BODY_BYTES = 64 * 1024;
/** Canonical JSONL generation suffixes written by the persistence backend. */
const ARTIFACT_SUFFIXES = ['.jsonl', '.jsonl.zstd'];
/** The recursion is local, so a hanging Recycle Bin call is a bug, not a slow disk. */
const TRASH_TIMEOUT_MS = 30_000;

const execFileAsync = promisify(execFile);

/**
 * The Recycle Bin helper. `SHFileOperationW` is the shell's own delete path,
 * so a directory arrives in the bin with its whole subtree and an undo record.
 * The flags silence every prompt: this runs in a background Host, where a modal
 * dialog would hang the route forever.
 *
 * `pFrom` is a double-NUL-terminated path list; the CLR marshaler appends the
 * final terminator to the explicit `"\0"`.
 */
const RECYCLE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:DSH_SESSION_DELETE_TARGET
if ([string]::IsNullOrWhiteSpace($target)) {
  [Console]::Error.WriteLine('dsh-session-delete: missing target')
  exit 2
}
if (-not (Test-Path -LiteralPath $target)) { exit 0 }
$source = @"
using System;
using System.Runtime.InteropServices;

public static class DshSessionDeleteRecycle {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct SHFILEOPSTRUCTW {
    public IntPtr hwnd;
    public uint wFunc;
    [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;
    [MarshalAs(UnmanagedType.LPWStr)] public string pTo;
    public ushort fFlags;
    [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
    public IntPtr hNameMappings;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle;
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern int SHFileOperationW(ref SHFILEOPSTRUCTW lpFileOp);

  public static int MoveToRecycleBin(string path) {
    SHFILEOPSTRUCTW operation = new SHFILEOPSTRUCTW();
    operation.wFunc = 3; // FO_DELETE
    operation.pFrom = path + "\0";
    operation.fFlags = 0x0040 | 0x0010 | 0x0004 | 0x0400; // ALLOWUNDO | NOCONFIRMATION | SILENT | NOERRORUI
    int result = SHFileOperationW(ref operation);
    if (operation.fAnyOperationsAborted) return result == 0 ? 0x04C7 : result;
    return result;
  }
}
"@
Add-Type -TypeDefinition $source -Language CSharp
$result = [DshSessionDeleteRecycle]::MoveToRecycleBin($target)
if ($result -ne 0) {
  [Console]::Error.WriteLine(('dsh-session-delete: SHFileOperationW failed 0x{0:X8}' -f $result))
  exit 1
}
exit 0
`;

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function textOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  const message = value.message;
  if (typeof message === 'string') return message;
  try {
    return String(value);
  } catch {
    return '';
  }
}

/** Read and parse a bounded JSON body. */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return { kind: 'too-large' };
    chunks.push(chunk);
  }
  if (size === 0) return { kind: 'value', value: {} };
  try {
    return { kind: 'value', value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { kind: 'invalid' };
  }
}

/** Name-based checks: client/Host plugin bundles do not share error-class identity. */
function errorName(error) {
  if (error === null || error === undefined) return '';
  if (typeof error.name === 'string' && error.name !== 'Error') return error.name;
  const ctor = error.constructor;
  return ctor !== undefined && typeof ctor.name === 'string' ? ctor.name : '';
}

/** The archive refusal that reports running work, matched by name or shape. */
function isActiveSessionError(error) {
  return errorName(error) === 'WorkspaceActiveSessionError' || Array.isArray(error?.activity);
}

function isUnknownSessionError(error) {
  return errorName(error) === 'WorkspaceUnknownSessionError';
}

/**
 * Second, independent gate in front of the Recycle Bin: accept only an
 * absolute directory path at least two levels deep that actually holds a
 * canonical JSONL generation file, so a surprising `locate()` result can never
 * widen the deletion to a parent directory or a filesystem root.
 * @returns an error code, or undefined when the target looks like one Session directory.
 */
async function verifySessionDirectory(dir) {
  if (typeof dir !== 'string' || dir === '' || !isAbsolute(dir)) return 'bad-path';
  if (dir === parsePath(dir).root) return 'bad-path';
  if (dir.split(/[\\/]+/).filter((part) => part !== '').length < 2) return 'bad-path';
  if (basename(dir) === '' || basename(dir) === '.' || basename(dir) === '..') return 'bad-path';
  if (dir.endsWith(sep)) return 'bad-path';
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    return error?.code === 'ENOENT' ? 'gone' : 'unreadable';
  }
  const hasArtifact = entries.some(
    (entry) => entry.isFile() && ARTIFACT_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)),
  );
  return hasArtifact ? undefined : 'not-a-session';
}

/**
 * Move one directory to the Windows Recycle Bin. Resolves the route's
 * `{ ok, code?, detail? }` result instead of throwing, so a shell failure is
 * reported to the operator rather than crashing the handler.
 *
 * The target travels through an environment variable, never through command
 * line interpolation, so a path with quotes, spaces, or non-ASCII characters
 * cannot alter the script. `powershell.exe` is Windows PowerShell 5.1, present
 * on every supported Windows installation; it ships the .NET Framework that
 * `Add-Type` compiles against.
 */
async function trashDirectory(dir) {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      code: 'trash-unsupported',
      detail: `Recycle Bin deletion is implemented for Windows only (this Host runs on ${process.platform}).`,
    };
  }
  const encoded = Buffer.from(RECYCLE_SCRIPT, 'utf16le').toString('base64');
  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        env: { ...process.env, DSH_SESSION_DELETE_TARGET: dir },
        windowsHide: true,
        timeout: TRASH_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
      },
    );
    return { ok: true };
  } catch (error) {
    const detail = [error?.stderr, error?.stdout, textOf(error)].map(textOf).filter((part) => part !== '').join('\n').trim();
    return { ok: false, code: 'trash-failed', detail: detail.slice(0, 2000) };
  }
}

/**
 * The shared preflight: every guard and the target resolution both routes need.
 *
 * `locate()` answers with the Session's *log file*, so the deletion target is
 * that file's directory — the Session directory DSH itself owns. A target that
 * is already `gone` (a Session created but never materialized) counts as
 * deletable: the requested end state already holds, and the Recycle Bin helper
 * is a no-op on it.
 *
 * @returns `{ code, detail? }` when the Session cannot be deleted, otherwise
 *   `{ header, dir, session }` for the caller to act on — `session` is the live
 *   Session object when this process holds one, and `undefined` otherwise.
 */
async function resolveDeletableTarget(deps, sessionId) {
  /* A live Session is NOT a refusal: it only needs its buffered events drained
     before the move. See the module comment, step 3. */
  const session = deps.sessions.get(sessionId);

  /* The stored header, from the snapshot list — the id is nested under `header`. */
  let snapshots;
  try {
    snapshots = await deps.persistence.list();
  } catch (error) {
    return { code: 'list-failed', detail: textOf(error) };
  }
  const snapshot = Array.isArray(snapshots)
    ? snapshots.find((entry) => entry !== null && entry !== undefined && entry.header?.id === sessionId)
    : undefined;
  if (snapshot === undefined) return { code: 'missing' };
  const header = snapshot.header;

  let located;
  try {
    located = deps.persistence.locate(header)?.path;
  } catch {
    located = undefined;
  }
  if (typeof located !== 'string' || located === '') return { code: 'no-location' };

  const dir = dirname(resolve(located));
  if (dir === dirname(dir)) return { code: 'bad-path' };
  const invalid = await verifySessionDirectory(dir);
  if (invalid !== undefined && invalid !== 'gone') return { code: invalid };

  return { header, dir, session };
}

/**
 * Answer what the confirmation dialog should show before the operator commits.
 * @returns the probe payload: either a refusal, or a deletable result that may
 *   still carry the `needsStop` hint and the `live` notice.
 */
async function probeSession(deps, sessionId) {
  const target = await resolveDeletableTarget(deps, sessionId);
  if (target.code !== undefined) {
    return { deletable: false, code: target.code, ...(target.detail === undefined ? {} : { detail: target.detail }) };
  }
  let needsStop = false;
  try {
    const activity = await deps.activity(sessionId);
    needsStop = Array.isArray(activity) && activity.length > 0;
  } catch {
    /* The hint is best-effort; the deletion re-checks and can still escalate. */
    needsStop = false;
  }
  return { deletable: true, needsStop, live: target.session !== undefined };
}

/**
 * Move one Session to the Recycle Bin: preflight, archive, drain, accounting,
 * recycle.
 * @returns `{ code: 'deleted' }` or `{ code, detail? }`.
 */
async function deleteSession(deps, sessionId, stopActivity) {
  const target = await resolveDeletableTarget(deps, sessionId);
  if (target.code !== undefined) return { code: target.code, detail: target.detail };

  /* 2. Hide it first: the archive is what removes the row, it must happen while
   *    the Session is still findable, and its durable set is the gate that stops
   *    every later wake from producing another event. */
  try {
    await deps.registry.archiveSession(sessionId, stopActivity ? { stopActivity: true } : {});
  } catch (error) {
    if (isActiveSessionError(error)) return { code: 'busy', detail: textOf(error) };
    if (isUnknownSessionError(error)) return { code: 'missing' };
    return { code: 'archive-failed', detail: textOf(error) };
  }

  /* 3. A live Session still holds buffered events; drain them while the archive
   *    already blocks new ones, so nothing can recreate the artifact afterwards. */
  if (target.session !== undefined && typeof deps.flush === 'function') {
    try {
      await deps.flush(target.session);
    } catch (error) {
      return { code: 'flush-failed', detail: textOf(error) };
    }
  }

  /* 4. Bookkeeping only: drop the accounting slot wherever it is held. */
  try {
    for (const workspace of deps.registry.list()) {
      if (Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(sessionId)) {
        await workspace.detachSession(sessionId);
        break;
      }
    }
  } catch {
    /* The row is already hidden; a stale slot self-heals on the next reindex. */
  }

  /* 5. The move itself. A failure leaves the directory in place, so the
   *    operator can retry; the Session stays archived but recoverable. */
  const trashed = await deps.trash(target.dir);
  if (!trashed.ok) return { code: trashed.code ?? 'trash-failed', detail: trashed.detail };
  return { code: 'deleted' };
}

/**
 * @param ctx - the Cordis Host context.
 * @param overrides - internal test seam; production uses the real Recycle Bin
 *   helper. Cordis passes this row's config here, which contains no `trash`.
 */
export function apply(ctx, overrides = {}) {
  const trash = typeof overrides?.trash === 'function' ? overrides.trash : trashDirectory;
  const deps = {
    persistence: ctx.sessionPersistence,
    registry: ctx.workspaceRegistry,
    sessions: ctx.sessions,
    activity: (sessionId) => ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([])),
    /* `Sessions.flush(session)` is the documented durability barrier for one
       Session; absent only if a future composition replaces the service. */
    flush: typeof ctx.sessions?.flush === 'function' ? (session) => ctx.sessions.flush(session) : undefined,
    trash,
  };

  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection === undefined) return false;
    res.writeHead(rejection);
    res.end();
    return true;
  };

  /** The shared request preamble: fence, method, and one validated sessionId. */
  const admit = async (req, res) => {
    if (rejected(req, res)) return undefined;
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end();
      return undefined;
    }
    const body = await readJsonBody(req);
    if (body.kind !== 'value') {
      sendJson(res, 400, { ok: false, code: 'bad-body' });
      return undefined;
    }
    const { sessionId } = body.value ?? {};
    if (typeof sessionId !== 'string' || sessionId === '') {
      sendJson(res, 400, { ok: false, code: 'bad-args' });
      return undefined;
    }
    return { sessionId, value: body.value };
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PROBE,
        handler: async (req, res) => {
          const admitted = await admit(req, res);
          if (admitted === undefined) return;
          try {
            sendJson(res, 200, { ok: true, ...(await probeSession(deps, admitted.sessionId)) });
          } catch (error) {
            ctx.logger?.warn?.(`${MODULE}: probing session '${admitted.sessionId}' failed: ${textOf(error)}`);
            sendJson(res, 500, { ok: false, code: 'unexpected', detail: textOf(error) });
          }
        },
      }),
    `${MODULE}: POST ${ROUTE_PROBE}`,
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_DELETE,
        handler: async (req, res) => {
          const admitted = await admit(req, res);
          if (admitted === undefined) return;
          let outcome;
          try {
            outcome = await deleteSession(deps, admitted.sessionId, admitted.value.stopActivity === true);
          } catch (error) {
            ctx.logger?.warn?.(`${MODULE}: deleting session '${admitted.sessionId}' failed: ${textOf(error)}`);
            sendJson(res, 500, { ok: false, code: 'unexpected', detail: textOf(error) });
            return;
          }
          if (outcome.code === 'deleted') {
            ctx.logger?.info?.(`${MODULE}: moved session '${admitted.sessionId}' to the Recycle Bin`);
            sendJson(res, 200, { ok: true });
            return;
          }
          const status = outcome.code === 'missing' ? 404 : outcome.code === 'busy' ? 409 : 500;
          sendJson(res, status, { ok: false, code: outcome.code, detail: outcome.detail ?? '' });
        },
      }),
    `${MODULE}: POST ${ROUTE_DELETE}`,
  );
}

export const inject = ['webServer', 'connection', 'sessionPersistence', 'workspaceRegistry', 'sessions'];

/** Exposed for the host smoke test; not part of the plugin surface. */
export const __testing = { deleteSession, probeSession, resolveDeletableTarget, trashDirectory };
