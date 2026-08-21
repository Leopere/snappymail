import { koComputable } from 'External/ko';

import { SettingsGet } from 'Common/Globals';
import { translateTrigger, relativeTime } from 'Common/Translator';

import { AbstractViewSettings } from 'Knoin/AbstractViews';

import { SettingsUserStore } from 'Stores/User/Settings';
import { OpenPGPUserStore } from 'Stores/User/OpenPGP';

export class UserSettingsSecurity extends AbstractViewSettings {
	constructor() {
		super();

		this.autoLogout = SettingsUserStore.autoLogout;
		this.autoLogoutDisabled = SettingsUserStore.autoLogoutDisabled;
		this.autoLogoutEnabled = koComputable(() => !this.autoLogoutDisabled());
		this.autoLogoutOptions = koComputable(() => {
			translateTrigger();
			return [
				{ id: 5, name: relativeTime(300) },
				{ id: 15, name: relativeTime(900) },
				{ id: 30, name: relativeTime(1800) },
				{ id: 60, name: relativeTime(3600) },
				{ id: 120, name: relativeTime(7200) },
				{ id: 240, name: relativeTime(14400) },
				{ id: 480, name: relativeTime(28800) },
				{ id: 720, name: relativeTime(43200) },
				{ id: 1440, name: relativeTime(86400) }
			];
		});
		this.addSetting('AutoLogout');
		this.addSetting('AutoLogoutDisabled');

		this.vaultState = OpenPGPUserStore.vaultState;
		this.vaultError = OpenPGPUserStore.vaultError;
		this.encryptionEmail = koComputable(() => SettingsGet('Email') || '');
		this.encryptionStatus = koComputable(() => ({
			ready: 'Unlocked',
			locked: 'Locked',
			missing: 'Setup required',
			quarantined: 'Recovery required',
			error: 'Unavailable',
			unavailable: 'Unavailable'
		}[this.vaultState()] || 'Unavailable'));
		this.encryptionSummary = koComputable(() => {
			const email = this.encryptionEmail(), state = this.vaultState();
			if ('ready' === state || 'locked' === state) {
				return `${email}${email ? ' - ' : ''}browser-encrypted private key vault`;
			}
			if ('quarantined' === state) {
				return this.vaultError() || `${email} public key withdrawn`;
			}
			return email || this.encryptionStatus();
		});
		this.encryptionStatusClass = koComputable(() => ({
			ready: 'ready' === this.vaultState(),
			pending: ['locked', 'missing'].includes(this.vaultState()),
			unavailable: ['error', 'quarantined', 'unavailable'].includes(this.vaultState())
		}));
	}
}
