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

	trackLoginPage = appData => {
		const siteId = !admin && !appData.Auth && appData.Brand?.notomoSiteId;
		if (!siteId) {
			return;
		}

		const page = new URL(doc.location.href),
			pixel = new URL('https://notomo.colinknapp.com/n.gif'),
			params = page.searchParams,
			image = doc.createElement('img');
		pixel.searchParams.set('s', siteId);
		pixel.searchParams.set('u', page.origin + page.pathname);
		pixel.searchParams.set('p', page.pathname);
		pixel.searchParams.set('t', appData.title || '');
		pixel.searchParams.set('w', screen.width);
		pixel.searchParams.set('h', screen.height);
		['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(name => {
			const value = params.get(name);
			value && pixel.searchParams.set(name, value.slice(0, 200));
		});
		try {
			const referrer = new URL(doc.referrer);
			referrer.origin !== page.origin && pixel.searchParams.set('r', referrer.origin + '/');
		} catch (e) {
			// No usable external referrer.
		}

		image.alt = '';
		image.width = image.height = 1;
		image.hidden = true;
		image.referrerPolicy = 'no-referrer';
		image.addEventListener('load', () => image.remove(), {once: true});
		image.addEventListener('error', () => image.remove(), {once: true});
		image.src = pixel;
		doc.body.append(image);
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
			trackLoginPage(appData);
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
