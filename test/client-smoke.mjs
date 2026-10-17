/**
 * Client-half smoke test for client.js.
 *
 * There is no browser control in this environment, so this harness verifies
 * everything that can be verified without one:
 *   - the module registers under the package name with a factory;
 *   - `apply` registers the declared slot contract (slot names, ids, order);
 *   - the menu entry renders one `role="menuitem"` button, dismisses the menu
 *     through the injected `useMenuOpenState` hook, and opens the confirmation;
 *   - the overlay entry stays empty until a request exists, then renders the
 *     dialog;
 *   - the PREFLIGHT drives what the operator sees before committing: a refusal
 *     is explained with the confirm disabled, a `needsStop` answer opens the
 *     stop-and-delete variant, and an unknown answer stays permissive;
 *   - the state machine handles success, the busy race, every documented error
 *     code, and transport failures;
 *   - the style resource is installed and disposed through `ctx.effect`.
 *
 * It needs no React install: a minimal hook runtime plus a component evaluator
 * stand in for React, so components can be driven as plain functions.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const CLIENT = path.resolve(import.meta.dirname, '..', 'client.js');
const DELETE_ROUTE = '/dsh-session-delete/delete';
const PROBE_ROUTE = '/dsh-session-delete/probe';

/* ---------------------------------------------------------------- React shim */
const hookSlots = new Map();
let activeSlots = null;
let cursor = 0;
/**
 * Real React unmounts the dialog whenever the overlay renders nothing, which
 * destroys its state. This epoch is bumped on exactly that event so the shim
 * remounts too — otherwise a previous confirmation's busy/error state would
 * leak into the next one and the test would validate behaviour React never has.
 */
let mountEpoch = 0;

function componentKey(type) {
  let key = hookSlots.get(type);
  if (key === undefined) {
    key = { slots: [], mountKey: undefined };
    hookSlots.set(type, key);
  }
  return key;
}

const React = {
  createElement(type, props, ...children) {
    const flat = children.length <= 1 ? children[0] : children;
    return { type, props: { ...(props ?? {}), children: flat } };
  },
  useState(initial) {
    const index = cursor++;
    /* Bind to this component's own slot array: a React state setter stays valid
       after render returns, when the module-global cursor is gone. */
    const slots = activeSlots;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      slots[index],
      (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next;
      },
    ];
  },
  useRef(initial) {
    const index = cursor++;
    if (!(index in activeSlots)) activeSlots[index] = { current: initial };
    return activeSlots[index];
  },
  useCallback(fn) {
    cursor += 1;
    return fn;
  },
  useEffect() {
    cursor += 1;
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    cursor += 1;
    return getSnapshot();
  },
};

/**
 * Expand an element tree the way a renderer would: function components are
 * invoked (with their hooks), host elements keep their props. A changed `key`
 * remounts the component, which is what the dialog relies on per request.
 */
function evaluate(node) {
  if (Array.isArray(node)) return node.map(evaluate);
  if (node === null || node === undefined || typeof node !== 'object') return node;
  const { type, props } = node;
  if (typeof type === 'function') {
    const key = componentKey(type);
    const mountKey = `${String(props?.key)}@${String(mountEpoch)}`;
    if (key.mountKey !== mountKey) {
      key.slots = [];
      key.mountKey = mountKey;
    }
    activeSlots = key.slots;
    cursor = 0;
    const rendered = type(props);
    activeSlots = null;
    return evaluate(rendered);
  }
  return { ...node, props: { ...props, children: evaluate(props?.children) } };
}

function findAll(node, match, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, out);
    return out;
  }
  if (match(node)) out.push(node);
  findAll(node.props?.children, match, out);
  return out;
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (node === null || node === undefined || typeof node !== 'object') return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}

const buttonsOf = (tree) => findAll(tree, (el) => el.type === 'button');
const tick = () => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------------------------------- loader / ctx capture */
let registration = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      registration = spec;
    },
  },
};

await import(pathToFileURL(CLIENT).href);
assert.ok(registration !== null, 'client.js must register a module');
assert.equal(registration.id, 'dsh-session-delete', 'module id must equal the package name');
assert.equal(typeof registration.factory, 'function', 'factory must be a function');

const module = registration.factory((specifier) => {
  assert.equal(specifier, 'react', `unexpected require("${specifier}")`);
  return React;
});
assert.equal(typeof module.apply, 'function', 'the client half must export apply');
assert.deepEqual(module.inject, ['slots'], 'the client half injects the slots service');

const registrations = [];
const effects = [];
const styleTags = [];
let styleRemoved = false;
const previousDocument = globalThis.document;
globalThis.document = {
  createElement: () => ({
    setAttribute: (name, value) => styleTags.push([name, value]),
    textContent: '',
    remove: () => {
      styleRemoved = true;
    },
  }),
  head: { appendChild: () => {} },
};

const ctx = {
  get: (name) => (name === 'locale' ? { getSnapshot: () => ({ active: 'zh-CN' }) } : undefined),
  effect: (fn, label) => {
    effects.push([label, fn]);
    return () => {};
  },
  slots: {
    inject: (slot, factory) => {
      factory();
      return () => {};
    },
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    },
  },
};

module.apply(ctx);

/* ------------------------------------------------------ registration contract */
assert.equal(registrations.length, 2, `expected 2 slot registrations, got ${registrations.length}`);
const menu = registrations.find((r) => r.options.name === 'sidebar.workspaces.session.menu.item');
const overlay = registrations.find((r) => r.options.name === 'shell.overlay');
assert.ok(menu, 'must register into sidebar.workspaces.session.menu.item');
assert.ok(overlay, 'must register into shell.overlay');
assert.equal(menu.options.id, 'dsh-session-delete.delete', 'menu id must be package-namespaced');
assert.equal(overlay.options.id, 'dsh-session-delete.confirm', 'overlay id must be package-namespaced');
assert.equal(menu.options.order, 500, 'the delete row must sort after the shipped rows (pin 100 … archive 400)');

/* --------------------------------------------------------------- style effect */
assert.equal(effects.length, 1, 'apply must install exactly one effect');
assert.equal(effects[0][0], 'dsh-session-delete: styles');
const disposeStyle = effects[0][1]();
assert.ok(
  styleTags.some(([name, value]) => name === 'data-plugin' && value === 'dsh-session-delete'),
  'the style tag must be marked with the plugin name',
);
assert.equal(typeof disposeStyle, 'function', 'the style effect must return a cleanup');
disposeStyle();
assert.equal(styleRemoved, true, 'the cleanup must remove the style tag');
globalThis.document = previousDocument;

/* ---------------------------------------------------------- menu entry render */
const menuCalls = [];
const menuTree = evaluate(
  menu.component({
    sessionId: 'session-abc',
    displayTitle: '我的会话',
    useMenuOpenState: () => [true, (next) => menuCalls.push(next)],
  }),
);

const menuButtons = buttonsOf(menuTree);
assert.equal(menuButtons.length, 1, 'the menu entry must render exactly one button');
assert.equal(menuButtons[0].props.role, 'menuitem', 'that button must carry role="menuitem"');
assert.equal(textOf(menuTree), '删除会话', 'the row must render the zh label from the GUI locale');
assert.equal(
  findAll(menuTree, (el) => el.props?.role === 'separator').length,
  1,
  'the destructive row must be preceded by a separator',
);

/* ------------------------------------------------------------- fetch routing */
let lastDelete = null;
let lastProbe = null;
let deleteReply = { ok: true };
let probeReply = { ok: true, deletable: true, needsStop: false };
let probeMode = 'answer';

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (url === PROBE_ROUTE) {
    lastProbe = body;
    if (probeMode === 'throw') throw new Error('offline');
    if (probeMode === 'bodyless') {
      return {
        status: 500,
        json: async () => {
          throw new Error('no body');
        },
      };
    }
    return { status: 200, json: async () => probeReply };
  }
  assert.equal(url, DELETE_ROUTE, `unexpected fetch target ${url}`);
  lastDelete = { url, body };
  return { status: 200, json: async () => deleteReply };
};

const renderOverlay = () => {
  const tree = evaluate(overlay.component());
  /* The dialog unmounted: the next render is a fresh mount with clean state. */
  if (tree === null) mountEpoch += 1;
  return tree;
};
/**
 * Open the confirmation from the menu row and let its preflight settle,
 * cancelling any dialog the previous section left open first — the UI cannot
 * reach the session menu through an open modal, so the test must not either.
 */
const openConfirm = async () => {
  if (renderOverlay() !== null) {
    buttonsOf(renderOverlay())[0].props.onClick();
    await tick();
    assert.equal(renderOverlay(), null, 'cancelling must close the dialog before the next one opens');
  }
  menuButtons[0].props.onClick();
  await tick();
};

/* -------------------------------------------------------- probe -> normal dialog */
await openConfirm();
assert.deepEqual(lastProbe, { sessionId: 'session-abc' }, 'opening the dialog must probe the target session');
assert.deepEqual(menuCalls, [false], 'clicking must dismiss the menu through useMenuOpenState');

const dialogTree = renderOverlay();
assert.notEqual(dialogTree, null, 'the overlay must render the dialog once a request is pending');
assert.equal(findAll(dialogTree, (el) => el.props?.role === 'dialog').length, 1, 'exactly one dialog must render');
assert.equal(textOf(findAll(dialogTree, (el) => el.type === 'h2')[0]), '删除会话', 'the dialog title must be localized');
assert.match(textOf(dialogTree), /我的会话/, 'the dialog body must name the target session');
assert.match(textOf(dialogTree), /回收站/, 'the dialog must say the session goes to the Recycle Bin');
assert.doesNotMatch(textOf(dialogTree), /正在检查/, 'a settled preflight must clear the checking note');

const dialogButtons = buttonsOf(dialogTree);
assert.equal(dialogButtons.length, 2, 'the dialog must offer exactly cancel and confirm');
assert.equal(textOf(dialogButtons[0]), '取消');
assert.equal(textOf(dialogButtons[1]), '移到回收站');
assert.equal(dialogButtons[1].props.disabled, false, 'a deletable session must leave confirm enabled');
assert.match(dialogButtons[1].props.className, /dsd-btn-danger/, 'confirm must use the danger treatment');

/* -------------------------------------------------------- confirm -> success */
buttonsOf(renderOverlay())[1].props.onClick();
await tick();
assert.equal(lastDelete.url, DELETE_ROUTE, 'confirm must POST the delete route');
assert.deepEqual(lastDelete.body, { sessionId: 'session-abc' }, 'a first attempt must not ask the Host to stop activity');
assert.equal(renderOverlay(), null, 'a successful deletion must close the dialog');

/* ------------------------------------------- probe refusal stops the operator */
for (const [code, expected] of [
  ['missing', /未找到该会话的持久化记录/],
  ['no-location', /无法确定该会话的日志位置/],
  ['not-a-session', /不像是一个会话目录/],
]) {
  probeReply = { ok: true, deletable: false, code };
  await openConfirm();
  const tree = renderOverlay();
  assert.match(textOf(tree), expected, `a refused probe (${code}) must explain itself before committing`);
  assert.equal(buttonsOf(tree)[1].props.disabled, true, `a refused probe (${code}) must disable confirm`);

  /* Clicking a disabled confirm must send nothing at all. */
  lastDelete = null;
  buttonsOf(tree)[1].props.onClick();
  await tick();
  assert.equal(lastDelete, null, `a refused probe (${code}) must not reach the delete route`);
  assert.notEqual(renderOverlay(), null, `a refused probe (${code}) must keep the dialog open`);

  buttonsOf(renderOverlay())[0].props.onClick();
  await tick();
  assert.equal(renderOverlay(), null, `cancel must close the refused dialog (${code})`);
}

/* ------------------------------------------ live -> a notice, not a refusal */
probeReply = { ok: true, deletable: true, needsStop: false, live: true };
await openConfirm();
const liveTree = renderOverlay();
assert.match(textOf(liveTree), /处于活动状态/, 'a live session must be flagged as active before committing');
assert.equal(
  buttonsOf(liveTree)[1].props.disabled,
  false,
  'a live session must remain deletable — being live is not a refusal',
);
assert.equal(textOf(buttonsOf(liveTree)[1]), '移到回收站', 'a live idle session must keep the plain delete action');

deleteReply = { ok: true };
buttonsOf(liveTree)[1].props.onClick();
await tick();
assert.deepEqual(
  lastDelete.body,
  { sessionId: 'session-abc' },
  'a live idle deletion must not ask the Host to stop activity',
);
assert.equal(renderOverlay(), null, 'deleting a live idle session must close the dialog');

/* -------------------------------------- probe hint -> one-step stop and delete */
probeReply = { ok: true, deletable: true, needsStop: true };
await openConfirm();
let tree = renderOverlay();
assert.match(textOf(tree), /正在运行的任务/, 'a needsStop hint must open the stop-and-delete wording');
assert.equal(textOf(buttonsOf(tree)[1]), '停止并删除', 'the hinted action must be labelled as stopping');

deleteReply = { ok: true };
buttonsOf(tree)[1].props.onClick();
await tick();
assert.deepEqual(
  lastDelete.body,
  { sessionId: 'session-abc', stopActivity: true },
  'a hinted attempt must ask the Host to stop activity in one step',
);
assert.equal(renderOverlay(), null, 'a successful stop-and-delete must close the dialog');

/* ------------------------------------------------ busy race -> escalate in place */
probeReply = { ok: true, deletable: true, needsStop: false };
deleteReply = { ok: false, code: 'busy' };
await openConfirm();
assert.equal(buttonsOf(renderOverlay())[1].props.disabled, false);
buttonsOf(renderOverlay())[1].props.onClick();
await tick();
tree = renderOverlay();
assert.match(textOf(tree), /正在运行的任务/, 'a busy reply must escalate to the stop-and-delete wording');
assert.equal(textOf(buttonsOf(tree)[1]), '停止并删除', 'the escalated action must be labelled as stopping');

deleteReply = { ok: false, code: 'busy' };
buttonsOf(tree)[1].props.onClick();
await tick();
assert.deepEqual(lastDelete.body, { sessionId: 'session-abc', stopActivity: true }, 'the escalation must be sent as a stop');
assert.match(textOf(renderOverlay()), /仍有正在运行的任务/, 'a still-busy session must surface an error instead of looping');

/* ------------------------------------------------------------- error mapping */
for (const [code, expected] of [
  ['missing', /未找到该会话的持久化记录/],
  ['no-location', /无法确定该会话的日志位置/],
  ['not-a-session', /不像是一个会话目录/],
  ['trash-failed', /移动到回收站失败/],
  ['trash-unsupported', /不支持回收站删除/],
  ['archive-failed', /归档该会话失败/],
  ['flush-failed', /尚未落盘的事件/],
  ['list-failed', /读取会话列表失败/],
]) {
  probeReply = { ok: true, deletable: true, needsStop: false };
  deleteReply = { ok: false, code, detail: 'detail-text' };
  await openConfirm();
  buttonsOf(renderOverlay())[1].props.onClick();
  await tick();
  assert.match(textOf(renderOverlay()), expected, `delete code ${code} must map to its own message`);
  buttonsOf(renderOverlay())[0].props.onClick();
  await tick();
}

/* --------------------------------------------- unknown preflight stays permissive */
probeMode = 'throw';
deleteReply = { ok: true };
await openConfirm();
assert.deepEqual(lastProbe, { sessionId: 'session-abc' }, 'the probe must still be attempted when it will fail');
tree = renderOverlay();
assert.doesNotMatch(textOf(tree), /无法|失败/, 'an unreachable preflight must not fabricate a refusal');
assert.equal(buttonsOf(tree)[1].props.disabled, false, 'a failed preflight must leave confirm enabled');
buttonsOf(tree)[1].props.onClick();
await tick();
assert.equal(renderOverlay(), null, 'a deletion may still proceed when the preflight failed');

probeMode = 'bodyless';
await openConfirm();
assert.equal(buttonsOf(renderOverlay())[1].props.disabled, false, 'a bodyless preflight must leave confirm enabled');
buttonsOf(renderOverlay())[0].props.onClick();
await tick();

/* ------------------------------------------------------------ transport failure */
probeMode = 'answer';
probeReply = { ok: true, deletable: true, needsStop: false };
globalThis.fetch = async () => {
  throw new Error('offline');
};
await openConfirm();
buttonsOf(renderOverlay())[1].props.onClick();
await tick();
assert.match(textOf(renderOverlay()), /请求失败/, 'a rejected fetch must surface the network message');

/* An HTTP failure without a JSON body must not be reported as success. */
globalThis.fetch = async () => ({
  status: 403,
  json: async () => {
    throw new Error('no body');
  },
});
await openConfirm();
buttonsOf(renderOverlay())[1].props.onClick();
await tick();
assert.match(textOf(renderOverlay()), /删除失败/, 'a bodyless HTTP failure must surface as a failure');

delete globalThis.window;
console.log(
  'client smoke: OK — registration contract, menu wiring, preflight-driven dialog, escalation, error mapping and transport failures verified',
);
