/**
 * dsh-session-delete v0.2.0 — 会话删除（Host 半）
 *
 * 设计目标只有一件事：在会话行的「⋯」菜单里点一次「删除会话」就删干净，没有二次确认、
 * 没有批量菜单、不重复官方菜单项。删除范围：
 *
 *   1. 会话日志目录      ~/.dsh/sessions/<项目>/<session-id>/（含 v4 子会话目录）
 *   2. 投影缓存          ~/.dsh/storages/session_projcache/sessions/<session-id>.json
 *   3. 会话产出目录      <会话 cwd>/.dsh-sessions/<session-id>/（outputs/、memory.md …）
 *   4. 工作区归属        detach / unpin / 从归档集合移除
 *   5. 运行中的会话      先 archive(stopActivity) 停掉回合/子代理/任务/提醒再删
 *
 * v0.2.0 修复与简化：
 *   - 旧版用 `persistence.list().find(h => h.id === id)` 判定会话是否存在；list() 的快照
 *     结构是 `{ header, revision, sizeBytes }`，`id` 在 `header.id` 上，旧代码永远找不到，
 *     于是每次点击都返回 404「missing」、什么都没删。本版改为 `persistence.stat(id)` 直读，
 *     并用会话目录扫描兜底，不再依赖快照字段位置。
 *   - 删除是幂等的：日志/缓存/产出目录不存在时也算成功（清理幽灵会话）；
 *     「未分组」里只存在于投影缓存的历史会话也能直接点掉。
 *   - 不再使用 shell + 沙箱执行 rm（Windows 句柄问题导致重试逻辑复杂）；
 *     插件是受信 Host 扩展，直接用 node:fs 删除，路径全部来自持久化 header / 缓存，
 *     且经过 id 白名单与根目录包含校验。
 *   - 启动时做一次轻量对账：清掉已不存在会话的归档条目与孤立投影缓存。
 *   - 为每个对话建立独立产出目录 `.dsh-sessions/<session-id>/`，并通过 per-agent 的
 *     system prompt 段告知模型：本对话的所有生成文件都写进该目录。删除对话时整目录删除，
 *     因此「删除对话 = 连同它产生的文件一起删除」。
 *
 * 依赖服务（inject）：webServer、sessionPersistence、workspaceRegistry、sessions。
 */
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const MODULE = '[dsh-session-delete]'
const VERSION = '0.4.0'
/** 会话产出目录名：放在工作目录下，与工作区内容区分。 */
const ARTIFACT_DIRNAME = '.dsh-sessions'
/** 请求体上限：唯一合法的请求体就是一个小对象。 */
const MAX_BODY_BYTES = 64 * 1024
/** 会话 id 只允许路径安全字符；真实 id 形如 session-<uuid>。 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,240}$/
/** 系统提示词段位置：工具段之后、结构化输出之前。 */
const ARTIFACT_SECTION_ORDER = 9050
const ARTIFACT_SECTION_NAME = 'dsh-session-delete:conversation-artifacts'

function log(...args) {
  console.error(MODULE, ...args)
}

function textOf(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return String(value)
  } catch {
    return ''
  }
}

function errorName(error) {
  if (error === null || error === undefined) return ''
  if (typeof error.name === 'string' && error.name !== '') return error.name
  const ctor = error.constructor
  return ctor !== null && ctor !== undefined && typeof ctor.name === 'string' ? ctor.name : ''
}

function isSafeId(id) {
  return typeof id === 'string' && SAFE_ID.test(id) && !id.includes('..')
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function pathExists(target) {
  try {
    await fsp.stat(target)
    return true
  } catch {
    return false
  }
}

/** target 是否等于 root 或位于 root 内（按 resolve 后路径比较）。 */
function isInside(target, root) {
  const absTarget = resolve(target)
  const absRoot = resolve(root)
  const rel = relative(absRoot, absTarget)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 递归删除，带重试：Windows 上文件句柄释放稍慢，fsp.rm 的 maxRetries 已能处理大部分
 * 共享冲突，这里再包一层指数退避作为兜底。目标不存在视为成功。
 */
async function rmrf(target) {
  let absTarget
  try {
    absTarget = resolve(target)
  } catch {
    return { ok: false, error: new Error('invalid removal target') }
  }
  if (absTarget === '' || absTarget === '/' || /^[A-Za-z]:\\?$/.test(absTarget)) {
    return { ok: false, error: new Error(`refusing to remove root-like path: ${absTarget}`) }
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fsp.rm(absTarget, { recursive: true, force: true, maxRetries: 2, retryDelay: 120 })
      return { ok: true }
    } catch (error) {
      if (error !== null && error !== undefined && error.code === 'ENOENT') return { ok: true }
      if (attempt === 7) return { ok: false, error }
      await sleep(150 * (attempt + 1))
    }
  }
  return { ok: false, error: new Error('unreachable') }
}

async function readJson(target) {
  try {
    return JSON.parse(await fsp.readFile(target, 'utf8'))
  } catch {
    return undefined
  }
}

async function writeTextIfAbsent(target, text) {
  try {
    await fsp.writeFile(target, text, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error) {
    if (error !== null && error !== undefined && error.code === 'EEXIST') return false
    throw error
  }
}

async function listDirs(root) {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name))
  } catch {
    return []
  }
}

function projCachePath(id) {
  return join(dshHome(), 'storages', 'session_projcache', 'sessions', `${id}.json`)
}

function artifactDirFor(cwd, id) {
  return join(cwd, ARTIFACT_DIRNAME, id)
}

/** 会话对应的各来源 header（live 优先于持久化）；用于取 cwd 与子会话关系。 */
async function collectHeaders(deps) {
  const headers = new Map()
  try {
    const live = typeof deps.sessions.list === 'function' ? deps.sessions.list() : []
    for (const session of live) {
      const header = session !== null && session !== undefined ? session.header : undefined
      if (header !== null && header !== undefined && typeof header.id === 'string') headers.set(header.id, header)
    }
  } catch {
    /* live 枚举失败不阻断 */
  }
  try {
    const snapshots = await deps.persistence.list()
    if (Array.isArray(snapshots)) {
      for (const snapshot of snapshots) {
        const header = snapshot !== null && snapshot !== undefined ? snapshot.header : undefined
        if (header !== null && header !== undefined && typeof header.id === 'string') headers.set(header.id, header)
      }
    }
  } catch (error) {
    log('persistence.list failed:', textOf(error !== null && error !== undefined && error.message))
  }
  return headers
}

/** 目标会话自己的 header：live → stat → list 快照。 */
async function headerOf(deps, id) {
  try {
    const live = deps.sessions.get(id)
    if (live !== null && live !== undefined && live.header !== undefined) return live.header
  } catch {
    /* ignore */
  }
  try {
    const snapshot = await deps.persistence.stat(id)
    if (snapshot !== null && snapshot !== undefined && snapshot.header !== undefined) return snapshot.header
  } catch {
    /* ignore */
  }
  try {
    const snapshots = await deps.persistence.list()
    if (Array.isArray(snapshots)) {
      for (const snapshot of snapshots) {
        const header = snapshot !== null && snapshot !== undefined ? snapshot.header : undefined
        if (header !== null && header !== undefined && header.id === id) return header
      }
    }
  } catch {
    /* ignore */
  }
  return undefined
}

/** 子代理会话的 id（按 parentSession 关系递归）。 */
function collectDescendants(headers, rootId) {
  const childrenByParent = new Map()
  for (const [id, header] of headers) {
    const parent = header !== null && header !== undefined ? header.parentSession : undefined
    if (typeof parent !== 'string' || parent === '') continue
    const children = childrenByParent.get(parent)
    if (children === undefined) childrenByParent.set(parent, [id])
    else children.push(id)
  }
  const ids = new Set([rootId])
  const queue = [rootId]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const child of childrenByParent.get(current) ?? []) {
      if (ids.has(child)) continue
      ids.add(child)
      queue.push(child)
    }
  }
  return ids
}

/**
 * 删除一个会话及其子会话。
 * @returns `{ ok, deleted, failures, warnings }`
 */
async function deleteSession(deps, rootId) {
  const warnings = []
  const headers = await collectHeaders(deps)
  if (!headers.has(rootId)) {
    const header = await headerOf(deps, rootId)
    if (header !== undefined) headers.set(rootId, header)
  }
  /* 只在投影缓存里残留的历史会话：借缓存里的 identity.cwd 找到产出目录。 */
  if (!headers.has(rootId)) {
    const cached = await readJson(projCachePath(rootId))
    const cwd = cached !== null && cached !== undefined && cached.record !== undefined && cached.record !== null
      ? cached.record.identity
      : undefined
    if (cwd !== null && cwd !== undefined && typeof cwd.cwd === 'string' && isAbsolute(cwd.cwd)) {
      headers.set(rootId, { id: rootId, cwd: cwd.cwd })
    }
  }
  const ids = collectDescendants(headers, rootId)
  const idList = [...ids]

  /* 1) 归档并停止活动：durable 归档集合是 agent/pre-step 的门禁，先写它再停工作。
   *    已归档的会话 archiveSession 会直接 no-op、不会触发停止，所以先 unarchive 再归档。 */
  for (const id of idList) {
    try {
      let alreadyArchived = false
      try {
        alreadyArchived = Array.isArray(deps.registry.archivedSessionIds) && deps.registry.archivedSessionIds.includes(id)
      } catch {
        alreadyArchived = false
      }
      if (alreadyArchived) {
        try {
          await deps.registry.unarchiveSession(id)
        } catch {
          /* ignore */
        }
      }
      await deps.registry.archiveSession(id, { stopActivity: true })
    } catch (error) {
      const name = errorName(error)
      if (name !== 'WorkspaceUnknownSessionError') warnings.push(`archive ${id}: ${name || textOf(error)}`)
    }
  }

  /* 2) live 会话先做一次持久化屏障：归档门禁已生效，flush 把内存里未落盘的事件写干净。
   *    失败就中止删除，宁可留着也绝不冒损坏日志的风险。 */
  for (const id of idList) {
    let live
    try {
      live = deps.sessions.get(id)
    } catch {
      live = undefined
    }
    if (live === undefined || live === null) continue
    if (typeof deps.sessions.flush !== 'function') continue
    try {
      await deps.sessions.flush(live)
    } catch (error) {
      return {
        ok: false,
        code: 'flush-failed',
        deleted: [],
        failures: [{ path: '', error: `flush ${id}: ${textOf(error !== null && error !== undefined && error.message)}` }],
        warnings,
      }
    }
  }

  /* 3) 等 live 会话真正退出（客户端收到归档后会关闭当前视图、释放句柄）。 */
  const waitIds = idList.filter((id) => {
    try {
      return deps.sessions.get(id) !== undefined
    } catch {
      return false
    }
  })
  const deadline = Date.now() + 5000
  while (waitIds.length > 0 && Date.now() < deadline) {
    for (let index = waitIds.length - 1; index >= 0; index -= 1) {
      let live = false
      try {
        live = deps.sessions.get(waitIds[index]) !== undefined
      } catch {
        live = false
      }
      if (!live) waitIds.splice(index, 1)
    }
    if (waitIds.length > 0) await sleep(100)
  }
  /* 仍有 live 会话时不要动文件：写入方稍后的 flush 可能把日志写回来。 */
  const stillLive = idList.filter((id) => {
    try {
      return deps.sessions.get(id) !== undefined
    } catch {
      return false
    }
  })
  if (stillLive.length > 0) {
    return {
      ok: false,
      code: 'active',
      deleted: [],
      failures: [{ path: '', error: `session still live: ${stillLive.join(', ')}` }],
      warnings,
    }
  }

  /* 4) 工作区账目先 detach：workspace.sessionIds 的 getter 会按会话是否仍存在过滤，
   *    必须在删文件之前做，否则被过滤掉后就 detach 不到了。 */
  try {
    for (const workspace of deps.registry.list()) {
      const sessionIds = workspace !== null && workspace !== undefined ? workspace.sessionIds : undefined
      if (!Array.isArray(sessionIds)) continue
      for (const id of idList) {
        if (!sessionIds.includes(id)) continue
        try {
          await workspace.detachSession(id)
        } catch (error) {
          warnings.push(`detach ${id}: ${textOf(error !== null && error !== undefined && error.message)}`)
        }
      }
    }
  } catch (error) {
    warnings.push(`workspace list: ${textOf(error !== null && error !== undefined && error.message)}`)
  }

  /* 5) 删会话日志目录：先用后端 locate 精确得到路径，再扫描根下同名目录兜底。 */
  const sessionsRoot = join(dshHome(), 'sessions')
  const projectDirs = await listDirs(sessionsRoot)
  const logDirs = new Set()
  for (const id of idList) {
    const header = headers.get(id)
    if (header !== undefined && typeof deps.persistence.locate === 'function') {
      try {
        const location = deps.persistence.locate(header)
        if (location !== null && location !== undefined && typeof location.path === 'string' && location.path !== '') {
          logDirs.add(dirname(location.path))
        }
      } catch (error) {
        warnings.push(`locate ${id}: ${textOf(error !== null && error !== undefined && error.message)}`)
      }
    }
    if (!isSafeId(id)) continue
    for (const projectDir of projectDirs) {
      const candidate = join(projectDir, id)
      if (await pathExists(candidate)) logDirs.add(candidate)
    }
  }
  const failures = []
  for (const dir of logDirs) {
    if (!isInside(dir, sessionsRoot)) {
      warnings.push(`skip outside sessions root: ${dir}`)
      continue
    }
    const result = await rmrf(dir)
    if (!result.ok) failures.push({ path: dir, error: textOf(result.error !== null && result.error !== undefined && result.error.message) })
  }

  /* 6) 删投影缓存。 */
  for (const id of idList) {
    if (!isSafeId(id)) continue
    const cache = projCachePath(id)
    if (!(await pathExists(cache))) continue
    const result = await rmrf(cache)
    if (!result.ok) failures.push({ path: cache, error: textOf(result.error !== null && result.error !== undefined && result.error.message) })
  }

  /* 7) 删该对话的产出目录（每个会话/子会话各自一个编号目录）。 */
  for (const id of idList) {
    const header = headers.get(id)
    const cwd = header !== null && header !== undefined ? header.cwd : undefined
    if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) continue
    const artifactDir = artifactDirFor(cwd, id)
    if (!(await pathExists(artifactDir))) continue
    const result = await rmrf(artifactDir)
    if (!result.ok) failures.push({ path: artifactDir, error: textOf(result.error !== null && result.error !== undefined && result.error.message) })
  }

  /* 8) 从置顶/归档集合移除（未归档/未置顶时这些调用是 no-op）。 */
  if (failures.length === 0) {
    for (const id of idList) {
      try {
        await deps.registry.unpinSession(id)
      } catch {
        /* 未置顶时不做任何事 */
      }
      try {
        /* 已归档 id 若保留，会一直膨胀 durable 集合；文件已删干净，这里顺手移除。 */
        await deps.registry.unarchiveSession(id)
      } catch {
        /* 未归档时不做任何事 */
      }
    }
  }

  return { ok: failures.length === 0, deleted: idList, failures, warnings }
}

/** 启动对账：清掉已不存在会话的归档条目与孤立投影缓存（不碰任何真实数据）。 */
async function reconcile(deps) {
  let archivedRemoved = 0
  let cachesRemoved = 0
  try {
    for (const id of [...deps.registry.archivedSessionIds]) {
      if (!isSafeId(id)) continue
      if (deps.sessions.get(id) !== undefined) continue
      let snapshot
      try {
        snapshot = await deps.persistence.stat(id)
      } catch {
        continue
      }
      if (snapshot !== undefined) continue
      try {
        await deps.registry.unarchiveSession(id)
        archivedRemoved += 1
      } catch {
        /* ignore */
      }
    }
  } catch (error) {
    log('reconcile archive set failed:', textOf(error !== null && error !== undefined && error.message))
  }
  try {
    const dir = join(dshHome(), 'storages', 'session_projcache', 'sessions')
    let names
    try {
      names = await fsp.readdir(dir)
    } catch {
      names = []
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      if (!isSafeId(id)) continue
      if (deps.sessions.get(id) !== undefined) continue
      let snapshot
      try {
        snapshot = await deps.persistence.stat(id)
      } catch {
        continue
      }
      if (snapshot !== undefined) continue
      const result = await rmrf(join(dir, name))
      if (result.ok) cachesRemoved += 1
    }
  } catch (error) {
    log('reconcile projection cache failed:', textOf(error !== null && error !== undefined && error.message))
  }
  if (archivedRemoved > 0 || cachesRemoved > 0) log(`reconcile: removed ${archivedRemoved} archive id(s), ${cachesRemoved} orphan projection cache(s)`)
  return { archivedRemoved, cachesRemoved }
}

function memoryTemplate(id, cwd) {
  return [
    '# 会话记忆 / Session memory',
    '',
    '- session: ' + id,
    '- cwd: ' + cwd,
    '- created: ' + new Date().toISOString(),
    '',
    '记录这个对话的持久结论、用户偏好、任务状态，以及 outputs/ 里文件的用途。',
    '本文件随对话删除一起删除。',
    '',
    '## Notes',
    '',
  ].join('\n')
}

/**
 * 找到会话所属的顶层对话 id：子代理会话沿 header.parentSession 链上溯。
 * 这样一个对话（含它派生的所有子代理）产生的文件都落在同一个编号目录里，
 * 删除对话时也就一并删除。
 */
async function resolveArtifactOwner(deps, header) {
  const seen = new Set()
  let current = header
  let owner = header.id
  while (current !== null && current !== undefined && typeof current.parentSession === 'string' && current.parentSession !== '') {
    const parentId = current.parentSession
    if (seen.has(parentId)) break
    seen.add(parentId)
    owner = parentId
    let parent
    try {
      const snapshot = await deps.persistence.stat(parentId)
      parent = snapshot !== null && snapshot !== undefined ? snapshot.header : undefined
    } catch {
      parent = undefined
    }
    if (parent === undefined) break
    current = parent
  }
  return owner
}

function artifactPromptText(id, ownerId, cwd) {
  const dir = artifactDirFor(cwd, ownerId)
  const lines = ['## Conversation artifacts (required)', '']
  if (id === ownerId) {
    lines.push("This conversation's session id is " + id + '.')
    lines.push('All files you create or export for this conversation MUST be written under:')
  } else {
    lines.push('You are a subagent working for conversation ' + ownerId + '.')
    lines.push('All files you create or export MUST be written under that conversation\'s directory:')
  }
  lines.push(
    '  ' + dir,
    '- Deliverables: ' + join(dir, 'outputs'),
    '- Scratch files: ' + join(dir, 'tmp'),
  )
  if (id === ownerId) lines.push('- Durable notes / memory: ' + join(dir, 'memory.md'))
  else lines.push('Do not modify the parent conversation\'s memory.md; return findings in your final answer.')
  lines.push(
    '',
    'Do not create output files in the workspace root (' + cwd + ').',
    'In shell commands the session id is available as $env:DSH_SESSION_ID (PowerShell) or $DSH_SESSION_ID (bash);',
    'the workspace-relative directory is .dsh-sessions/<conversation-id>/.',
    'Deleting this conversation from the sidebar deletes this directory together with the session logs.',
    '',
  )
  return lines.join('\n')
}

/**
 * 为一个 agent 建立产出目录，并注册 per-agent 系统提示词段。
 * 必须通过 agent/created 调用：段注册在 agent 作用域内，随 agent 释放自动撤销。
 * 监听器可以异步（Cordis 会等它返回再发布 agent），但不能等 idle/dispose。
 */
async function setupAgentArtifacts(deps, agent) {
  const header = agent !== null && agent !== undefined ? agent.session?.header : undefined
  if (header === null || header === undefined) return
  const id = header.id
  const cwd = header.cwd
  if (!isSafeId(id) || typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) return
  let ownerId = id
  try {
    ownerId = await resolveArtifactOwner(deps, header)
  } catch {
    ownerId = id
  }
  const dir = artifactDirFor(cwd, ownerId)
  try {
    const prompt = agent.ctx !== null && agent.ctx !== undefined ? agent.ctx.systemPrompt : undefined
    if (prompt !== null && prompt !== undefined && typeof prompt.section === 'function') {
      prompt.section({
        name: ARTIFACT_SECTION_NAME,
        order: ARTIFACT_SECTION_ORDER,
        text: artifactPromptText(id, ownerId, cwd),
      })
    }
  } catch (error) {
    log(`prompt section for ${id} failed:`, textOf(error !== null && error !== undefined && error.message))
  }
  await fsp.mkdir(join(dir, 'outputs'), { recursive: true })
  if (id === ownerId) await writeTextIfAbsent(join(dir, 'memory.md'), memoryTemplate(id, cwd))
}

/** 读取并解析 JSON 请求体；空体返回 {}，非法 JSON 或超过上限返回 null。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

export default {
  name: 'dsh-session-delete',
  inject: ['webServer', 'connection', 'sessionPersistence', 'workspaceRegistry', 'sessions'],
  apply(ctx) {
    const deps = {
      persistence: ctx.sessionPersistence,
      registry: ctx.workspaceRegistry,
      sessions: ctx.sessions,
    }

    /**
     * 浏览器认证 + Host/Origin 栅栏。组合里没有 connection 服务时（旧版/测试组合）
     * 退化为不设栅栏，保持向后兼容。
     * @returns 已经写过拒绝响应时返回 true。
     */
    function rejectRequest(req, res) {
      const connection = ctx.connection
      if (connection === null || connection === undefined || typeof connection.requestRejection !== 'function') return false
      let rejection
      try {
        rejection = connection.requestRejection(req)
      } catch {
        return false
      }
      if (rejection === undefined) return false
      res.writeHead(rejection)
      res.end()
      return true
    }

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-session-delete/delete',
      handler: async (req, res) => {
        if (rejectRequest(req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, code: 'method-not-allowed' }))
          return
        }
        const body = await readJsonBody(req)
        if (body === null || typeof body !== 'object' || !isSafeId(body.sessionId)) {
          sendJson(res, 400, { ok: false, code: 'bad-args' })
          return
        }
        let result
        try {
          result = await deleteSession(deps, body.sessionId)
        } catch (error) {
          log('delete failed:', textOf(error !== null && error !== undefined && error.stack))
          sendJson(res, 500, { ok: false, code: 'internal', detail: textOf(error !== null && error !== undefined && error.message) })
          return
        }
        if (!result.ok) {
          if (result.code === 'active') {
            sendJson(res, 409, {
              ok: false,
              code: 'active',
              detail: (result.failures[0] ?? {}).error ?? '',
              warnings: result.warnings,
            })
            return
          }
          log('delete incomplete for', body.sessionId, result.failures)
          sendJson(res, 500, {
            ok: false,
            code: result.code ?? 'remove-failed',
            detail: (result.failures[0] ?? {}).error ?? '',
            failures: result.failures,
            warnings: result.warnings,
          })
          return
        }
        if (result.warnings.length > 0) log('delete warnings for', body.sessionId, result.warnings)
        sendJson(res, 200, { ok: true, deleted: result.deleted, warnings: result.warnings })
      },
    }), 'dsh-session-delete: delete route')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-session-delete/ping',
      handler: (req, res) => {
        if (rejectRequest(req, res)) return
        sendJson(res, 200, { ok: true, version: VERSION, artifactDirname: ARTIFACT_DIRNAME })
      },
    }), 'dsh-session-delete: ping route')

    ctx.effect(() => ctx.on('agent/created', async ({ agent }) => {
      try {
        await setupAgentArtifacts(deps, agent)
      } catch (error) {
        log('session artifact setup failed:', textOf(error !== null && error !== undefined && error.message))
      }
    }), 'dsh-session-delete: session artifacts')

    ctx.effect(() => {
      const timer = setTimeout(() => {
        reconcile(deps).catch((error) => log('reconcile failed:', textOf(error !== null && error !== undefined && error.message)))
      }, 500)
      return () => clearTimeout(timer)
    }, 'dsh-session-delete: startup reconcile')

    log(`host ready v${VERSION}: POST /dsh-session-delete/delete, GET /ping`)
  },
}

/** 测试与排障入口（插件加载器只消费 default export）。 */
export const __internals = {
  VERSION,
  ARTIFACT_DIRNAME,
  deleteSession,
  reconcile,
  collectHeaders,
  headerOf,
  collectDescendants,
  artifactDirFor,
  projCachePath,
  resolveArtifactOwner,
  setupAgentArtifacts,
  artifactPromptText,
  isSafeId,
}
