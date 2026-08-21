import ko from 'ko';
import { SettingsGet } from 'Common/Globals';
import { koComputable, addObservablesTo, koArrayWithDestroy } from 'External/ko';
import Remote from 'Remote/User/Fetch';
import { Notifications } from 'Common/Enums';

export const ContactUserStore = koArrayWithDestroy();

ContactUserStore.loading = ko.observable(false).extend({ debounce: 200 });
ContactUserStore.importing = ko.observable(false).extend({ debounce: 200 });
ContactUserStore.syncing = ko.observable(false).extend({ debounce: 200 });

addObservablesTo(ContactUserStore, {
	allowSync: false, // Admin setting
	syncAuto: false,
	syncMode: 0,
	syncUrl: '',
	syncUser: '',
	syncPass: ''
});

let syncStartTimer = 0,
	syncIntervalTimer = 0;

// Also used by Selector
ContactUserStore.hasChecked = koComputable(
	// Issue: not all are observed?
	() => !!ContactUserStore.find(item => item.checked())
);

/**
 * @param {Function} fResultFunc
 * @returns {void}
 */
ContactUserStore.sync = fResultFunc => {
	if (ContactUserStore.syncMode()
	 && !ContactUserStore.importing()
	 && !ContactUserStore.syncing()
	) {
		ContactUserStore.syncing(true);
		Remote.streamPerLine(line => {
			try {
				line = JSON.parse(line);
				if ('ContactsSync' === line.Action) {
					fResultFunc?.(line.code, line);
				}
			} catch (e) {
				console.error(e);
				fResultFunc?.(Notifications.UnknownError);
			}
		}, 'ContactsSync', null, 9000)
			.catch(error => {
				console.warn('CardDAV sync did not finish', error);
				fResultFunc?.(Notifications.RequestTimeout);
			})
			.finally(() => ContactUserStore.syncing(false));
	}
};

ContactUserStore.applySyncConfig = config => {
	ContactUserStore.allowSync(!!config);
	if (config) {
		ContactUserStore.syncAuto(!!config.Auto);
		ContactUserStore.syncMode(Number(config.Mode) || 0);
		ContactUserStore.syncUrl(config.Url || '');
		ContactUserStore.syncUser(config.User || '');
		ContactUserStore.syncPass(config.Password || '');
	}
};

ContactUserStore.scheduleSync = config => {
	clearTimeout(syncStartTimer);
	clearInterval(syncIntervalTimer);
	if (ContactUserStore.syncMode()) {
		syncStartTimer = setTimeout(ContactUserStore.sync, 10000);
		syncIntervalTimer = setInterval(ContactUserStore.sync,
			Math.max(20, Number(config?.Interval) || 20) * 60000 + 5000
		);
	}
};

ContactUserStore.init = () => {
	const config = SettingsGet('ContactsSync');
	ContactUserStore.applySyncConfig(config);
	ContactUserStore.scheduleSync(config);

	if (config?.Auto && !config.Disabled && !ContactUserStore.syncMode()) {
		setTimeout(() => Remote.post('DiscoverContactsSync', null, {}, 5000)
			.then(response => {
				const discovered = response?.Result;
				if (discovered) {
					ContactUserStore.applySyncConfig(discovered);
					ContactUserStore.scheduleSync(discovered);
				}
			})
			.catch(() => false), 1000);
	}
};
