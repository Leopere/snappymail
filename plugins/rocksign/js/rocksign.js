(rl => {
	if (!rl) {
		return;
	}

	const call = (action, parameters = {}) => new Promise((resolve, reject) => {
		rl.pluginRemoteRequest((error, response) => {
			const result = response?.Result || {};
			if (error || !result.success) {
				reject(new Error(result.error || 'RockSign request failed.'));
			} else {
				resolve(result);
			}
		}, action, parameters, 120000);
	});

	const escapeHtml = value => String(value || '').replace(/[&<>"']/g, character => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
	})[character]),
		emailAddress = value => {
			const input = String(value || '').trim(),
				bracketed = input.match(/<([^<>]+)>/);
			return String(bracketed?.[1] || input).trim().toLowerCase();
		};

	class RockSignPopupView extends rl.pluginPopupView {
		constructor() {
			super('RockSign');
			this.addObservables({
				mode: '',
				title: 'Contracts',
				busy: false,
				mutationBusy: false,
				loadingFiles: false,
				finished: false,
				error: '',
				notice: '',
				mailbox: '',
				selectedTemplateId: '',
				delivery: 'rocksign',
				confirmLocalDelivery: false,
				canUndoInvitation: false,
				messageSubject: '',
				messageBody: '',
				selectedTempName: '',
				reason: 'Certified through BoomPay RockSign',
				selectedSubmissionId: '',
				selectedFileKey: '',
				verification: null
			});
			this.templates = ko.observableArray();
			this.roles = ko.observableArray();
			this.pdfAttachments = ko.observableArray();
			this.submissions = ko.observableArray();
			this.files = ko.observableArray();
			this.openSequence = 0;
			this.runSequence = 0;
			this.fileLoadSequence = 0;
			this.invitationUndo = null;

			this.selectedTemplateId.subscribe(() => this.loadRoles());
			this.delivery.subscribe(value => 'snappymail' !== value && this.confirmLocalDelivery(false));
			this.selectedSubmissionId.subscribe(id => {
				const sequence = ++this.fileLoadSequence;
				this.files([]);
				this.selectedFileKey('');
				if (id && 'completed' === this.mode()) {
					this.loadFiles(id, sequence, this.openSequence);
				} else {
					this.loadingFiles(false);
				}
			});
		}

		beforeShow(mode, compose) {
			if (this.mutationBusy()) {
				this.error('Wait for the current RockSign operation to finish before opening another contract workflow.');
				return;
			}
			const sequence = ++this.openSequence;
			++this.runSequence;
			++this.fileLoadSequence;
			this.compose = compose;
			this.mode(mode);
			this.title({
				request: 'Request signatures',
				certify: 'Certify an attached PDF',
				completed: 'Attach a completed contract',
				verify: 'Verify an attached PDF'
			}[mode] || 'Contracts');
			this.busy(false);
			this.mutationBusy(false);
			this.loadingFiles(false);
			this.finished(false);
			this.error('');
			this.notice('');
			this.verification(null);
			this.templates([]);
			this.roles([]);
			this.submissions([]);
			this.files([]);
			this.selectedTemplateId('');
			this.selectedSubmissionId('');
			this.selectedFileKey('');
			this.delivery('rocksign');
			this.confirmLocalDelivery(false);
			this.canUndoInvitation(false);
			this.invitationUndo = null;
			this.messageSubject('');
			this.messageBody('');
			this.mailbox(String(rl.pluginSettingsGet('rocksign', 'mailbox') || '').toLowerCase());

			const attachments = compose.attachments()
				.filter(item => item?.complete() && item?.tempName() && /\.pdf$/i.test(item.fileName()))
				.map(item => ({ name: item.fileName(), tempName: item.tempName() }));
			this.pdfAttachments(attachments);
			this.selectedTempName(attachments[0]?.tempName || '');

			if ('request' === mode) {
				this.loadTemplates(sequence);
			} else if ('completed' === mode) {
				this.loadSubmissions(sequence);
			}
		}

		onClose() {
			if (this.mutationBusy()) {
				this.error('Wait for the current RockSign operation to finish before closing this dialog.');
				return false;
			}
		}

		onHide() {
			++this.openSequence;
			++this.runSequence;
			++this.fileLoadSequence;
		}

		loadTemplates(sequence) {
			this.run(() => call('RockSignTemplates').then(result => {
				if (sequence !== this.openSequence || 'request' !== this.mode()) {
					return;
				}
				this.templates(result.templates || []);
				this.selectedTemplateId(result.templates?.[0]?.id || '');
				if (!result.templates?.length) {
					this.notice('No allowed RockSign templates are available.');
				}
			}), false, sequence);
		}

		loadRoles() {
			const template = this.templates().find(item => String(item.id) === String(this.selectedTemplateId())),
				recipients = this.compose?.messageRecipients?.() || [];
			this.roles((template?.roles || []).map((role, index) => ({
				role: role.name,
				email: ko.observable(recipients[index] || ''),
				name: ko.observable('')
			})));
		}

		loadSubmissions(sequence) {
			this.run(() => call('RockSignCompletedSubmissions').then(result => {
				if (sequence !== this.openSequence || 'completed' !== this.mode()) {
					return;
				}
				const submissions = (result.submissions || []).map(item => ({
					...item,
					label: `${item.template_name} — #${item.id}${item.completed_at ? ` — ${item.completed_at}` : ''}`
				}));
				this.submissions(submissions);
				this.selectedSubmissionId(submissions[0]?.id || '');
				if (!submissions.length) {
					this.notice('No completed contracts owned by this mailbox were found.');
				}
			}), false, sequence);
		}

		loadFiles(submissionId, sequence, openSequence) {
			this.loadingFiles(true);
			call('RockSignSubmissionFiles', { submission_id: submissionId }).then(result => {
				if (openSequence !== this.openSequence || 'completed' !== this.mode()
					|| sequence !== this.fileLoadSequence
					|| String(submissionId) !== String(this.selectedSubmissionId())) {
					return;
				}
				this.files(result.files || []);
				this.selectedFileKey(result.files?.[0]?.key || '');
				if (!result.files?.length) {
					this.notice('The completed submission has no downloadable PDF files.');
				}
			}).catch(error => {
				if (openSequence === this.openSequence && 'completed' === this.mode()
					&& sequence === this.fileLoadSequence) {
					this.error(error.message || 'RockSign request failed.');
				}
			}).finally(() => {
				if (openSequence === this.openSequence && sequence === this.fileLoadSequence) {
					this.loadingFiles(false);
				}
			});
		}

		execute() {
			if (this.finished() || this.busy() || this.loadingFiles()) {
				return;
			}
			this.error('');
			this.notice('');
			this.verification(null);
			try {
				if ('request' === this.mode()) {
					this.requestSignatures();
				} else if ('certify' === this.mode()) {
					this.certifyPdf();
				} else if ('completed' === this.mode()) {
					this.attachCompleted();
				} else if ('verify' === this.mode()) {
					this.verifyPdf();
				}
			} catch (error) {
				this.error(error.message || 'RockSign request failed.');
			}
		}

		requestSignatures() {
			const submitters = this.roles().map(role => ({
				role: role.role,
				email: role.email(),
				name: role.name()
			}));
			this.validateRequest(submitters);
			const sequence = this.openSequence,
				compose = this.compose;
			this.run(() => call('RockSignCreateSubmission', {
				template_id: this.selectedTemplateId(),
				delivery: this.delivery(),
				subject: this.messageSubject(),
				body: this.messageBody(),
				submitters: JSON.stringify(submitters)
			}).then(result => {
				if (!this.operationCurrent(sequence, compose, 'request')) {
					return;
				}
				if (result.status_unknown) {
					this.finished(true);
					this.error('RockSign did not confirm the request. Its status is unknown; '
						+ 'check RockSign before trying again.');
					return;
				}
				if (!result.created) {
					throw new Error('RockSign did not confirm that the signing request was created.');
				}
				this.finished(true);
				if ('snappymail' === result.delivery) {
					if (result.link_error) {
						this.error(`${result.link_error} Submission #${result.submission_id} was created; do not retry it.`);
						return;
					}
					try {
						this.insertInvitation(result.links || [], compose);
					} catch (error) {
						this.error(`RockSign submission #${result.submission_id} was created, but its invitation `
							+ `could not be inserted. Do not retry it. ${error.message || ''}`.trim());
						return;
					}
					this.notice(`Signing links for submission #${result.submission_id} were inserted into this email.`);
				} else {
					this.notice(`RockSign sent signing request #${result.submission_id}.`);
				}
			}), true, sequence);
		}

		validateRequest(submitters) {
			if (!this.selectedTemplateId()) {
				throw new Error('Select an allowed RockSign template.');
			}
			if (this.mailbox() && emailAddress(this.compose?.from?.()) !== this.mailbox()) {
				throw new Error(`Select ${this.mailbox()} as the Compose From address before creating this request.`);
			}
			if ('snappymail' === this.delivery()) {
				if (1 !== submitters.length) {
					throw new Error('SnappyMail delivery requires a template with exactly one signer role.');
				}
				if (!this.compose?.oEditor || 'function' !== typeof this.compose.to
					|| 'function' !== typeof this.compose.cc || 'function' !== typeof this.compose.bcc) {
					throw new Error('The Compose editor is not ready to receive a private signing link.');
				}
				if (!this.confirmLocalDelivery()) {
					throw new Error('Confirm that this draft may replace its recipients and receive the private signing link.');
				}
			}
		}

		certifyPdf() {
			const originalTempName = this.selectedTempName(),
				original = this.pdfAttachments().find(item => item.tempName === originalTempName),
				sequence = this.openSequence,
				compose = this.compose;
			this.run(() => call('RockSignCertifyPdf', {
				temp_name: originalTempName,
				filename: original?.name || 'document.pdf',
				reason: this.reason()
			}).then(result => {
				if (!this.operationCurrent(sequence, compose, 'certify')) {
					return;
				}
				const attachment = result.attachment,
					model = compose.attachments().find(item => item?.tempName() === originalTempName);
				if (!attachment || !model) {
					throw new Error('The signed PDF could not replace the selected attachment.');
				}
				model.tempName(attachment.tempName);
				model.fileName(attachment.name);
				model.size(attachment.size);
				model.type(attachment.mimeType);
				model.error('');
				model.uploading(false);
				model.complete(true);
				this.verification(result.verification || null);
				this.notice(`Certified PDF attached as ${attachment.name}.`);
				compose.attachmentsArea();
				this.finished(true);
			}), true, sequence);
		}

		attachCompleted() {
			const sequence = this.openSequence,
				compose = this.compose;
			this.run(() => call('RockSignAttachCompletedPdf', {
				submission_id: this.selectedSubmissionId(),
				file_key: this.selectedFileKey()
			}).then(result => {
				if (!this.operationCurrent(sequence, compose, 'completed')) {
					return;
				}
				this.addAttachment(result.attachment, compose);
				this.verification(result.verification || null);
				this.notice(`Attached and verified ${result.attachment.name}.`);
				this.finished(true);
			}), true, sequence);
		}

		verifyPdf() {
			const sequence = this.openSequence,
				compose = this.compose;
			this.run(() => call('RockSignVerifyPdf', {
				temp_name: this.selectedTempName()
			}).then(result => {
				if (!this.operationCurrent(sequence, compose, 'verify')) {
					return;
				}
				this.verification(result.verification || {});
				this.notice(result.verification?.signed_by_instance
					? 'Verified by sign.boompay.ca.'
					: 'This PDF is not verified as signed by this RockSign instance.');
				this.finished(true);
			}), true, sequence);
		}

		operationCurrent(sequence, compose, mode) {
			return sequence === this.openSequence && compose === this.compose && mode === this.mode();
		}

		addAttachment(attachment, compose) {
			if (!attachment) {
				throw new Error('RockSign did not return an attachment.');
			}
			const model = compose.addAttachmentHelper(
				`rocksign-${Date.now()}-${Math.random().toString(16).slice(2)}`,
				attachment.name,
				attachment.size
			);
			model.tempName(attachment.tempName);
			model.type(attachment.mimeType);
			model.error('');
			model.uploading(false);
			model.complete(true);
			compose.attachmentsArea();
		}

		insertInvitation(links, compose) {
			const valid = links.filter(link => link.embed_src && link.email);
			if (1 !== valid.length) {
				throw new Error('RockSign did not return exactly one private signing link.');
			}
			const signer = valid[0];
			const editor = compose.oEditor;
			if (!editor) {
				throw new Error('The Compose editor is unavailable.');
			}
			const plain = editor.isPlain();
			this.invitationUndo = {
				compose,
				to: compose.to(),
				cc: compose.cc(),
				bcc: compose.bcc(),
				showCc: compose.showCc(),
				showBcc: compose.showBcc(),
				subject: compose.subject(),
				plain,
				body: editor.getData()
			};
			this.canUndoInvitation(true);
			compose.to(signer.email);
			compose.cc('');
			compose.bcc('');
			compose.showCc(false);
			compose.showBcc(false);

			if (plain) {
				const text = `${signer.role || 'Signer'}: ${signer.embed_src}`;
				editor.setPlain(`${editor.getData()}\n\n${text}`.trim());
			} else {
				const html = `<p><strong>${escapeHtml(signer.role || 'Signer')}:</strong> `
					+ `<a href="${escapeHtml(signer.embed_src)}">Review and sign the contract</a></p>`;
				editor.setHtml(`${editor.getData()}${html}`);
			}
			if (!compose.subject()) {
				const template = this.templates().find(item => String(item.id) === String(this.selectedTemplateId()));
				compose.subject(`Signature requested: ${template?.name || 'Contract'}`);
			}
			compose.bodyArea();
		}

		undoInvitation() {
			const previous = this.invitationUndo,
				compose = previous?.compose,
				editor = compose?.oEditor;
			if (!previous || !editor) {
				return;
			}
			compose.to(previous.to);
			compose.cc(previous.cc);
			compose.bcc(previous.bcc);
			compose.showCc(previous.showCc);
			compose.showBcc(previous.showBcc);
			compose.subject(previous.subject);
			if (previous.plain) {
				editor.setPlain(previous.body);
			} else {
				editor.setHtml(previous.body);
			}
			this.canUndoInvitation(false);
			this.error('');
			this.notice('The previous draft recipients and content were restored. The RockSign submission still exists.');
			compose.bodyArea();
		}

		run(work, mutation = false, sequence = this.openSequence) {
			if (this.busy() || this.loadingFiles()) {
				return;
			}
			const runSequence = ++this.runSequence;
			this.busy(true);
			this.mutationBusy(mutation);
			this.error('');
			Promise.resolve().then(work).catch(error => {
				if (sequence === this.openSequence) {
					this.error(error.message || 'RockSign request failed.');
				}
			}).finally(() => {
				if (runSequence === this.runSequence) {
					this.busy(false);
					this.mutationBusy(false);
				}
			});
		}
	}

	addEventListener('rl-view-model.create', event => {
		if ('PopupsCompose' === event.detail.viewModelTemplateID) {
			const view = event.detail;
			view.rockSignEnabled = !!rl.pluginSettingsGet('rocksign', 'enabled');
			view.rockSignOpen = mode => RockSignPopupView.showModal([mode, view]);
		}
	});

	const template = document.getElementById('PopupsCompose'),
		uploadButton = template?.content.querySelector('#composeUploadButton'),
		uploadGroup = uploadButton?.closest('.btn-group');
	if (uploadGroup) {
		uploadGroup.after(Element.fromHTML(`<div class="btn-group dropdown rocksign-contracts"
				data-bind="visible: rockSignEnabled, registerBootstrapDropdown: true">
				<a class="btn dropdown-toggle" href="#" aria-haspopup="true" data-i18n="ROCKSIGN/CONTRACTS">Contracts</a>
				<menu class="dropdown-menu right-edge" role="menu">
					<li role="presentation">
						<a href="#" role="menuitem" data-bind="click: () => rockSignOpen('request')"
							data-i18n="ROCKSIGN/REQUEST_SIGNATURES">Request signatures…</a>
					</li>
					<li role="presentation">
						<a href="#" role="menuitem" data-bind="click: () => rockSignOpen('certify')"
							data-i18n="ROCKSIGN/CERTIFY_PDF">Certify attached PDF…</a>
					</li>
					<li role="presentation">
						<a href="#" role="menuitem" data-bind="click: () => rockSignOpen('completed')"
							data-i18n="ROCKSIGN/ATTACH_COMPLETED">Attach completed contract…</a>
					</li>
					<li role="presentation">
						<a href="#" role="menuitem" data-bind="click: () => rockSignOpen('verify')"
							data-i18n="ROCKSIGN/VERIFY_PDF">Verify attached PDF…</a>
					</li>
				</menu>
		</div>`));
	}
})(window.rl);
