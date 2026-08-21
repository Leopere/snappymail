(rl => {
	if (!rl) {
		return;
	}

	addEventListener('rl-view-model.create', event => {
		if ('PopupsPlugin' !== event.detail.viewModelTemplateID) {
			return;
		}
		const view = event.detail;
		view.rockSignTestVisible = () => 'rocksign' === String(view.id()).toLowerCase();
		view.rockSignTesting = ko.observable(false);
		view.rockSignTestResult = ko.observable('');
		view.id.subscribe(() => view.rockSignTestResult(''));
		view.rockSignTestConnection = () => {
			if (view.rockSignTesting()) {
				return;
			}
			view.rockSignTesting(true);
			view.rockSignTestResult('');
			rl.pluginRemoteRequest((error, response) => {
				view.rockSignTesting(false);
				const result = response?.Result || {};
				view.rockSignTestResult(error || !result.success
					? result.error || 'Connection failed.'
					: `Connected as ${result.user?.email || 'RockSign user'}.`);
			}, 'RockSignTestConnection');
		};
	});

	const template = document.getElementById('PopupsPlugin'),
		form = template?.content.querySelector('.plugin-form');
	form?.insertAdjacentHTML('beforeend', `<div class="control-group rocksign-admin-test"
		data-bind="visible: rockSignTestVisible()">
		<label>Connection</label>
		<div class="controls">
			<button type="button" class="btn" data-bind="click: rockSignTestConnection, disable: rockSignTesting">
				<i aria-hidden="true" data-bind="css: {'icon-spinner': rockSignTesting}"></i>
				Test saved connection
			</button>
			<div class="help-block" role="status" aria-live="polite" data-bind="text: rockSignTestResult"></div>
		</div>
	</div>`);
})(window.rl);
