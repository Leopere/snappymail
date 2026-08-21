import { AskPopupView } from 'View/Popup/Ask';

let values = new WeakMap();

export const Passphrases = {
	has: key => values.has(key),
	get: key => values.get(key),
	set: (key, value) => {
		values.set(key, value);
		return Passphrases;
	},
	delete: key => values.delete(key),
	clearAll: () => {
		values = new WeakMap();
	},
	// Session logout is the sole expiry boundary for remembered private-key material.
	handle: (key, pass) => {
		pass && Passphrases.set(key, pass);
		return Passphrases.get(key);
	},
	ask: async (key, sAskDesc, btnText) =>
		Passphrases.has(key)
			? {password:Passphrases.handle(key)/*, remember:false*/}
			: await AskPopupView.password(sAskDesc, btnText, 5)
};
