/**
 * Client 半测试：不启动浏览器，用最小 window/document/React 桩加载浏览器 bundle。
 *
 * 覆盖 v0.2.0 的客户端语义：
 *   - 通过 `ctx.slots.inject('sidebar.workspaces.session.menu.item')` 注册唯一菜单项
 *     （不再有 MutationObserver / DOM 克隆）
 *   - 菜单项是 danger 样式的 MenuItemButton，点击直接调用 Host 删除接口，没有确认弹窗
 *   - 删除成功后本地摘行并刷新会话列表
 *   - 失败（HTTP 500 / 网络错误）用 toast 报告
 *
 * 运行：node test/client.test.mjs
 */
import assert from 'node:assert/strict'

/* ---------------- 最小 DOM ---------------- */
function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    parentNode: null,
    textContent: '',
    setAttribute(key, value) {
      this.attributes[key] = String(value)
    },
    getAttribute(key) {
      return Object.hasOwn(this.attributes, key) ? this.attributes[key] : null
    },
    appendChild(child) {
      child.parentNode = this
      this.children.push(child)
      return child
    },
    removeChild(child) {
      this.children = this.children.filter((entry) => entry !== child)
      child.parentNode = null
      return child
    },
  }
}

const document = {
  body: makeEl('body'),
  head: makeEl('head'),
  createElement: makeEl,
}
globalThis.document = document

/* ---------------- 模块加载器桩 ---------------- */
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
  },
}
const primitives = {
  MenuItemButton: 'MenuItemButton',
  IconTrashOutlineRegular: 'IconTrashOutlineRegular',
}
function fakeRequire(name) {
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error('unexpected require: ' + name)
}

let exported = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      assert.equal(entry.id, 'dsh-session-delete')
      exported = entry.factory(fakeRequire)
    },
  },
}

await import('../client.js')
assert.ok(exported !== null, 'bundle registered a module')
assert.equal(typeof exported.apply, 'function', 'client half exports apply')

/* ---------------- 客户端 ctx 桩 ---------------- */
const disposers = []
let slotKey = null
let registration = null
const locales = []
const sessions = {
  removed: [],
  refreshes: 0,
  handleSessionRemoved(id) {
    this.removed.push(id)
  },
  refresh() {
    this.refreshes += 1
    return Promise.resolve()
  },
}
const ctx = {
  slots: {
    inject(key, callback) {
      slotKey = key
      return callback()
    },
    register(options, component) {
      registration = { options, component }
      return () => {}
    },
  },
  locale: {
    register(namespace, dictionary) {
      locales.push({ namespace, dictionary })
      return () => {}
    },
    getLocale() {
      return { id: 'zh' }
    },
  },
  sessions,
  get(name) {
    return name === 'sessions' ? sessions : undefined
  },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
}

exported.apply(ctx)

/* ---------------- 注册断言 ---------------- */
assert.deepEqual(exported.inject, ['slots', 'sessions', 'locale'], 'client inject 声明')
assert.equal(slotKey, 'sidebar.workspaces.session.menu.item', '注册到会话行菜单 slot')
assert.equal(registration !== null, true, '菜单项已注册')
assert.equal(registration.options.name, 'sidebar.workspaces.session.menu.item')
assert.equal(registration.options.id, 'delete-session')
assert.equal(registration.options.order, 500)
assert.equal(registration.options.locale, 'dshSessionDelete')
assert.equal(locales.length, 1, 'locale 字典已注册')
assert.equal(locales[0].namespace, 'dshSessionDelete')
assert.equal(locales[0].dictionary.zh.deleteSession, '删除会话')
assert.equal(locales[0].dictionary.en.deleteSession, 'Delete session')

const injected = registration.options.inject()
assert.equal(typeof injected.deleteSession, 'function', 'inject face 暴露 deleteSession')

/* ---------------- 渲染：一个 danger 菜单项 ---------------- */
let menuClosed = false
const rendered = registration.component({
  sessionId: 's1',
  displayTitle: '测试会话',
  useMenuOpenState: () => [true, (open) => { if (open === false) menuClosed = true }],
  t: (key) => key,
  ...injected,
})
assert.equal(rendered.type, 'MenuItemButton', '使用宿主 MenuItemButton')
assert.equal(rendered.props.danger, true, 'danger 红色样式')
assert.equal(rendered.props.separatorBefore, true, '与官方 action 分组')
assert.equal(rendered.props.children, 'deleteSession', '文案走 locale key')

/* ---------------- 点击 → 直接删除（无确认弹窗） ---------------- */
const fetches = []
let fetchImpl = async (url, init) => {
  fetches.push({ url, init })
  return { ok: true, status: 200, json: async () => ({ ok: true, deleted: ['s1'] }) }
}
globalThis.fetch = (...args) => fetchImpl(...args)

rendered.props.onSelect()
assert.equal(menuClosed, true, '点击后关闭菜单')
await new Promise((resolve) => setTimeout(resolve, 30))
assert.equal(fetches.length, 1, '调用了一次 Host 接口')
assert.equal(fetches[0].url, '/dsh-session-delete/delete')
assert.equal(fetches[0].init.method, 'POST')
assert.ok(String(fetches[0].init.body).includes('"s1"'), '请求体带 sessionId')
assert.deepEqual(sessions.removed, ['s1'], '本地会话模型已摘行')
assert.equal(sessions.refreshes, 1, '触发了一次列表刷新')
assert.ok(document.body.children.some((el) => String(el.attributes.class).includes('dsd-toast')), '出现成功提示')
assert.ok(!document.body.children.some((el) => String(el.attributes.class).includes('dsd-toast-error')), '成功时不显示错误样式')

/* ---------------- 失败 → 错误 toast ---------------- */
fetchImpl = async () => ({
  ok: false,
  status: 500,
  json: async () => ({ ok: false, code: 'remove-failed', detail: 'file locked' }),
})
await injected.deleteSession('s2')
assert.ok(
  document.body.children.some((el) => String(el.attributes.class).includes('dsd-toast-error')),
  'HTTP 失败显示错误 toast',
)

/* ---------------- 网络失败 → 错误 toast ---------------- */
fetchImpl = async () => {
  throw new Error('offline')
}
await injected.deleteSession('s3')
assert.ok(
  document.body.children.filter((el) => String(el.attributes.class).includes('dsd-toast-error')).length >= 2,
  '网络失败显示错误 toast',
)

/* ---------------- 卸载清理 ---------------- */
for (const dispose of disposers) dispose()
assert.equal(document.head.children.length, 0, 'style 已移除')
console.log('ok   - client slot registration, one-click delete, toast feedback')
