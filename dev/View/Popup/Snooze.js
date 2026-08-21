import { addObservablesTo, addComputablesTo } from 'External/ko';
import { getNotification, i18n } from 'Common/Translator';
import { AbstractViewPopup } from 'Knoin/AbstractViews';
import { MessagelistUserStore } from 'Stores/User/Messagelist';
import { loadFolders } from 'Model/FolderCollection';
import Remote from 'Remote/User/Fetch';

const
	localDateTimeValue = date => {
		const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
		return local.toISOString().slice(0, 16);
	},
	tomorrowMorning = now => {
		const date = new Date(now);
		date.setDate(date.getDate() + 1);
		date.setHours(8, 0, 0, 0);
		return date;
	},
	nextWeek = now => {
		const date = new Date(now),
			days = (8 - date.getDay()) % 7 || 7;
		date.setDate(date.getDate() + days);
		date.setHours(8, 0, 0, 0);
		return date;
	};

export class SnoozePopupView extends AbstractViewPopup {
	constructor() {
		super('Snooze');

		addObservablesTo(this, {
			request: null,
			customWakeAt: '',
			saving: false,
			error: ''
		});

		addComputablesTo(this, {
			subject: () => this.request()?.message?.subject?.() || i18n('SNOOZE/CONVERSATION'),
			customValid: () => {
				const wakeAt = new Date(this.customWakeAt()).getTime();
				return !this.saving() && Number.isFinite(wakeAt) && wakeAt > Date.now() + 60000;
			}
		});
	}

	onShow(request) {
		const minimum = new Date(Date.now() + 5 * 60000);
		this.request(request || null);
		this.customWakeAt(localDateTimeValue(tomorrowMorning(minimum)));
		this.saving(false);
		this.error('');
	}

	chooseLaterToday() {
		const date = new Date(Date.now() + 3 * 3600000);
		date.setMinutes(0, 0, 0);
		this.submit(date);
	}

	chooseTomorrow() {
		this.submit(tomorrowMorning(new Date));
	}

	chooseNextWeek() {
		this.submit(nextWeek(new Date));
	}

	chooseCustom() {
		this.customValid() && this.submit(new Date(this.customWakeAt()));
	}

	submit(date) {
		const request = this.request(),
			wakeAt = Math.floor(date.getTime() / 1000);
		if (!request?.folder || !request.uid || !Number.isFinite(wakeAt) || wakeAt <= Date.now() / 1000) {
			this.error(i18n('SNOOZE/INVALID_TIME'));
			return;
		}

		this.saving(true);
		this.error('');
		Remote.request('SnoozeCreate', (error, data) => {
			this.saving(false);
			if (error) {
				this.error(data?.message || getNotification(error));
				return;
			}
			this.close();
			loadFolders(() => MessagelistUserStore.reload(false, true));
		}, {
			folder: request.folder,
			uid: request.uid,
			uids: Array.isArray(request.uids) ? request.uids.join(',') : '',
			wakeAt: wakeAt
		}, 60000);
	}
}
