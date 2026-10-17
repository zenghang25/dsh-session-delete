/**
 * Host-half smoke test for index.js.
 *
 * Drives the real route handlers with a fake ctx and a real temporary session
 * directory, so it verifies behaviour rather than shape:
 *   - the Host/Origin + browser-auth fence is consulted before anything happens,
 *     on both routes;
 *   - method, body size, JSON and argument validation;
 *   - the live-Session refusal and the busy (running work) refusal;
 *   - the snapshot-shaped lookup that the 0.1.0 line got wrong;
 *   - the preflight answers what the dialog shows WITHOUT mutating anything;
 *   - the preflight and the deletion agree, because they share one preflight;
 *   - the ordering guarantee: the archive must happen while the artifact still
 *     exists, because `archiveSession` refuses a Session it cannot re-find;
 *   - the independent "is this really a session directory" gate, including that
 *     a refused target is left untouched;
 *   - successful handoff of the artifact directory to the Recycle Bin helper.
 */
import assert from 'node:assert/strict';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PLUGIN = path.resolve(import.meta.dirname, '..', 'index.js');
const { apply, inject } = await import(new URL(`file://${PLUGIN.replaceAll('\\', '/')}`));

const DELETE_ROUTE = '/dsh-session-delete/delete';
const PROBE_ROUTE = '/dsh-session-delete/probe';

assert.deepEqual(
  inject,
  ['webServer', 'connection', 'sessionPersistence', 'workspaceRegistry', 'sessions'],
  'the Host half must declare exactly the services it uses',
);

const ROOT = path.resolve(import.meta.dirname, '..', 'tmp', 'host-smoke');
await rm(ROOT, { recursive: true, force: true });
await mkdir(ROOT, { recursive: true });

const SESSION_ID = 'session-smoke-0001';
const EVENTS = [];

const artifactExists = (dir) =>
  stat(dir).then(
    () => true,
    () => false,
  );

/**
 * Build one isolated plugin instance over a fresh session directory.
 * @returns the route callers plus the knobs each case needs.
 */
async function harness({ withArtifact = true, projectKey = '--proj--' } = {}) {
  const projectDir = path.join(ROOT, `${projectKey}-${Math.random().toString(36).slice(2)}`);
  const sessionDir = path.join(projectDir, SESSION_ID);
  const logPath = path.join(sessionDir, 'session.v4.jsonl.zstd');
  if (withArtifact) {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(logPath, '{"id":"session-smoke-0001"}\n', 'utf8');
  }

  const state = {
    fence: undefined,
    live: undefined,
    activity: [],
    snapshots: [{ header: { id: SESSION_ID, cwd: projectDir }, revision: 'rev', sizeBytes: 21 }],
    listThrows: undefined,
    archiveThrows: undefined,
    locate: () => ({ kind: 'jsonl', path: logPath }),
    logPath,
    sessionDir,
    archiveCalls: [],
    detachCalls: [],
    flushCalls: [],
    flushThrows: undefined,
    trashCalls: [],
    trashThrows: undefined,
    activityQueries: [],
  };
  EVENTS.length = 0;

  const routes = new Map();
  const ctx = {
    sessionPersistence: {
      list: async () => {
        if (state.listThrows !== undefined) throw state.listThrows;
        /* Faithful to the real backend: once the artifact directory is gone the
           Session is no longer listed, which is what makes a retry report it
           missing rather than deleting again. */
        return (await artifactExists(sessionDir)) ? state.snapshots : [];
      },
      locate: (header) => state.locate(header),
    },
    workspaceRegistry: {
      get: () => undefined,
      list: () => [{ sessionIds: [SESSION_ID], detachSession: async (id) => state.detachCalls.push(id) }],
      archiveSession: async (id, options) => {
        /* The real registry re-lists persistence here; a missing artifact means
           the Session is unfindable, so this is exactly where the ordering
           guarantee has to hold. It then refuses a Session with running work
           unless the caller asked to stop that work. */
        const exists = await artifactExists(state.sessionDir);
        EVENTS.push(`archive(id=${id},stop=${String(options?.stopActivity === true)},artifact=${String(exists)})`);
        state.archiveCalls.push({ id, options });
        if (state.archiveThrows !== undefined) throw state.archiveThrows;
        if (state.activity.length > 0 && options?.stopActivity !== true) {
          const active = new Error('session still has running work');
          active.name = 'WorkspaceActiveSessionError';
          active.activity = state.activity;
          throw active;
        }
      },
      archivedSessionIds: [],
    },
    sessions: {
      get: () => state.live,
      flush: async (session) => {
        EVENTS.push(`flush(id=${session.id})`);
        state.flushCalls.push(session.id);
        if (state.flushThrows !== undefined) throw state.flushThrows;
        return true;
      },
    },
    connection: { requestRejection: () => state.fence },
    waterfall: async (event, request) => {
      assert.equal(event, 'workspace/session-activity', `unexpected waterfall ${event}`);
      state.activityQueries.push(request);
      return state.activity;
    },
    webServer: {
      register: (route) => {
        routes.set(route.path, route);
        return () => {};
      },
    },
    effect: (fn) => {
      fn();
      return () => {};
    },
    logger: { info: () => {}, warn: () => {} },
  };

  apply(ctx, {
    /* The real Host hands the directory to the Windows Recycle Bin. A smoke
       test must not put fixture directories there, so this stands in for it and
       records the exact directory the route selected. */
    trash: async (dir) => {
      state.trashCalls.push(dir);
      if (state.trashThrows !== undefined) {
        return { ok: false, code: 'trash-failed', detail: state.trashThrows.message };
      }
      await rm(dir, { recursive: true, force: true });
      return { ok: true };
    },
  });
  const deleteRoute = routes.get(DELETE_ROUTE);
  const probeRoute = routes.get(PROBE_ROUTE);
  assert.ok(deleteRoute, 'apply must register the delete route');
  assert.ok(probeRoute, 'apply must register the probe route');

  const call = async (route, body, { method = 'POST' } = {}) => {
    const chunks =
      body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')];
    const req = {
      method,
      async *[Symbol.asyncIterator]() {
        yield* chunks;
      },
    };
    let status = 0;
    let payload = '';
    const res = {
      writeHead(code) {
        status = code;
      },
      end(text) {
        payload = text ?? '';
      },
    };
    await route.handler(req, res);
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      parsed = undefined;
    }
    return { status, parsed };
  };

  return {
    state,
    probe: (body, options) => call(probeRoute, body, options),
    remove: (body, options) => call(deleteRoute, body, options),
  };
}

/* --------------------------------------------------------------- the auth fence */
{
  const { probe, remove, state } = await harness();
  state.fence = 401;
  assert.equal((await remove({ sessionId: SESSION_ID })).status, 401, 'the delete route must honour the fence');
  assert.equal((await probe({ sessionId: SESSION_ID })).status, 401, 'the probe route must honour the fence');
  assert.equal(state.archiveCalls.length, 0, 'a fenced request must not touch the registry');
  assert.equal(state.activityQueries.length, 0, 'a fenced probe must not dispatch activity');
  assert.equal(await artifactExists(state.sessionDir), true, 'a fenced request must not delete anything');
  state.fence = 403;
  assert.equal((await probe({ sessionId: SESSION_ID })).status, 403, 'a 403 fence must be passed through');
}

/* ---------------------------------------------------------- request validation */
{
  const { probe, remove, state } = await harness();
  for (const [name, call] of [
    ['delete', remove],
    ['probe', probe],
  ]) {
    assert.equal((await call({ sessionId: SESSION_ID }, { method: 'GET' })).status, 405, `${name} accepts only POST`);
    assert.equal((await call('{not json')).status, 400, `${name} must reject malformed JSON`);
    assert.equal((await call('x'.repeat(70 * 1024))).status, 400, `${name} must reject an oversized body`);
    assert.equal((await call({})).status, 400, `${name} must reject a missing sessionId`);
    assert.equal((await call({ sessionId: '' })).status, 400, `${name} must reject an empty sessionId`);
    assert.equal((await call({ sessionId: 42 })).status, 400, `${name} must reject a non-string sessionId`);
  }
  assert.equal(state.archiveCalls.length, 0, 'validation failures must not reach the registry');
  assert.equal(state.detachCalls.length, 0, 'validation failures must not touch accounting');
  assert.equal(await artifactExists(state.sessionDir), true, 'validation failures must not delete anything');
}

/* -------------------------------------------------------------- probe: no mutation */
{
  const { probe, state } = await harness();
  const res = await probe({ sessionId: SESSION_ID });
  assert.equal(res.status, 200, 'a probe must succeed with HTTP 200');
  assert.deepEqual(
    res.parsed,
    { ok: true, deletable: true, needsStop: false, live: false },
    'a clean cold Session must be deletable',
  );
  assert.equal(state.archiveCalls.length, 0, 'a probe must never archive');
  assert.equal(state.detachCalls.length, 0, 'a probe must never touch accounting');
  assert.equal(await artifactExists(state.sessionDir), true, 'a probe must never delete anything');
  assert.deepEqual(state.activityQueries, [{ sessionId: SESSION_ID }], 'a deletable probe must ask about activity');
}
{
  const { probe } = await harness();
  const res = await probe({ sessionId: SESSION_ID });
  assert.deepEqual(
    res.parsed,
    { ok: true, deletable: true, needsStop: false, live: false },
    'a plain probe must report neither a stop hint nor liveness',
  );
}

/* ------------------------------------------------- probe: the needsStop hint */
{
  const { probe, remove, state } = await harness();
  state.activity = [{ kind: 'job' }];
  const res = await probe({ sessionId: SESSION_ID });
  assert.deepEqual(
    res.parsed,
    { ok: true, deletable: true, needsStop: true, live: false },
    'running work must be reported as a hint, not a refusal',
  );
  /* The hint tells the dialog to open in its stop-and-delete form, which is the
     only form that may proceed while work is running. */
  const removed = await remove({ sessionId: SESSION_ID, stopActivity: true });
  assert.equal(removed.status, 200, 'the confirmed form must proceed despite the running work');
  assert.equal(await artifactExists(state.sessionDir), false, 'the hinted deletion must still remove the directory');
}

/* ------------------------------------------------------ probe: hard refusals */
{
  /* A live Session is a NOTICE, not a refusal: it is still deletable. */
  const { probe, state } = await harness();
  state.live = { id: SESSION_ID };
  const res = await probe({ sessionId: SESSION_ID });
  assert.equal(res.parsed.ok, true, 'a probe must succeed for a live Session');
  assert.equal(res.parsed.deletable, true, 'a live Session must be reported deletable');
  assert.equal(res.parsed.live, true, 'the probe must report that this process holds the Session');
  assert.equal(res.parsed.needsStop, false, 'an idle live Session must not ask to stop anything');
  assert.deepEqual(state.activityQueries, [{ sessionId: SESSION_ID }], 'a live probe must still check for activity');
  assert.equal(state.archiveCalls.length, 0, 'a probe must never archive');
}
{
  const { probe } = await harness();
  const res = await probe({ sessionId: SESSION_ID });
  assert.equal(res.parsed.live, false, 'a cold Session must be reported as not live');
}
{
  const { probe, state } = await harness();
  state.snapshots = [{ header: { id: 'session-other', cwd: 'x' } }];
  const res = await probe({ sessionId: SESSION_ID });
  assert.equal(res.parsed.deletable, false);
  assert.equal(res.parsed.code, 'missing', 'a Session absent from persistence must be reported missing');
}
{
  const { probe, state } = await harness();
  state.listThrows = new Error('storage fault');
  const res = await probe({ sessionId: SESSION_ID });
  assert.equal(res.parsed.code, 'list-failed', 'a storage fault must not masquerade as a missing Session');
  assert.equal(res.parsed.detail, 'storage fault');
}
{
  const { probe, state } = await harness();
  state.locate = () => undefined;
  const res = await probe({ sessionId: SESSION_ID });
  assert.equal(res.parsed.deletable, false);
  assert.equal(res.parsed.code, 'no-location', 'an unresolvable location must be reported before committing');
  assert.equal(await artifactExists(state.sessionDir), true, 'a refused probe must delete nothing');
}
{
  /* A directory that is not a Session artifact directory must survive untouched. */
  const { probe, remove, state } = await harness({ withArtifact: false });
  await mkdir(state.sessionDir, { recursive: true });
  await writeFile(path.join(state.sessionDir, 'important.txt'), 'keep me', 'utf8');
  const probed = await probe({ sessionId: SESSION_ID });
  assert.equal(probed.parsed.deletable, false, 'a non-session directory must be refused by the probe');
  assert.equal(probed.parsed.code, 'not-a-session');
  const removed = await remove({ sessionId: SESSION_ID });
  assert.equal(removed.status, 500, 'the deletion must refuse the same target');
  assert.equal(removed.parsed.code, 'not-a-session');
  assert.equal(await artifactExists(state.sessionDir), true, 'the refused directory must still exist');
  assert.equal(state.archiveCalls.length, 0, 'a refused target must not be archived');
}
{
  const { probe, state } = await harness();
  state.locate = () => ({ kind: 'jsonl', path: path.parse(state.sessionDir).root });
  const res = await probe({ sessionId: SESSION_ID });
  assert.equal(res.parsed.code, 'bad-path', 'a filesystem root must never be a deletion target');
}

/* ------------------------------------------- snapshot-shaped lookup (0.1.0 bug) */
{
  const { remove, state } = await harness();
  state.snapshots = [{ header: { id: 'session-other', cwd: 'x' } }];
  const res = await remove({ sessionId: SESSION_ID });
  assert.equal(res.status, 404, 'a Session absent from persistence must be reported missing');
  assert.equal(res.parsed.code, 'missing');
  assert.equal(state.archiveCalls.length, 0);
}
{
  /* Running work is still a refusal — the operator must confirm stopping it. */
  const { remove, state } = await harness();
  state.activity = [{ kind: 'job' }];
  const res = await remove({ sessionId: SESSION_ID });
  assert.equal(res.status, 409, 'a busy Session must be refused');
  assert.equal(res.parsed.code, 'busy');
  assert.equal(res.parsed.detail, 'session still has running work', 'the refusal must carry the registry reason');
  assert.equal(state.flushCalls.length, 0, 'a refused deletion must not flush');
  assert.equal(await artifactExists(state.sessionDir), true, 'a busy Session must not be deleted');

  /* The confirmed stop-and-delete form then succeeds, live or not. */
  const confirmed = await remove({ sessionId: SESSION_ID, stopActivity: true });
  assert.equal(confirmed.status, 200, 'the confirmed stop-and-delete must succeed');
  assert.equal(state.archiveCalls[1].options.stopActivity, true, 'the confirmation must reach the registry');
  assert.equal(await artifactExists(state.sessionDir), false, 'the confirmed deletion must remove the directory');
}

/* ---------------------------------------------------------- live Session removal */
{
  /* A live but idle Session deletes, and its buffered events are drained between
     the archive gate and the removal. */
  const { remove, state } = await harness();
  state.live = { id: SESSION_ID };
  const res = await remove({ sessionId: SESSION_ID });
  assert.equal(res.status, 200, 'a live idle Session must be deletable');
  assert.deepEqual(
    EVENTS,
    [
      `archive(id=${SESSION_ID},stop=false,artifact=true)`,
      `flush(id=${SESSION_ID})`,
    ],
    'the live Session must be archived (which gates later wakes) and then flushed before the removal',
  );
  assert.deepEqual(state.flushCalls, [SESSION_ID], 'the live Session must be flushed exactly once');
  assert.equal(await artifactExists(state.sessionDir), false, 'the live Session artifact must be gone');
}
{
  /* A failed drain must abort the deletion rather than risk a prefix-less log. */
  const { remove, state } = await harness();
  state.live = { id: SESSION_ID };
  state.flushThrows = new Error('disk full');
  const res = await remove({ sessionId: SESSION_ID });
  assert.equal(res.status, 500, 'a failed flush must be reported');
  assert.equal(res.parsed.code, 'flush-failed');
  assert.equal(res.parsed.detail, 'disk full');
  assert.equal(await artifactExists(state.sessionDir), true, 'a failed flush must leave the artifact in place');
}
{
  /* Without the live Session object there is nothing to flush. */
  const { remove, state } = await harness();
  const res = await remove({ sessionId: SESSION_ID });
  assert.equal(res.status, 200);
  assert.deepEqual(state.flushCalls, [], 'a cold Session must not be flushed');
}

/* ------------------------------------------------------ the ordering guarantee */
{
  const { remove, state } = await harness();
  const res = await remove({ sessionId: SESSION_ID });
  assert.equal(res.status, 200, 'a valid Session must be deleted');
  assert.equal(res.parsed.ok, true);
  assert.deepEqual(
    EVENTS,
    [`archive(id=${SESSION_ID},stop=false,artifact=true)`],
    'the archive must run while the artifact still exists — that is the 0.1.0 ordering bug',
  );
  assert.equal(state.archiveCalls.length, 1, 'the archive must run exactly once');
  assert.deepEqual(state.detachCalls, [SESSION_ID], 'the accounting slot must be dropped');
  assert.deepEqual(state.trashCalls, [state.sessionDir], 'exactly the Session directory must be handed to the Recycle Bin');
  assert.equal(await artifactExists(state.sessionDir), false, 'the artifact directory must be gone');
  assert.equal(await artifactExists(path.dirname(state.sessionDir)), true, 'the project directory must survive');
}

/* ------------------------------------------------------ recycle failure is safe */
{
  const { remove, state } = await harness();
  state.trashThrows = new Error('the Recycle Bin is unavailable');
  const res = await remove({ sessionId: SESSION_ID });
  assert.equal(res.status, 500, 'a failed Recycle Bin move must be reported');
  assert.equal(res.parsed.code, 'trash-failed');
  assert.equal(res.parsed.detail, 'the Recycle Bin is unavailable');
  assert.equal(await artifactExists(state.sessionDir), true, 'a failed Recycle Bin move must leave the artifact in place');
  assert.deepEqual(state.detachCalls, [SESSION_ID], 'the accounting slot is dropped before the move');
}

/* ------------------------------------------------- stopActivity and retry paths */
{
  const { remove, state } = await harness();
  const res = await remove({ sessionId: SESSION_ID, stopActivity: true });
  assert.equal(res.status, 200);
  assert.equal(state.archiveCalls[0].options.stopActivity, true, 'stopActivity must reach the registry');
  assert.equal(await artifactExists(state.sessionDir), false);
}
{
  /* A retry on an already-deleted Session must report it as gone, not delete
     something else and not claim success twice. */
  const { remove } = await harness();
  const first = await remove({ sessionId: SESSION_ID });
  assert.equal(first.status, 200, 'the first attempt deletes');
  const second = await remove({ sessionId: SESSION_ID });
  assert.equal(second.status, 404, 'a second attempt reports the Session as gone');
}

await rm(ROOT, { recursive: true, force: true });
console.log(
  'host smoke: OK — fence, validation, preflight, refusals, safety gate, ordering guarantee and Recycle Bin handoff verified',
);
