import { koComputable } from 'External/ko';

import { SettingsCapa, SettingsGet } from 'Common/Globals';
import { i18n, translateTrigger, relativeTime } from 'Common/Translator';

import { AbstractViewSettings } from 'Knoin/AbstractViews';

import { SettingsUserStore } from 'Stores/User/Settings';

import { GnuPGUserStore } from 'Stores/User/GnuPG';
import { OpenPGPUserStore } from 'Stores/User/OpenPGP';

import { showScreenPopup } from 'Knoin/Knoin';

import { OpenPgpImportPopupView } from 'View/Popup/OpenPgpImport';
import { OpenPgpGeneratePopupView } from 'View/Popup/OpenPgpGenerate';

import { SMimeUserStore } from 'Stores/User/SMime';
import { SMimeImportPopupView } from 'View/Popup/SMimeImport';

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

		this.gnupgPublicKeys = GnuPGUserStore.publicKeys;
		this.gnupgPrivateKeys = GnuPGUserStore.privateKeys;

		this.openpgpkeysPublic = OpenPGPUserStore.publicKeys;
		this.openpgpkeysPrivate = OpenPGPUserStore.privateKeys;

		this.smimeCertificates = SMimeUserStore;

		this.canOpenPGP = SettingsCapa('OpenPGP');
		this.canGnuPG = GnuPGUserStore.isSupported();
		this.canMailvelope = !!window.mailvelope;

		this.openpgpPrivateCount = koComputable(() => this.openpgpkeysPrivate().length);
		this.openpgpPublicCount = koComputable(() => this.openpgpkeysPublic().length);
		this.gnupgPrivateCount = koComputable(() => this.gnupgPrivateKeys().length);
		this.gnupgPublicCount = koComputable(() => this.gnupgPublicKeys().length);
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

	addOpenPgpKey() {
		showScreenPopup(OpenPgpImportPopupView);
	}

	generateOpenPgpKey() {
		showScreenPopup(OpenPgpGeneratePopupView);
	}

	importToOpenPGP() {
		OpenPGPUserStore.loadBackupKeys();
	}

	importToSMime() {
		showScreenPopup(SMimeImportPopupView);
	}

	onBuild() {
		/**
		 * Create an iframe to display the Mailvelope keyring settings.
		 * The iframe will be injected into the container identified by selector.
		 */
		window.mailvelope && mailvelope.createSettingsContainer('#mailvelope-settings'/*[, keyring], options*/);
		/**
		 * https://github.com/the-djmaze/snappymail/issues/973
		Remote.request('GetStoredPGPKeys', (iError, data) => {
			console.dir([iError, data]);
		});
		*/
	}
}
