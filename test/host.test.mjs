/**
 * Host 半行为测试：不启动真 DSH，用最小 mock 替代 cordis 服务，文件系统用临时目录。
 *
 * 覆盖 v0.4.0 的语义：
 *   - 一次删除清空：日志目录 → 投影缓存 → `.dsh-sessions/<id>` 产出目录 → detach/归档账目
 *   - 子代理子会话（parentSession 链）一并删除
 *   - 幂等：幽灵会话（只有投影缓存）、完全不存在 id 都返回成功而不是 missing
 *   - live 会话：先 archive(stopActivity)，等它退出后再删文件
 *   - agent/created：建立 `.dsh-sessions/<id>/` 并注册 per-agent 系统提示词段
 *   - 启动对账：清理不存在会话的归档 id 与孤立投影缓存
 *
 * 运行：node test/host.test.mjs
 */
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const testRoot = await fsp.mkdtemp(join(tmpdir(), 'dsh-session-delete-host-'))
process.env.DSH_HOME = join(testRoot, 'home')
const home = process.env.DSH_HOME
const workspaceRoot = join(testRoot, 'workspace')

const plugin = (await import('../index.js')).default
const internals = (await import('../index.js')).__internals

async function writeFile(target, content) {
  await fsp.mkdir(dirname(target), { recursive: true })
  await fsp.writeFile(target, content)
}

async function exists(target) {
  try {
    await fsp.stat(target)
    return true
  } catch {
    return false
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 一套 mock 服务 + 路由捕获。 */
function makeHarness(state) {
  const routes = new Map()
  const listeners = new Map()
  const disposers = []
  const calls = { archive: [], unarchive: [], unpin: [], detach: [] }

  const workspace = {
    sessionIds: [...(state.attached ?? [])],
    async detachSession(id) {
      calls.detach.push(id)
      workspace.sessionIds = workspace.sessionIds.filter((x) => x !== id)
    },
  }

  const ctx = {
    webServer: {
      register(spec) {
        routes.set(spec.path, spec.handler)
        return () => routes.delete(spec.path)
      },
    },
    sessionPersistence: {
      async stat(id) {
        return state.headers[id] === undefined ? undefined : { header: state.headers[id], revision: 'rev' }
      },
      async list() {
        return Object.values(state.headers).map((header) => ({ header, revision: 'rev' }))
      },
      locate(header) {
        return { kind: 'jsonl', path: join(home, 'sessions', '--proj--', header.id, 'session.v4.jsonl.zstd') }
      },
    },
    workspaceRegistry: {
      list() {
        return [workspace]
      },
      get archivedSessionIds() {
        return [...state.archived]
      },
      async archiveSession(id, options) {
        calls.archive.push({ id, stop: options !== undefined && options.stopActivity === true })
        if (!state.archived.includes(id)) state.archived.push(id)
      },
      async unarchiveSession(id) {
        calls.unarchive.push(id)
        state.archived = state.archived.filter((x) => x !== id)
      },
      async unpinSession(id) {
        calls.unpin.push(id)
      },
    },
    sessions: {
      get(id) {
        const live = state.live[id]
        if (live === undefined) return undefined
        live.polls = (live.polls ?? 0) + 1
        return live.polls > (live.disappearAfter ?? 0) ? undefined : live
      },
      list() {
        return Object.values(state.live)
      },
      async flush() {
        if (state.flushError !== undefined) throw state.flushError
      },
    },
    connection: {
      requestRejection() {
        return state.rejection
      },
    },
    on(name, callback) {
      listeners.set(name, callback)
      return () => listeners.delete(name)
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }

  plugin.apply(ctx)
  return { ctx, routes, listeners, disposers, calls, workspace }
}

async function callRoute(routes, path, body, method = 'POST') {
  const handler = routes.get(path)
  assert.ok(handler !== undefined, `route registered: ${path}`)
  const req = {
    method,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body))
    },
  }
  const res = {
    status: 0,
    payload: null,
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.payload = text === undefined ? null : JSON.parse(text)
    },
  }
  await handler(req, res)
  return res
}

/** 造一个会话：header、日志目录、投影缓存、产出目录。 */
async function seedSession(state, { id, cwd, parentSession }) {
  const header = { version: 4, id, createdAt: Date.now(), isSeeded: false, cwd }
  if (parentSession !== undefined) header.parentSession = parentSession
  state.headers[id] = header
  await writeFile(join(home, 'sessions', '--proj--', id, 'session.v4.jsonl.zstd'), 'session-log')
  await writeFile(join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`), JSON.stringify({ version: 7, record: { identity: { cwd } } }))
  await writeFile(join(cwd, '.dsh-sessions', id, 'outputs', 'result.txt'), 'artifact')
  await writeFile(join(cwd, '.dsh-sessions', id, 'memory.md'), '# memory')
  return header
}

async function test(name, fn) {
  try {
    await fn()
    console.log('ok   -', name)
  } catch (error) {
    console.error('FAIL -', name)
    console.error(error)
    process.exitCode = 1
  }
}

try {
  await test('一次删除清空父会话 + 子代理子会话：日志/缓存/产出目录/工作区账目', async () => {
    const state = { headers: {}, live: {}, archived: [], attached: [] }
    const cwd = join(workspaceRoot, 'case-parent')
    await seedSession(state, { id: 'session-parent', cwd })
    await seedSession(state, { id: 'session-child', cwd, parentSession: 'session-parent' })
    state.attached = ['session-parent']
    const harness = makeHarness(state)

    const res = await callRoute(harness.routes, '/dsh-session-delete/delete', { sessionId: 'session-parent' })
    assert.equal(res.status, 200)
    assert.equal(res.payload.ok, true)
    assert.deepEqual(res.payload.deleted.sort(), ['session-child', 'session-parent'])

    assert.equal(await exists(join(home, 'sessions', '--proj--', 'session-parent')), false, '父会话日志目录已删')
    assert.equal(await exists(join(home, 'sessions', '--proj--', 'session-child')), false, '子会话日志目录已删')
    assert.equal(await exists(join(home, 'storages', 'session_projcache', 'sessions', 'session-parent.json')), false, '父会话投影缓存已删')
    assert.equal(await exists(join(home, 'storages', 'session_projcache', 'sessions', 'session-child.json')), false, '子会话投影缓存已删')
    assert.equal(await exists(join(cwd, '.dsh-sessions', 'session-parent')), false, '父会话产出目录已删')
    assert.equal(await exists(join(cwd, '.dsh-sessions', 'session-child')), false, '子会话产出目录已删')
    assert.deepEqual(harness.calls.detach, ['session-parent'], '工作区 detach')
    assert.ok(harness.calls.archive.every((entry) => entry.stop === true), '归档时要求停止活动')
    assert.deepEqual(harness.calls.archive.map((entry) => entry.id).sort(), ['session-child', 'session-parent'])
    assert.deepEqual(harness.calls.unarchive.sort(), ['session-child', 'session-parent'], '归档集合已清理')
    assert.deepEqual(state.archived, [])
    assert.ok(harness.calls.unpin.includes('session-parent'))
  })

  await test('幽灵会话（只有投影缓存与产出目录）：成功删除，不再 missing', async () => {
    const state = { headers: {}, live: {}, archived: [], attached: [] }
    const cwd = join(workspaceRoot, 'case-ghost')
    await writeFile(join(home, 'storages', 'session_projcache', 'sessions', 'session-ghost.json'), JSON.stringify({ version: 7, record: { identity: { cwd } } }))
    await writeFile(join(cwd, '.dsh-sessions', 'session-ghost', 'outputs', 'old.txt'), 'old')
    const harness = makeHarness(state)

    const res = await callRoute(harness.routes, '/dsh-session-delete/delete', { sessionId: 'session-ghost' })
    assert.equal(res.status, 200)
    assert.equal(res.payload.ok, true)
    assert.deepEqual(res.payload.deleted, ['session-ghost'])
    assert.equal(await exists(join(home, 'storages', 'session_projcache', 'sessions', 'session-ghost.json')), false, '缓存已删')
    assert.equal(await exists(join(cwd, '.dsh-sessions', 'session-ghost')), false, '产出目录已删')
  })

  await test('完全不存在的 id：幂等成功（不是 missing/404）', async () => {
    const harness = makeHarness({ headers: {}, live: {}, archived: [], attached: [] })
    const res = await callRoute(harness.routes, '/dsh-session-delete/delete', { sessionId: 'session-nobody' })
    assert.equal(res.status, 200)
    assert.equal(res.payload.ok, true)
    assert.deepEqual(res.payload.deleted, ['session-nobody'])
  })

  await test('live 会话：archive(stopActivity) → 等退出 → 删除', async () => {
    const state = { headers: {}, live: {}, archived: [], attached: [] }
    const cwd = join(workspaceRoot, 'case-live')
    const header = await seedSession(state, { id: 'session-live', cwd })
    state.live['session-live'] = { header, polls: 0, disappearAfter: 6 }
    const harness = makeHarness(state)

    const res = await callRoute(harness.routes, '/dsh-session-delete/delete', { sessionId: 'session-live' })
    assert.equal(res.status, 200)
    assert.equal(res.payload.ok, true)
    assert.ok(harness.calls.archive.some((entry) => entry.id === 'session-live' && entry.stop === true))
    assert.equal(await exists(join(home, 'sessions', '--proj--', 'session-live')), false)
    assert.equal(await exists(join(cwd, '.dsh-sessions', 'session-live')), false)
  })

  await test('已归档会话：先取消归档让 stopActivity 生效，再删除', async () => {
    const state = { headers: {}, live: {}, archived: ['session-archived'], attached: [] }
    const cwd = join(workspaceRoot, 'case-archived')
    await seedSession(state, { id: 'session-archived', cwd })
    const harness = makeHarness(state)

    const res = await callRoute(harness.routes, '/dsh-session-delete/delete', { sessionId: 'session-archived' })
    assert.equal(res.status, 200)
    assert.deepEqual(harness.calls.unarchive.slice(0, 1), ['session-archived'], '删除前先取消归档')
    assert.ok(harness.calls.archive.some((entry) => entry.id === 'session-archived' && entry.stop === true), '随后带 stopActivity 归档')
    assert.deepEqual(state.archived, [], '归档集合已清理')
    assert.equal(await exists(join(home, 'sessions', '--proj--', 'session-archived')), false)
  })

  await test('live 会话无法停止时：返回 active，且不删任何文件', async () => {
    const state = { headers: {}, live: {}, archived: [], attached: [] }
    const cwd = join(workspaceRoot, 'case-stuck')
    const header = await seedSession(state, { id: 'session-stuck', cwd })
    state.live['session-stuck'] = { header, polls: 0, disappearAfter: Number.MAX_SAFE_INTEGER }
    const harness = makeHarness(state)

    const res = await callRoute(harness.routes, '/dsh-session-delete/delete', { sessionId: 'session-stuck' })
    assert.equal(res.status, 409)
    assert.equal(res.payload.ok, false)
    assert.equal(res.payload.code, 'active')
    assert.equal(await exists(join(home, 'sessions', '--proj--', 'session-stuck')), true, '日志目录未被删除')
    assert.equal(await exists(join(cwd, '.dsh-sessions', 'session-stuck')), true, '产出目录未被删除')
  })

  await test('非法 id 与空请求：400 bad-args，不碰任何文件', async () => {
    const harness = makeHarness({ headers: {}, live: {}, archived: [], attached: [] })
    for (const body of [{}, { sessionId: '' }, { sessionId: '../evil' }, { sessionId: 'a/b' }]) {
      const res = await callRoute(harness.routes, '/dsh-session-delete/delete', body)
      assert.equal(res.status, 400)
      assert.deepEqual(res.payload, { ok: false, code: 'bad-args' })
    }
  })

  await test('agent/created：创建 .dsh-sessions/<id>/ 并注册 per-agent 提示词段', async () => {
    const state = { headers: {}, live: {}, archived: [], attached: [] }
    const cwd = join(workspaceRoot, 'case-agent')
    const harness = makeHarness(state)
    const listener = harness.listeners.get('agent/created')
    assert.equal(typeof listener, 'function', 'agent/created listener registered')

    const sections = []
    const agent = {
      session: { header: { version: 4, id: 'session-prompt', createdAt: 1, isSeeded: false, cwd } },
      ctx: { systemPrompt: { section(section) { sections.push(section); return () => {} } } },
    }
    await listener({ agent })

    assert.equal(await exists(join(cwd, '.dsh-sessions', 'session-prompt', 'outputs')), true, 'outputs 目录已建')
    assert.equal(await exists(join(cwd, '.dsh-sessions', 'session-prompt', 'memory.md')), true, 'memory.md 已建')
    assert.equal(sections.length, 1, '提示词段已注册')
    assert.equal(sections[0].order, 9050)
    assert.ok(sections[0].text.includes(join('.dsh-sessions', 'session-prompt')), '段文本包含会话产出目录')
    assert.ok(sections[0].text.includes('outputs'), '段文本包含 outputs')
  })

  await test('子代理产出归到顶层对话目录（删除顶层对话时一并删除）', async () => {
    const state = { headers: {}, live: {}, archived: [], attached: [] }
    const cwd = join(workspaceRoot, 'case-subagent')
    await seedSession(state, { id: 'session-root', cwd })
    await seedSession(state, { id: 'session-sub', cwd, parentSession: 'session-root' })
    const harness = makeHarness(state)
    const listener = harness.listeners.get('agent/created')

    const sections = []
    const agent = {
      session: { header: state.headers['session-sub'] },
      ctx: { systemPrompt: { section(section) { sections.push(section); return () => {} } } },
    }
    await listener({ agent })

    assert.equal(await exists(join(cwd, '.dsh-sessions', 'session-root', 'outputs')), true)
    assert.equal(sections.length, 1)
    assert.ok(sections[0].text.includes('subagent'), '子代理提示词说明从属关系')
    assert.ok(sections[0].text.includes(join('.dsh-sessions', 'session-root')), '子代理写入顶层对话目录')
  })

  await test('启动对账：移除已不存在会话的归档 id 与孤立投影缓存', async () => {
    const state = { headers: {}, live: {}, archived: ['session-gone'], attached: [] }
    await writeFile(join(home, 'storages', 'session_projcache', 'sessions', 'session-gone.json'), JSON.stringify({ version: 7, record: { identity: { cwd: workspaceRoot } } }))
    const harness = makeHarness(state)
    const result = await internals.reconcile({
      persistence: harness.ctx.sessionPersistence,
      registry: harness.ctx.workspaceRegistry,
      sessions: harness.ctx.sessions,
    })
    assert.equal(result.archivedRemoved, 1)
    assert.ok(result.cachesRemoved >= 1, '至少清掉 session-gone 的缓存')
    assert.deepEqual(state.archived, [])
    assert.equal(await exists(join(home, 'storages', 'session_projcache', 'sessions', 'session-gone.json')), false)
  })

  await test('isSafeId：拒绝路径穿越，接受真实 session id', () => {
    assert.equal(internals.isSafeId('session-138af067-c169-44f1-9572-6dec90b17a9d'), true)
    assert.equal(internals.isSafeId('../evil'), false)
    assert.equal(internals.isSafeId('a/b'), false)
    assert.equal(internals.isSafeId(''), false)
    assert.equal(internals.isSafeId('a..b'), false)
  })

  await test('认证/Host-Origin 栅栏拒绝的请求：直接写拒绝响应，不进入删除逻辑', async () => {
    const state = { headers: {}, live: {}, archived: [], attached: [], rejection: 403 }
    const cwd = join(workspaceRoot, 'case-rejected')
    await seedSession(state, { id: 'session-rejected', cwd })
    const harness = makeHarness(state)
    const res = await callRoute(harness.routes, '/dsh-session-delete/delete', { sessionId: 'session-rejected' })
    assert.equal(res.status, 403)
    assert.equal(await exists(join(home, 'sessions', '--proj--', 'session-rejected')), true, '文件未被动过')
  })

  await test('非 POST 方法：405', async () => {
    const harness = makeHarness({ headers: {}, live: {}, archived: [], attached: [] })
    const res = await callRoute(harness.routes, '/dsh-session-delete/delete', {}, 'GET')
    assert.equal(res.status, 405)
    assert.deepEqual(res.payload, { ok: false, code: 'method-not-allowed' })
  })

  await test('live flush 失败：中止删除，一个文件都不动', async () => {
    const state = { headers: {}, live: {}, archived: [], attached: [], flushError: new Error('disk full') }
    const cwd = join(workspaceRoot, 'case-flush')
    const header = await seedSession(state, { id: 'session-flush', cwd })
    state.live['session-flush'] = { header, polls: 0, disappearAfter: 999 }
    const harness = makeHarness(state)
    const res = await callRoute(harness.routes, '/dsh-session-delete/delete', { sessionId: 'session-flush' })
    assert.equal(res.status, 500)
    assert.equal(res.payload.code, 'flush-failed')
    assert.equal(await exists(join(home, 'sessions', '--proj--', 'session-flush')), true, '日志仍在')
    assert.equal(await exists(join(cwd, '.dsh-sessions', 'session-flush')), true, '产出目录仍在')
  })

  await test('ping 路由报告版本', async () => {
    const harness = makeHarness({ headers: {}, live: {}, archived: [], attached: [] })
    const res = await callRoute(harness.routes, '/dsh-session-delete/ping', {})
    assert.equal(res.status, 200)
    assert.equal(res.payload.ok, true)
    assert.equal(res.payload.version, '0.4.0')
  })
} finally {
  await fsp.rm(testRoot, { recursive: true, force: true, maxRetries: 3 })
}
