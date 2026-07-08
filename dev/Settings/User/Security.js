import { koComputable } from 'External/ko';

import { SettingsGet } from 'Common/Globals';
import { i18n, translateTrigger, relativeTime } from 'Common/Translator';

import { AbstractViewSettings } from 'Knoin/AbstractViews';

import { SettingsUserStore } from 'Stores/User/Settings';

import { GnuPGUserStore } from 'Stores/User/GnuPG';

export class UserSettingsSecurity extends AbstractViewSettings {
	constructor() {
		super();

		this.autoLogout = SettingsUserStore.autoLogout;
		this.autoLogoutOptions = koComputable(() => {
			translateTrigger();
			return [
				{ id: 0, name: i18n('SETTINGS_SECURITY/NEVER') },
				{ id: 5, name: relativeTime(300) },
				{ id: 15, name: relativeTime(900) },
				{ id: 30, name: relativeTime(1800) },
				{ id: 60, name: relativeTime(3600) },
				{ id: 120, name: relativeTime(7200) },
				{ id: 300, name: relativeTime(18000) },
				{ id: 600, name: relativeTime(36000) }
			];
		});
		this.addSetting('AutoLogout');

		this.keyPassForget = SettingsUserStore.keyPassForget;
		this.addSetting('keyPassForget');

			this.gnupgPrivateKeys = GnuPGUserStore.privateKeys;

			this.canGnuPG = GnuPGUserStore.isSupported();

			this.gnupgPrivateCount = koComputable(() => this.gnupgPrivateKeys().length);
			this.encryptionReady = koComputable(() => !!this.gnupgPrivateCount());
		this.encryptionEmail = koComputable(() => {
			const key = this.gnupgPrivateKeys()[0];
			return key?.emails?.[0] || SettingsGet('Email') || '';
		});
		this.encryptionStatus = koComputable(() =>
			this.encryptionReady()
				? 'Ready'
				: (this.canGnuPG ? 'Setting up' : 'Unavailable')
		);
		this.encryptionSummary = koComputable(() => {
			const count = this.gnupgPrivateCount(),
				email = this.encryptionEmail();
			return this.encryptionReady()
				? `${email}${email ? ' - ' : ''}${count} server GPG private key${1 === count ? '' : 's'}`
				: (email || this.encryptionStatus());
		});
		this.encryptionStatusClass = koComputable(() => ({
			ready: this.encryptionReady(),
			pending: !this.encryptionReady() && this.canGnuPG,
				unavailable: !this.encryptionReady() && !this.canGnuPG
			}));
		}
	}
