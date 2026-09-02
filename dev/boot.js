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
			nativeFetch(endpoint, {
				method: 'POST',
				mode: 'cors',
				credentials: 'omit',
				referrerPolicy: 'no-referrer',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({
					site_id: siteId,
					session_id: sessionId,
					visitor_id: sessionId,
					ts: now,
					kind: 'error',
					event_name: eventName,
					event_data: eventData
				}),
				keepalive: true
			}).catch(() => {});
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
