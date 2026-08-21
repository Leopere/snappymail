import { addObservablesTo } from 'External/ko';

import { OpenPGPUserStore } from 'Stores/User/OpenPGP';

import { AbstractViewPopup } from 'Knoin/AbstractViews';

import { SettingsGet } from 'Common/Globals';

export class OpenPgpGeneratePopupView extends AbstractViewPopup {
	constructor() {
		super('OpenPgpGenerate');

		addObservablesTo(this, {
			email: '',
			emailError: false,
			submitRequest: false,
			submitError: ''
		});

		this.email.subscribe(() => this.emailError(false));
	}

	async submitForm() {
		const email = IDN.toASCII(this.email().trim()).toLowerCase();
		this.emailError(!email || email !== IDN.toASCII(SettingsGet('Email') || '').toLowerCase());
		if (this.emailError()) {
			this.submitError('The encrypted vault must belong to the signed-in mailbox.');
			return;
		}
		this.submitRequest(true);
		this.submitError('');
		try {
			await OpenPGPUserStore.ensureVault();
			this.close();
		} catch (error) {
			this.submitError(error?.message || 'Unable to create the encrypted key vault.');
		} finally {
			this.submitRequest(false);
		}
	}

	hideError() {
		this.submitError('');
	}

	onShow() {
		this.email(SettingsGet('Email') || '');
		this.emailError(false);
		this.submitError('');
	}
}
