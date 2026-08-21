import { Notifications } from 'Common/Enums';
import { isArray, pInt, pString } from 'Common/Utils';
import { serverRequest } from 'Common/Links';
import { getNotification } from 'Common/Translator';

let iJsonErrorCount = 0;

const getURL = (add = '') => serverRequest('Json') + pString(add),

checkResponseError = data => {
	const err = data ? data.code : null;
	if (Notifications.InvalidToken === err) {
		console.error(getNotification(err) + ` (${data.messageAdditional})`);
//		alert(getNotification(err));
		setTimeout(rl.logoutReload, 500);
	} else if ([
			Notifications.AuthError,
			Notifications.ConnectionError,
			Notifications.DomainNotAllowed,
			Notifications.AccountNotAllowed,
			Notifications.MailServerError,
			Notifications.UnknownError
		].includes(err)
	) {
		if (7 < ++iJsonErrorCount) {
			rl.logoutReload();
		}
	}
},

oRequests = {},

abort = (sAction, sReason, bClearOnly) => {
	let controller = oRequests[sAction];
	oRequests[sAction] = null;
	if (controller) {
		clearTimeout(controller.timeoutId);
		bClearOnly || controller.abort(new DOMException(sAction, sReason || 'AbortError'));
	}
},

fetchJSON = (action, sUrl, params, timeout, jsonCallback) => {
	if (params) {
		if (params instanceof FormData) {
			params.set('Action', action);
		} else {
			params.Action = action;
		}
	}
	// Don't abort, read https://github.com/the-djmaze/snappymail/issues/487
//	abort(action, 0, 1);
	const controller = new AbortController(),
		signal = controller.signal,
		finish = () => {
			clearTimeout(controller.timeoutId);
			if (oRequests[action] === controller) {
				oRequests[action] = null;
			}
		};
	oRequests[action] = controller;
	// Currently there is no way to combine multiple signals, so AbortSignal.timeout() not possible
	controller.timeoutId = timeout && setTimeout(() => {
		if (oRequests[action] === controller) {
			oRequests[action] = null;
		}
		controller.abort(new DOMException(action, 'TimeoutError'));
	}, timeout);
	const request = () => rl.fetchJSON(sUrl, {signal: signal}, params);
	return (rl.ensureTransport ? rl.ensureTransport() : Promise.resolve()).then(request).then(data => {
		finish();
		return jsonCallback ? jsonCallback(data) : Promise.resolve(data);
	}).catch(err => {
		finish();
		err.aborted = signal.aborted;
		return Promise.reject(err);
	});
};

class FetchError extends Error
{
	constructor(code, message) {
		super(message);
		this.code = code || Notifications.JsonFalse;
	}
}

export class AbstractFetchRemote
{
	abort(sAction, sReason) {
		abort(sAction, sReason);
		return this;
	}

	/**
	 * Allows quicker visual responses to the user.
	 * Can be used to stream lines of json encoded data, but does not work on all servers.
	 * Apache needs 'flushpackets' like in <Proxy "fcgi://...." flushpackets=on></Proxy>
	 */
	streamPerLine(fCallback, sGetAdd, postData, timeout = 10000) {
		const controller = new AbortController(),
			timeoutId = setTimeout(() => controller.abort(new DOMException(sGetAdd, 'TimeoutError')), timeout),
			read = async () => {
				const response = await rl.fetch(getURL(sGetAdd), {signal: controller.signal}, postData);
				if (!response.ok || !response.body) {
					throw Error('Streaming request failed');
				}
				const reader = response.body.getReader(),
					re = /\r\n|\n|\r/gm,
					utf8decoder = new TextDecoder();
				let buffer = '';
				for (;;) {
					const {done, value} = await reader.read();
					buffer += value ? utf8decoder.decode(value, {stream: !done}) : '';
					for (;;) {
						const result = re.exec(buffer);
						if (!result) {
							break;
						}
						fCallback(buffer.slice(0, result.index));
						buffer = buffer.slice(result.index + result[0].length);
						re.lastIndex = 0;
					}
					if (done) {
						buffer.length && fCallback(buffer);
						return;
					}
				}
			};

		return (rl.ensureTransport ? rl.ensureTransport() : Promise.resolve())
			.then(read)
			.finally(() => clearTimeout(timeoutId));
	}

	/**
	 * @param {?Function} fCallback
	 * @param {string} sAction
	 * @param {Object=} oParameters
	 * @param {?number=} iTimeout
	 * @param {string=} sGetAdd = ''
	 */
	request(sAction, fCallback, params, iTimeout, sGetAdd) {
		params = params || {};

		const start = Date.now();

		fetchJSON(sAction, getURL(sGetAdd),
			sGetAdd ? null : (params || {}),
			pInt(iTimeout ?? 10000),
			async data => {
				let iError = 0;
				if (data) {
/*
					if (sAction !== data.Action) {
						console.log(sAction + ' !== ' + data.Action);
					}
*/
					if (data.Result) {
						iJsonErrorCount = 0;
					} else {
						checkResponseError(data);
						iError = data.code || Notifications.UnknownError
					}
				}

				if (111 === iError && rl.app.ask && await rl.app.ask.cryptkey()) {
					return this.request(sAction, fCallback, params, iTimeout, sGetAdd);
				}

				fCallback && fCallback(
					iError,
					data,
					/**
					 * Responses like "304 Not Modified" are returned as "200 OK"
					 * This is an attempt to detect if the request comes from cache.
					 * But when client has wrong date/time, it will fail.
					 */
					data?.epoch && data.epoch < Math.floor(start / 1000) - 60
				);
			}
		)
		.catch(err => {
			console.error({fetchError:err});
			fCallback && fCallback(
				'TimeoutError' == err.name ? 3 : (err.name == 'AbortError' ? 2 : 1),
				err
			);
		});
	}

	setTrigger(trigger, value) {
		if (trigger) {
			value = !!value;
			(isArray(trigger) ? trigger : [trigger]).forEach(fTrigger => {
				fTrigger?.(value);
			});
		}
	}

	get(action, url) {
		return fetchJSON(action, url);
	}

	post(action, fTrigger, params, timeOut) {
		this.setTrigger(fTrigger, true);
		return fetchJSON(action, getURL(), params || {}, pInt(timeOut, 10000),
			async data => {
				if (!data) {
					return Promise.reject(new FetchError(Notifications.JsonParse));
				}

				if (111 === data?.code && rl.app.ask && await rl.app.ask.cryptkey()) {
					return this.post(action, fTrigger, params, timeOut);
				}
/*
				let isCached = false, type = '';
				if (data?.epoch) {
					isCached = data.epoch > microtime() - start;
				}
				// backward capability
				switch (true) {
					case 'success' === textStatus && data?.Result && action === data.Action:
						type = AbstractFetchRemote.SUCCESS;
						break;
					case 'abort' === textStatus && (!data || !data.__aborted__):
						type = AbstractFetchRemote.ABORT;
						break;
					default:
						type = AbstractFetchRemote.ERROR;
						break;
				}
*/
				this.setTrigger(fTrigger, false);

				if (!data.Result || action !== data.Action) {
					checkResponseError(data);
					return Promise.reject(new FetchError(
						data ? data.code : 0,
						data ? (data.messageAdditional || data.message) : ''
					));
				}

				return data;
			}
		).catch(error => {
			this.setTrigger(fTrigger, false);
			throw error;
		});
	}
}

Object.assign(AbstractFetchRemote.prototype, {
	SUCCESS : 0,
	ERROR : 1,
	ABORT : 2
});
