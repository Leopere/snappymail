(doc => {

const
	qUri = path => doc.location.pathname.replace(/\/+$/,'') + '/?/' + path,
	eId = id => doc.getElementById('rl-'+id),
	admin = '1' == eId('app').dataset.admin,
	mimeJSON = 'application/json',
	transportPingUrl = qUri('Ping/0/'),
	transportPingInterval = 4000,

	toggle = div => {
		eId('loading').hidden = true;
		div.hidden = false;
	},
	showError = msg => {
		let div = eId('loading-error');
		div.append(msg);
		toggle(div);
	},

	loadScript = src => src ? new Promise((resolve, reject) => {
			const script = doc.createElement('script');
			script.onload = () => resolve();
			script.onerror = () => reject('Failed loading ' + src);
			script.src = src;
//			script.async = true;
			doc.head.append(script);
		}) : Promise.reject('src is empty'),

	installNotomoErrorReporter = appData => {
		const siteId = !admin && appData.Brand?.notomoSiteId;
		if (!siteId) {
			return;
		}
		if (window.__snappyMailNotomoReporter) {
			return;
		}

		const endpoint = 'https://notomo.colinknapp.com/collect',
			bugEndpoint = 'https://notomo.colinknapp.com/bug-report',
			nativeFetch = fetch.bind(window),
			sessionId = crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)),
				value => value.toString(16).padStart(2, '0')).join(''),
			seen = new Map(),
			allowedNames = new Set([
				'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError'
			]),
			sourceKind = value => {
				if (!value) {
					return '';
				}
				try {
					const url = new URL(value, doc.location.href),
						match = url.origin === doc.location.origin && url.pathname.match(
							/\/static\/js\/(?:min\/)?(admin|app|boot|libs|openpgp|serviceworker|sieve)(?:\.min)?\.js$/
						);
					return match ? match[1] : '';
				} catch (e) {
					return '';
				}
			},
			request = (url, body) => nativeFetch(url, {
				method: 'POST',
				mode: 'cors',
				credentials: 'omit',
				referrerPolicy: 'no-referrer',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify(body),
				keepalive: true
			}),
			coarsePath = () => {
				const hash = doc.location.hash.toLowerCase();
				if (hash.startsWith('#/settings')) {
					return '/settings';
				}
				if (/^#\/mailbox\/[^/]+\/m\d+(?:\/|$)/.test(hash)) {
					return '/message';
				}
				return hash.startsWith('#/mailbox') ? '/mailbox' : '/login';
			},
			validateBugReport = value => {
				const text = String(value || '').trim();
				if (!text) {
					return {error: 'Enter a short bug report.'};
				}
				if (text.length > 200) {
					return {error: 'Keep the report to 200 characters.'};
				}
				if (!/^(?=.*[A-Za-z0-9])[A-Za-z0-9 .-]+$/.test(text)) {
					return {error: 'Use only letters, numbers, spaces, periods, and dashes.'};
				}
				if (1 < (text.match(/\./g) || []).length || (text.includes('.') && !text.endsWith('.'))) {
					return {error: 'Use one sentence only.'};
				}
				return {text};
			},
			report = (eventName, details = {}) => {
				const eventData = {
					type: eventName,
					name: allowedNames.has(details.name) ? details.name : 'Error',
					source: sourceKind(details.source),
					lineno: Number.isSafeInteger(details.lineno) ? details.lineno : 0,
					colno: Number.isSafeInteger(details.colno) ? details.colno : 0
				},
				key = Object.values(eventData).join('|'),
				now = Date.now();
			if (seen.size >= 25 || now - (seen.get(key) || 0) < 5000) {
				return;
			}
			seen.set(key, now);
			request(endpoint, {
					site_id: siteId,
					session_id: sessionId,
					visitor_id: sessionId,
					ts: now,
					kind: 'error',
					event_name: eventName,
					event_data: eventData
				}).catch(() => {});
			},
			installBugReportWidget = token => {
				if (!token || !doc.body || doc.querySelector('[data-snappymail-bug-report]')) {
					return;
				}
				const host = doc.createElement('div'),
					root = host.attachShadow({mode: 'open'}),
					style = doc.createElement('style'),
					button = doc.createElement('button'),
					form = doc.createElement('form'),
					input = doc.createElement('input'),
					includePath = doc.createElement('input'),
					pathText = doc.createElement('span'),
					status = doc.createElement('div');

				host.dataset.snappymailBugReport = '';
				style.textContent =
					':host{all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
						'font:14px system-ui;color:#172033}*{box-sizing:border-box}' +
					'button{border:0;border-radius:8px;background:#2f5bea;color:white;padding:9px 13px;' +
						'font:600 14px system-ui;cursor:pointer}' +
					'button[disabled]{background:#276749;cursor:default}' +
					'form{width:min(360px,calc(100vw - 32px));padding:16px;border:1px solid #d7dce5;' +
						'border-radius:12px;background:white;box-shadow:0 12px 40px #0f172a3d}' +
					'form[hidden]{display:none}h2{margin:0 0 6px;font-size:17px}' +
					'p,label{display:block;margin:0 0 10px;line-height:1.4}' +
					'p{font-size:12px;color:#526074}' +
					'input[type=text]{width:100%;padding:9px;border:1px solid #aeb7c7;border-radius:7px;' +
						'font:14px system-ui}' +
					'label input{margin-right:6px}.status{min-height:20px;margin:8px 0;color:#9b2c2c}' +
					'.actions{display:flex;justify-content:flex-end;gap:8px}' +
					'.cancel{background:white;color:#24324a;border:1px solid #aeb7c7}.ok{color:#276749}';
				button.type = 'button';
				button.textContent = 'Report a bug';
				form.hidden = true;
				form.setAttribute('aria-label', 'Report a bug');
				form.innerHTML = '<h2>Report a bug</h2>' +
					'<p>One sentence. Use letters, numbers, spaces, periods, and dashes only.</p>' +
					'<p>Do not include passwords, message text, email addresses, or other private information.</p>';
				input.type = 'text';
				input.name = 'report';
				input.maxLength = 200;
				input.autocomplete = 'off';
				input.required = true;
				input.setAttribute('aria-label', 'Bug report');
				includePath.type = 'checkbox';
				includePath.name = 'include-path';
				includePath.setAttribute('aria-label', 'Include current screen');
				const pathLabel = doc.createElement('label'),
					actions = doc.createElement('div'),
					cancel = doc.createElement('button'),
					send = doc.createElement('button');
				pathLabel.append(includePath, 'Include current screen ' , pathText);
				status.className = 'status';
				status.setAttribute('role', 'status');
				status.setAttribute('aria-live', 'polite');
				actions.className = 'actions';
				cancel.type = 'button';
				cancel.className = 'cancel';
				cancel.textContent = 'Cancel';
				send.type = 'submit';
				send.textContent = 'Send report';
				actions.append(cancel, send);
				form.append(input, pathLabel, status, actions);
				root.append(style, button, form);
				doc.body.append(host);
				const updatePath = () => pathText.textContent = includePath.checked
					? `(Path: ${coarsePath()})` : '(Path: not included)';
				updatePath();
				includePath.addEventListener('change', updatePath);
				button.addEventListener('click', () => {
					button.hidden = true;
					form.hidden = false;
					input.focus();
				});
				cancel.addEventListener('click', () => {
					form.hidden = true;
					button.hidden = false;
					button.focus();
				});
				form.addEventListener('submit', event => {
					event.preventDefault();
					const result = validateBugReport(input.value);
					status.className = 'status';
					if (result.error) {
						status.textContent = result.error;
						return;
					}
					send.disabled = true;
					status.textContent = 'Sending report.';
					const path = includePath.checked ? coarsePath() : '';
					request(bugEndpoint, {
						site_id: siteId,
						session_id: sessionId,
						visitor_id: sessionId,
						ts: Date.now(),
						kind: 'bug_report',
						url: doc.location.origin + '/',
						path,
						path_included: includePath.checked,
						referrer: '',
						title: '',
						replay_active: false,
						bug_report_token: token,
						bug_report: result.text
					}).then(response => {
						if (!response.ok) {
							throw Error('Report rejected');
						}
						status.className = 'status ok';
						status.textContent = 'Bug report sent.';
						form.hidden = true;
						button.hidden = false;
						button.disabled = true;
						button.textContent = 'Bug reported';
					}).catch(() => {
						send.disabled = false;
						status.textContent = 'Could not send the report. Try again.';
					});
				});
			};

		window.__snappyMailNotomoReporter = true;
		addEventListener('error', event => {
			const target = event.target,
				resource = target && target !== window && (target.src || target.href);
			report(resource ? 'resource_error' : 'error', {
				name: event.error?.name,
				source: resource || event.filename,
				lineno: event.lineno,
				colno: event.colno
			});
		}, true);
		addEventListener('unhandledrejection', event => report('unhandledrejection', {
			name: event.reason?.name
		}));
		doc.addEventListener('securitypolicyviolation', event => report('csp_violation', {
			source: event.sourceFile,
			lineno: event.lineNumber,
			colno: event.columnNumber
		}));
		const originalConsoleError = console.error;
		console.error = function () {
			report('console_error');
			return originalConsoleError.apply(this, arguments);
		};
		request(endpoint, {
			site_id: siteId,
			session_id: sessionId,
			visitor_id: sessionId,
			ts: Date.now(),
			kind: 'pageview',
			url: doc.location.origin + '/',
			path: '/webmail',
			referrer: '',
			title: '',
			replay_active: false,
			bug_report_enabled: true
		}).then(response => response.ok && installBugReportWidget(
			response.headers.get('X-Notomo-Bug-Report-Token')
		)).catch(() => {});
	};

try {
	let smctoken = doc.cookie.match(/(^|;) ?smctoken=([^;]+)/);
	smctoken = smctoken ? smctoken[2] : localStorage.getItem('smctoken');
	if (!smctoken) {
		let data = new Uint8Array(16);
		crypto.getRandomValues(data);
		smctoken = encodeURIComponent(btoa(String.fromCharCode(...data)));
	}
	localStorage.setItem('smctoken', smctoken);
	doc.cookie = 'smctoken='+smctoken+";path=/;samesite=strict";
} catch (e) {
	console.error(e);
}

let RL_APP_DATA = {},
	transportPingPromise = null,
	transportLastSuccess = 0,
	transportPingTimer = 0;

const
	wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
	retry = (request, attempts = 4) => request().catch(error =>
		1 < attempts ? wait(150).then(() => retry(request, attempts - 1)) : Promise.reject(error)
	),
	pollTransport = () => {
		const request = () => {
			const controller = new AbortController(),
				timeout = setTimeout(() => controller.abort(), 1000);
			return rl.fetch(transportPingUrl, {signal: controller.signal})
				.then(response => {
					if (!response.ok) {
						throw Error('Transport ping failed');
					}
					transportLastSuccess = Date.now();
				})
				.finally(() => clearTimeout(timeout));
		};

		return retry(request);
	},
	loadAppData = () => {
		const resource = qUri(`${admin ? 'Admin' : ''}AppData/0/${Math.random().toString().slice(2)}/`),
			request = () => {
				const controller = new AbortController(),
					timeout = setTimeout(() => controller.abort(), 2000);
				return rl.fetchJSON(resource, {signal: controller.signal})
					.finally(() => clearTimeout(timeout));
			};

		return retry(request);
	},
	ensureTransport = () => {
		if (transportLastSuccess && transportPingInterval > Date.now() - transportLastSuccess) {
			return Promise.resolve();
		}
		if (!transportPingPromise) {
			transportPingPromise = pollTransport().finally(() => transportPingPromise = null);
		}
		return transportPingPromise;
	},
	startTransportKeepAlive = () => {
		clearInterval(transportPingTimer);
		const tick = () => !doc.hidden && ensureTransport().catch(() => null);
		tick();
		transportPingTimer = setInterval(tick, transportPingInterval);
		doc.addEventListener('visibilitychange', tick);
	};

window.rl = {
	adminArea: () => admin,

	settings: {
		get: name => RL_APP_DATA[name],
		set: (name, value) => RL_APP_DATA[name] = value,
		app: name => RL_APP_DATA.System[name]
	},

	setTitle: title =>
		doc.title = (title || '') + (RL_APP_DATA.title ? (title ? ' - ' : '') + RL_APP_DATA.title : ''),

	setData: appData => {
		RL_APP_DATA = appData;
		rl.app.refresh();
	},

	loadScript: loadScript,

	ensureTransport: ensureTransport,

	fetch: (resource, init, postData) => {
		init = Object.assign({
			mode: 'same-origin',
			cache: 'no-cache',
			redirect: 'error',
			referrerPolicy: 'no-referrer',
			credentials: 'same-origin',
			headers: {}
		}, init);
		let asJSON = 1,
			XToken = (RL_APP_DATA.System || {}).token,
			object = {};
		if (postData) {
			init.method = 'POST';
			if (postData instanceof FormData) {
				postData.forEach((value, key) => {
					if (value instanceof File) {
						asJSON = 0;
					} else if (!Reflect.has(object, key)) {
						object[key] = value;
					} else {
						Array.isArray(object[key]) || (object[key] = [object[key]]);
						object[key].push(value);
					}
				});
				if (asJSON) {
					postData = object;
//					postData.XToken = XToken;
				} else {
					XToken && postData.set('XToken', XToken);
				}
			}
			if (asJSON) {
				init.headers['Content-Type'] = mimeJSON;
				postData = JSON.stringify(postData);
			}
			init.body = postData;
		}
		XToken && (init.headers['X-SM-Token'] = XToken);
//		init.headers = new Headers(init.headers);
		return fetch(resource, init);
	},

	fetchJSON: (resource, init, postData) => {
		init = Object.assign({ headers: {} }, init);
		init.headers.Accept = mimeJSON;
		return rl.fetch(resource, init, postData).then(response => {
			if (response.ok) {
				const ct = response.headers.get('Content-Type');
				if (!ct.startsWith(mimeJSON)) {
					return Promise.reject(new Error(`Invalid Content-Type '${ct}' for url '${resource}'`));
				}
				/* TODO: use this for non-developers?
				response.clone()
				let data = response.text();
				try {
					return JSON.parse(data);
				} catch (e) {
					console.error(e);
//					console.log(data);
					return Promise.reject(Notifications.JsonParse);
					return {
						Result: false,
						code: 952, // Notifications.JsonParse
						message: e.message,
						messageAdditional: data
					}
				}
				*/
				return response.json();
			}
			return Promise.reject(new Error('Network response error: ' + response.status));
		});
	}
};

if (!navigator.cookieEnabled) {
	toggle(eId('NoCookie'));
} else if (![].flat) {
	toggle(eId('BadBrowser'));
} else {
	ensureTransport()
		.then(loadAppData)
		.then(appData => {
			RL_APP_DATA = appData;
			installNotomoErrorReporter(appData);
			startTransportKeepAlive();
		const url = appData.StaticLibsJs,
			cb = () => rl.app.bootstart();
		loadScript(url)
			.then(() => loadScript(url.replace('/libs.', `/${admin?'admin':'app'}.`)))
			.then(() => appData.PluginsLink ? loadScript(qUri(appData.PluginsLink)) : Promise.resolve())
			.then(() => rl.app
				? cb()
				: doc.addEventListener('readystatechange', () => 'complete' == doc.readyState && cb())
			)
			.catch(e => {
				showError(e);
				throw e;
			});
	})
	.catch(e => showError(e));
}

})(document);
