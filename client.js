/**
 * dsh-session-delete — Client half: a "Delete session" row in the sidebar
 * Session menu, plus its confirmation dialog. Confirming moves the Session's
 * log directory to the operating system's Recycle Bin (see the Host half).
 *
 * Built on the supported extension points of DSH 0.2.0-rc.2 rather than on DOM
 * or React-internals scraping:
 *
 *   - `sidebar.workspaces.session.menu.item` — the Session "..." menu's row list,
 *     declared by `client-ui-workspace`. The shipped rows are pin (100),
 *     rename (200), fork (300), archive (400); this plugin takes 500.
 *   - `shell.overlay` — the frame-wide floating layer for the confirmation card.
 *
 * The entry renders its own `role="menuitem"` button and dismisses the menu
 * through the injected `useMenuOpenState` hook, which is what that slot's
 * contract requires; the list's keyboard walk and focus return read the DOM,
 * so a plain button joins them. Follows the plugin guidance to use only theme
 * tokens and no Harness Client package imports (ui-primitives in particular),
 * so it cannot drift with a UI-package bump.
 *
 * The registration id equals the package name, as the client module loader
 * requires.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const MENU_SLOT = 'sidebar.workspaces.session.menu.item';
    const OVERLAY_SLOT = 'shell.overlay';
    const ROUTE = '/dsh-session-delete/delete';
    const PROBE_ROUTE = '/dsh-session-delete/probe';

    /* Metrics and tokens mirror ui-primitives' Menu `.item` and `.danger` rows
       so this row lines up with the shipped ones. */
    const CSS = [
      '.dsd-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;',
      'padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;',
      'cursor:pointer;font:inherit;font-size:13px;line-height:20px;text-align:left;',
      'color:var(--dsw-alias-state-error-primary);}',
      '.dsd-item:hover:not(:disabled),.dsd-item:focus-visible:not(:disabled)',
      '{background:var(--dsw-alias-interactive-bg-hover-danger);outline:none;}',
      '.dsd-item:disabled{opacity:.4;cursor:not-allowed;}',
      '.dsd-item>.dsd-icon{display:inline-flex;flex:none;width:14px;height:14px;',
      'align-items:center;justify-content:center;}',
      '.dsd-item>.dsd-icon>svg{width:14px;height:14px;}',
      '.dsd-item>.dsd-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dsd-wrap{position:relative;}',
      '.dsd-separator{height:.5px;margin:3px 2px;background:var(--dsw-alias-border-l2);}',
      '.dsd-overlay{pointer-events:auto;position:fixed;inset:0;z-index:1000;display:flex;',
      'align-items:center;justify-content:center;padding:24px;}',
      '.dsd-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);}',
      '.dsd-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;',
      'gap:20px;width:min(380px,100%);padding:22px 24px 24px;border:0;',
      'border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);',
      'box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);}',
      '.dsd-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary);}',
      '.dsd-body{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);',
      'word-break:break-word;}',
      '.dsd-note{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
      '.dsd-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);',
      'word-break:break-word;white-space:pre-wrap;}',
      '.dsd-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;}',
      '.dsd-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;',
      'gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);',
      'cursor:pointer;font:inherit;font-size:14px;line-height:22px;',
      'color:var(--dsw-alias-label-primary);background:transparent;}',
      '.dsd-btn:disabled{cursor:not-allowed;opacity:.4;}',
      '.dsd-btn-outline{border:.5px solid var(--dsw-alias-border-l3);}',
      '.dsd-btn-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
      '.dsd-btn-danger{background:var(--dsw-alias-state-error-primary);',
      'color:var(--dsw-alias-label-primary-foreground);}',
      '.dsd-btn-danger:hover:not(:disabled){background:var(--dsw-alias-state-error-hover,var(--dsw-alias-state-error-primary));}',
    ].join('');

    const DICT = {
      zh: {
        menu: '删除会话',
        title: '删除会话',
        body: (title) => `将把会话“${title}”及其日志目录移到系统回收站。你可以从回收站中还原它，但在那之前它不会出现在侧栏里。`,
        stopTitle: '该会话正在运行',
        stopBody: (title) => `会话“${title}”仍有正在运行的任务。停止这些任务并删除该会话（记录会移到回收站）？`,
        note: '会话日志会移入 Windows 回收站，而不是立即永久删除。',
        cancel: '取消',
        confirm: '移到回收站',
        stopConfirm: '停止并删除',
        pending: '正在移到回收站…',
        checking: '正在检查该会话…',
        liveNotice: '该会话在本次 DSH 运行中处于活动状态；删除后它的会话视图将不再可用。',
        flushFailed: '无法把该会话尚未落盘的事件写入磁盘，已中止删除以免损坏日志。',
        errMissing: '未找到该会话的持久化记录（可能从未写入磁盘）。',
        errBusy: '该会话仍有正在运行的任务。',
        errNoLocation: '无法确定该会话的日志位置，已中止删除。',
        errNotSession: '目标目录不像是一个会话目录，已中止删除。',
        errUnreadable: '无法读取该会话的日志目录。',
        errTrash: '移动到回收站失败，会话文件仍保留在原处。',
        errUnsupported: '当前系统不支持回收站删除（该功能需要 Windows）。',
        errArchive: '归档该会话失败，已中止删除。',
        errList: '读取会话列表失败。',
        errNetwork: '请求失败（服务不可达或未通过认证）。',
        errUnknown: '删除失败。',
      },
      en: {
        menu: 'Delete session',
        title: 'Delete session',
        body: (title) => `This moves session “${title}” and its log directory to the system Recycle Bin. You can restore it from there, but the row stays out of the sidebar until you do.`,
        stopTitle: 'This session is running',
        stopBody: (title) => `Session “${title}” still has running work. Stop that work and delete the session (its records go to the Recycle Bin)?`,
        note: 'The session log goes to the Windows Recycle Bin instead of being permanently erased.',
        cancel: 'Cancel',
        confirm: 'Move to Recycle Bin',
        stopConfirm: 'Stop and delete',
        pending: 'Moving to the Recycle Bin…',
        checking: 'Checking this session…',
        liveNotice: 'This session is active in the current DSH run; deleting it will end its conversation view.',
        flushFailed: 'The session\'s unflushed events could not be written to disk, so the deletion was aborted rather than risk corrupting the log.',
        errMissing: 'No persisted record was found for this session.',
        errBusy: 'This session still has running work.',
        errNoLocation: 'The session log location could not be resolved, so the deletion was aborted.',
        errNotSession: 'The target directory does not look like a session directory, so the deletion was aborted.',
        errUnreadable: 'The session log directory could not be read.',
        errTrash: 'Moving the session to the Recycle Bin failed; its files are still in place.',
        errUnsupported: 'The Recycle Bin is not available on this platform (Windows is required).',
        errArchive: 'Archiving the session failed, so the deletion was aborted.',
        errList: 'Reading the session list failed.',
        errNetwork: 'The request failed (service unreachable or not authenticated).',
        errUnknown: 'Deletion failed.',
      },
    };

    /** Follow the GUI locale; fall back to the browser language, then English. */
    function detectLang(ctx) {
      let id = '';
      try {
        const locale = ctx.get('locale');
        if (locale !== undefined && typeof locale.getSnapshot === 'function') {
          const active = locale.getSnapshot()?.active;
          if (typeof active === 'string') id = active;
        } else if (locale !== undefined && typeof locale.getLocale === 'function') {
          const value = locale.getLocale();
          id = typeof value === 'string' ? value : typeof value?.id === 'string' ? value.id : '';
        }
      } catch {
        id = '';
      }
      if (id === '' && typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
        id = navigator.language;
      }
      return id.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }

    /* ---- pending confirmation store -------------------------------------
       One shared slot for the dialog request. Kept as a tiny external store so
       the menu entry and the overlay entry — two separate registrations that
       never share a React tree — can talk without any Harness-specific hook
       machinery, and the overlay subscribes with plain `useSyncExternalStore`. */
    let pending = null;
    const listeners = new Set();
    function setPending(next) {
      pending = next;
      for (const listener of [...listeners]) listener();
    }
    /**
     * Fold the preflight answer into the request the dialog is showing, but only
     * while that exact request is still the open one — the operator may have
     * cancelled or opened another row while the probe was in flight.
     */
    function patchPending(sessionId, patch) {
      if (pending === null || pending.sessionId !== sessionId) return;
      pending = { ...pending, ...patch };
      for (const listener of [...listeners]) listener();
    }
    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
    function getPending() {
      return pending;
    }

    function TrashIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M2.5 4.2h11M6.3 2h3.4M4.2 4.2l.6 8.6c0 .7.6 1.2 1.2 1.2h4c.7 0 1.2-.5 1.2-1.2l.6-8.6M6.5 7v4.2M9.5 7v4.2' }),
      );
    }

    /**
     * The Session menu row (order 500). Dismisses the menu through the slot's
     * injected `useMenuOpenState` hook, then opens the confirmation dialog.
     */
    function DeleteSessionMenuItem(props) {
      const sessionId = props.sessionId;
      const useMenuOpenState = props.useMenuOpenState;
      const label = props.label;
      const closeMenu =
        typeof useMenuOpenState === 'function'
          ? useMenuOpenState()[1]
          : () => {
              try {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
              } catch {
                /* Nothing else to do: the dialog still opens. */
              }
            };
      const onSelect = () => {
        try {
          closeMenu(false);
        } catch {
          /* A failing menu close must not block the dialog. */
        }
        openConfirm(sessionId, props.displayTitle === '' ? sessionId : props.displayTitle);
      };
      return h(
        'div',
        { className: 'dsd-wrap' },
        h('div', { className: 'dsd-separator', role: 'separator' }),
        h(
          'button',
          { type: 'button', role: 'menuitem', className: 'dsd-item', onClick: onSelect, title: label },
          h('span', { className: 'dsd-icon' }, h(TrashIcon)),
          h('span', { className: 'dsd-label' }, label),
        ),
      );
    }

    /** Map one failure code to operator-facing text. */
    function messageFor(code, detail, L) {
      switch (code) {
        case 'missing':
          return L.errMissing;
        case 'busy':
          return L.errBusy;
        case 'no-location':
        case 'bad-path':
          return L.errNoLocation;
        case 'not-a-session':
          return L.errNotSession;
        case 'unreadable':
          return L.errUnreadable;
        case 'trash-failed':
          return L.errTrash + (detail ? `\n${detail}` : '');
        case 'trash-unsupported':
          return L.errUnsupported;
        case 'archive-failed':
          return L.errArchive + (detail ? `\n${detail}` : '');
        case 'flush-failed':
          return L.flushFailed + (detail ? `\n${detail}` : '');
        case 'list-failed':
          return L.errList + (detail ? `\n${detail}` : '');
        case 'network':
          return L.errNetwork;
        default:
          return L.errUnknown + (code ? ` (${code})` : '') + (detail ? `\n${detail}` : '');
      }
    }

    /** POST the deletion to the Host half. Returns a `{ ok, code, detail }` result. */
    async function callDelete(sessionId, stopActivity) {
      let response;
      try {
        response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(stopActivity ? { sessionId, stopActivity: true } : { sessionId }),
        });
      } catch {
        return { ok: false, code: 'network' };
      }
      try {
        const body = await response.json();
        if (body !== null && typeof body === 'object') return body;
      } catch {
        /* Fall through to the status-derived failure. */
      }
      return { ok: false, code: `http-${String(response.status)}` };
    }

    /**
     * Ask the Host whether this Session can be deleted, before the operator
     * commits. Returns the probe payload, or null when the answer is unknown —
     * an unknown answer must never block the dialog, because the deletion
     * re-runs exactly the same preflight and reports the real reason.
     */
    async function callProbe(sessionId) {
      let response;
      try {
        response = await fetch(PROBE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });
      } catch {
        return null;
      }
      try {
        const body = await response.json();
        if (body !== null && typeof body === 'object' && body.ok === true) return body;
      } catch {
        /* Fall through to "unknown". */
      }
      return null;
    }

    /** Open the confirmation for one row and fill in its preflight answer. */
    function openConfirm(sessionId, title) {
      setPending({ sessionId, title, stop: false, probe: 'pending' });
      callProbe(sessionId)
        .then((probe) => patchPending(sessionId, { probe }))
        .catch(() => patchPending(sessionId, { probe: null }));
    }

    /** One request's confirmation card; in-flight and error state die with it. */
    function ConfirmDialog({ request, L }) {
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const cancelRef = React.useRef(null);
      const probe = request.probe;
      /* `null` means the preflight answer is unknown (its request failed) — stay
         permissive, because the deletion re-runs the very same preflight and
         reports the real reason. `'pending'` means the answer is still in flight. */
      const answered = probe !== null && probe !== undefined && probe !== 'pending';
      const blocked = answered && probe.deletable === false;
      const escalated = request.stop === true || (answered && probe.needsStop === true);

      React.useEffect(() => {
        cancelRef.current?.focus();
      }, []);

      const close = React.useCallback(() => {
        if (!busy) setPending(null);
      }, [busy]);

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') close();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [close]);

      const run = (stopActivity) => {
        if (blocked) return;
        setBusy(true);
        setError(null);
        callDelete(request.sessionId, stopActivity)
          .then((result) => {
            setBusy(false);
            if (result !== null && result.ok === true) {
              setPending(null);
              return;
            }
            const code = result?.code ?? 'unknown';
            if (code === 'busy' && !stopActivity) {
              /* Racing a turn that started after the probe: escalate in place. */
              patchPending(request.sessionId, { stop: true });
              return;
            }
            setError(messageFor(code, result?.detail, L));
          })
          .catch((reason) => {
            setBusy(false);
            setError(reason instanceof Error ? reason.message : String(reason));
          });
      };

      return h(
        'div',
        {
          className: 'dsd-overlay',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) close();
          },
        },
        h('div', { className: 'dsd-mask' }),
        h(
          'div',
          { className: 'dsd-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': escalated ? L.stopTitle : L.title },
          h('h2', { className: 'dsd-title' }, escalated ? L.stopTitle : L.title),
          h('p', { className: 'dsd-body' }, escalated ? L.stopBody(request.title) : L.body(request.title)),
          h('p', { className: 'dsd-note' }, L.note),
          probe === 'pending' ? h('p', { className: 'dsd-note', role: 'status' }, L.checking) : null,
          busy ? h('p', { className: 'dsd-note', role: 'status' }, L.pending) : null,
          !blocked && answered && probe.live === true ? h('p', { className: 'dsd-note' }, L.liveNotice) : null,
          blocked
            ? h('p', { className: 'dsd-error', role: 'alert' }, messageFor(probe.code, probe.detail, L))
            : null,
          error === null ? null : h('p', { className: 'dsd-error', role: 'alert' }, error),
          h(
            'div',
            { className: 'dsd-footer' },
            h('button', { ref: cancelRef, type: 'button', className: 'dsd-btn dsd-btn-outline', disabled: busy, onClick: close }, L.cancel),
            h(
              'button',
              {
                type: 'button',
                className: 'dsd-btn dsd-btn-danger',
                disabled: busy || blocked,
                onClick: () => run(escalated),
              },
              escalated ? L.stopConfirm : L.confirm,
            ),
          ),
        ),
      );
    }

    /** The overlay entry: nothing while no confirmation is pending. */
    function DeleteOverlay({ L }) {
      const request = React.useSyncExternalStore(subscribe, getPending, getPending);
      if (request === null) return null;
      return h(ConfirmDialog, { key: `${request.sessionId}:${String(request.stop)}`, request, L });
    }

    function apply(ctx) {
      const L = DICT[detectLang(ctx)];

      ctx.effect(
        () => {
          const style = document.createElement('style');
          style.setAttribute('data-plugin', 'dsh-session-delete');
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => style.remove();
        },
        'dsh-session-delete: styles',
      );

      ctx.slots.inject(MENU_SLOT, () =>
        ctx.slots.register({ name: MENU_SLOT, id: 'dsh-session-delete.delete', order: 500 }, (props) =>
          h(DeleteSessionMenuItem, { ...props, label: L.menu }),
        ),
      );

      ctx.slots.inject(OVERLAY_SLOT, () =>
        ctx.slots.register({ name: OVERLAY_SLOT, id: 'dsh-session-delete.confirm', order: 500 }, () =>
          h(DeleteOverlay, { L }),
        ),
      );
    }

    return { inject: ['slots'], apply };
  },
});
