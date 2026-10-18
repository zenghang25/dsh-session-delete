/**
 * dsh-session-delete v0.5.0 — 会话删除（Client 半）
 *
 * 只做一件事：在会话行的「⋯」菜单里注册一个「删除会话」项，点击后直接删除，不弹确认框。
 *
 * 与旧版（0.1.x）的根本区别：
 *   - 旧版用 MutationObserver 监听菜单挂载、克隆菜单项 DOM 来注入按钮，React 重渲染时
 *     会和手插节点打架（截图里官方菜单项整段重复就是这个原因），还带着一堆 fiber 探测。
 *   - 现在走官方扩展点：`ctx.slots.inject('sidebar.workspaces.session.menu.item', ...)`
 *     注册一个真正的菜单条目，React 自己渲染，位置由 order 决定，重复项不可能出现。
 *   - 不再有「归档全部 / 删除全部」、不再有二次确认弹窗；失败用轻提示（toast）报告。
 *
 * 依赖（client inject）：slots、sessions、locale。
 * 菜单条目语义：点击 → POST /dsh-session-delete/delete → 成功后在本地会话模型摘行并
 * 刷新列表，侧栏立刻消失，无需重启。
 */
window.__ModuleLoader__.load({
	id: 'dsh-session-delete',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var NS = 'dshSessionDelete';
		var DICT = {
			zh: {
				deleteSession: '删除会话',
				deleted: '已删除，可在回收站还原',
				failed: '删除失败',
				active: '删除失败：会话仍在运行，未能停止，请稍后重试',
				network: '删除失败：无法连接 DSH 服务',
			},
			en: {
				deleteSession: 'Delete session',
				deleted: 'Deleted — recoverable from the Recycle Bin',
				failed: 'Delete failed',
				active: 'Delete failed: the session is still running and could not be stopped; retry later',
				network: 'Delete failed: DSH service unreachable',
			},
		};

		function apply(ctx) {
			if (typeof document === 'undefined' || document.body === null) return;

			var React = require('react');
			var primitives = require('@deepseek-ai/dsh-client-ui-primitives');

			/* ---------- 轻提示：成功/失败都在右下角短暂显示，不打断操作 ---------- */
			var styleTag = document.createElement('style');
			styleTag.setAttribute('data-plugin', 'dsh-session-delete');
			styleTag.textContent = [
				'.dsd-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:100000;',
				'padding:8px 14px;border-radius:8px;font-size:13px;line-height:18px;max-width:70vw;',
				'background:var(--dsw-alias-label-primary,#1a1a1a);color:var(--dsw-alias-label-primary-inverted,#fff);',
				'box-shadow:0 8px 24px rgba(0,0,0,.28);pointer-events:none;white-space:pre-wrap;word-break:break-all;}',
				'.dsd-toast-error{background:var(--dsw-alias-state-error-primary,#d92d20);}',
			].join('');
			document.head.appendChild(styleTag);

			/* ---------- 删除过的会话 id：宿主可能仍把 live 会话留在内存里，侧栏会再把它画出来。
			 *          这里把删除过的行在 CSS 层永久隐藏（id 列表存 localStorage），
			 *          保证「删除 = 从侧栏消失」，即使宿主还没释放这个会话对象。 ---------- */
			var HIDDEN_KEY = 'dsh-session-delete.hidden.v1';
			var hiddenIds = [];
			try {
				var storedHidden = typeof localStorage === 'undefined' ? null : localStorage.getItem(HIDDEN_KEY);
				var parsedHidden = storedHidden === null ? [] : JSON.parse(storedHidden);
				if (Array.isArray(parsedHidden)) {
					hiddenIds = parsedHidden.filter(function (id) {
						return typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id);
					}).slice(-200);
				}
			} catch (error) {
				hiddenIds = [];
			}
			function saveHidden() {
				try {
					if (typeof localStorage !== 'undefined') localStorage.setItem(HIDDEN_KEY, JSON.stringify(hiddenIds));
				} catch (error) {}
			}
			function hideDeletedRow(id) {
				if (typeof id !== 'string' || id === '' || !/^[A-Za-z0-9._-]+$/.test(id)) return;
				try {
					styleTag.textContent += '[role="treeitem"][data-row-key="session:' + id + '"]{display:none!important;}';
				} catch (error) {}
				if (hiddenIds.indexOf(id) === -1) {
					hiddenIds.push(id);
					if (hiddenIds.length > 200) hiddenIds = hiddenIds.slice(-200);
					saveHidden();
				}
			}
			for (var hiddenIndex = 0; hiddenIndex < hiddenIds.length; hiddenIndex += 1) {
				try {
					styleTag.textContent += '[role="treeitem"][data-row-key="session:' + hiddenIds[hiddenIndex] + '"]{display:none!important;}';
				} catch (error) {}
			}

			/* 兼容清理：旧版本删除过、但宿主仍把 live 会话留在内存里的「幽灵行」。
			 * 判定：已归档 + live + 不属于任何工作区 + 没有落盘（persisted=false）。 */
			try {
				fetch('/dsh-session-delete/diag', { credentials: 'same-origin' }).then(function (response) {
					return response.json();
				}).then(function (payload) {
					if (payload === null || payload === undefined || payload.ok !== true || !Array.isArray(payload.archived)) return;
					var archived = new Set(payload.archived);
					var member = new Set();
					(payload.workspaces || []).forEach(function (workspace) {
						(workspace.sessionIds || []).forEach(function (id) { member.add(id); });
					});
					var persisted = new Set();
					(payload.queryList || []).forEach(function (record) {
						if (record !== null && record !== undefined && record.persisted === true) persisted.add(record.id);
					});
					(payload.live || []).forEach(function (session) {
						if (session === null || session === undefined) return;
						if (!archived.has(session.id) || member.has(session.id) || persisted.has(session.id)) return;
						hideDeletedRow(session.id);
					});
				}).catch(function () {});
			} catch (error) {}

			var toastTimer = null;
			function showToast(text, isError) {
				var el = document.createElement('div');
				el.setAttribute('class', 'dsd-toast' + (isError ? ' dsd-toast-error' : ''));
				el.setAttribute('role', 'status');
				el.textContent = text;
				document.body.appendChild(el);
				var lifetime = isError ? 6000 : 2200;
				if (toastTimer !== null) clearTimeout(toastTimer);
				toastTimer = setTimeout(function () {
					toastTimer = null;
					if (el.parentNode !== null) el.parentNode.removeChild(el);
				}, lifetime);
			}

			/* ---------- 本地会话模型：删完立刻摘行 + 刷新列表，无需重启 ---------- */
			function sessionsService() {
				try {
					var service = ctx.get('sessions');
					return service !== undefined && service !== null ? service : null;
				} catch (error) {
					return null;
				}
			}

			function workspacesService() {
				try {
					var service = ctx.get('workspaces');
					return service !== undefined && service !== null ? service : null;
				} catch (error) {
					return null;
				}
			}

			function forgetDeleted(ids) {
				var service = sessionsService();
				var workspaces = workspacesService();
				var index;
				/* 1) 先让客户端工作区模型拿到权威归档集合：宿主在删除开始时已经归档该会话，
				 *    但宿主直接调用 registry 产生的归档变更不一定以命令回包同步到客户端；
				 *    补一次官方 archiveSession（已归档时宿主直接返回集合，不报错），
				 *    这样「显示已归档」过滤器下也不会再出现它。 */
				if (workspaces !== null && typeof workspaces.archiveSession === 'function') {
					for (index = 0; index < ids.length; index += 1) {
						try {
							Promise.resolve(workspaces.archiveSession(ids[index])).catch(function () {});
						} catch (error) {}
					}
				}
				/* 2) 立刻从本地会话列表摘行 + CSS 隐藏该行（双保险）。 */
				for (index = 0; index < ids.length; index += 1) hideDeletedRow(ids[index]);
				if (service === null) return;
				function removeLocally() {
					if (typeof service.handleSessionRemoved !== 'function') return;
					for (var row = 0; row < ids.length; row += 1) {
						try {
							service.handleSessionRemoved(ids[row]);
						} catch (error) {
							console.error('[dsh-session-delete] local removal', ids[row], error);
						}
					}
				}
				removeLocally();
				try {
					if (typeof service.refresh === 'function') {
						/* 刷新会把宿主持有的 live 会话重新列出来，所以刷新完成后再摘一次。 */
						Promise.resolve(service.refresh()).then(removeLocally, function (error) {
							console.error('[dsh-session-delete] list refresh', error);
						});
					}
				} catch (error) {
					console.error('[dsh-session-delete] list refresh', error);
				}
			}

			/* ---------- Host 半通信：同源 POST ---------- */
			async function requestDelete(sessionId) {
				var response;
				try {
					response = await fetch('/dsh-session-delete/delete', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						credentials: 'same-origin',
						body: JSON.stringify({ sessionId: sessionId }),
					});
				} catch (error) {
					return { network: true };
				}
				var payload = null;
				try {
					payload = await response.json();
				} catch (error) {
					payload = null;
				}
				return { ok: response.ok && payload !== null && payload.ok === true, payload: payload, status: response.status };
			}

			async function deleteSession(sessionId) {
				var result = await requestDelete(sessionId);
				if (result.network === true) {
					showToast(localeText('network'), true);
					return;
				}
				if (result.ok === true) {
					var removed = result.payload !== null && Array.isArray(result.payload.deleted) ? result.payload.deleted : [sessionId];
					forgetDeleted(removed);
					showToast(localeText('deleted'), false);
					return;
				}
				var payload = result.payload !== null && result.payload !== undefined ? result.payload : {};
				var code = typeof payload.code === 'string' ? payload.code : '';
				var detail = typeof payload.detail === 'string' ? payload.detail.slice(0, 240) : '';
				var base = code === 'active' ? localeText('active') : localeText('failed');
				var message = base + (code !== '' && code !== 'active' ? ' (' + code + ')' : '') + (detail !== '' && code !== 'active' ? ': ' + detail : '');
				showToast(message, true);
			}

			/* ---------- 文案：插件自带字典，跟随 GUI 语言 ---------- */
			var localeId = 'zh';
			try {
				var locale = ctx.get('locale');
				var snapshot = locale !== undefined && locale !== null && typeof locale.getLocale === 'function' ? locale.getLocale() : undefined;
				var id = typeof snapshot === 'string' ? snapshot : (snapshot !== null && snapshot !== undefined && typeof snapshot.id === 'string' ? snapshot.id : '');
				if (typeof id === 'string' && id.toLowerCase().indexOf('en') === 0) localeId = 'en';
			} catch (error) {
				/* 跟随失败时用中文 */
			}
			var text = DICT[localeId];
			function localeText(key) {
				var value = text[key];
				return typeof value === 'string' ? value : key;
			}

			/* ---------- 唯一的菜单项：删除会话（直接删，不弹确认框） ---------- */
			function DeleteSessionMenuItem(props) {
				var menu = props.useMenuOpenState();
				var setMenuOpen = Array.isArray(menu) ? menu[1] : function () {};
				var label = typeof props.t === 'function' ? props.t('deleteSession') : localeText('deleteSession');
				return React.createElement(primitives.MenuItemButton, {
					separatorBefore: true,
					danger: true,
					icon: React.createElement(primitives.IconTrashOutlineRegular, { size: 14 }),
					onSelect: function () {
						setMenuOpen(false);
						void props.deleteSession(props.sessionId);
					},
				}, label);
			}

			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en });
			}, 'dsh-session-delete: dictionaries');

			ctx.slots.inject('sidebar.workspaces.session.menu.item', function () {
				return ctx.slots.register({
					name: 'sidebar.workspaces.session.menu.item',
					id: 'delete-session',
					order: 500,
					locale: NS,
					inject: function () {
						return { deleteSession: deleteSession };
					},
				}, DeleteSessionMenuItem);
			});

			ctx.effect(function () {
				return function () {
					if (toastTimer !== null) clearTimeout(toastTimer);
					if (styleTag.parentNode !== null) styleTag.parentNode.removeChild(styleTag);
				};
			}, 'dsh-session-delete: client cleanup');

			console.log('[dsh-session-delete] client ready v0.5.0, lang=' + localeId);
		}

		exports.apply = apply;
		/* 客户端插件依赖：等这些 service 就绪后再 apply。 */
		exports.inject = ['slots', 'sessions', 'locale'];
		return module.exports;
	},
});
