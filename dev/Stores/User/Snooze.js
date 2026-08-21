import { getFolderInboxName } from 'Common/Cache';
import { showScreenPopup } from 'Knoin/Knoin';
import { FolderUserStore } from 'Stores/User/Folder';
import { MessagelistUserStore } from 'Stores/User/Messagelist';
import { SnoozePopupView } from 'View/Popup/Snooze';
import Remote from 'Remote/User/Fetch';

let initialized = false,
	processing = false;

const processDue = () => {
	if (processing) {
		return;
	}
	processing = true;
	Remote.request('SnoozeProcessDue', (error, data) => {
		processing = false;
		const result = data?.Result,
			restored = Array.isArray(result)
				? result.filter(item => ['restored', 'cancelled'].includes(item?.status)).length
				: Number(result?.restored || result?.Restored || 0);
		if (!error && restored && getFolderInboxName() === FolderUserStore.currentFolderFullName()) {
			MessagelistUserStore.reload(false, true);
		}
	}, {}, 60000);
};

export const initSnooze = () => {
	if (initialized) {
		return;
	}
	initialized = true;
	addEventListener('mailbox.message.snooze-request', event => {
		event.detail?.uid && showScreenPopup(SnoozePopupView, [event.detail]);
	});
	processDue();
	setInterval(processDue, 60000);
};
