
import { ParseMime } from 'Mime/Parser';
import { AttachmentModel } from 'Model/Attachment';
import { FileInfo } from 'Common/File';
import { BEGIN_PGP_SIGNED_MESSAGE, PgpUserStore } from 'Stores/User/Pgp';

import { EmailModel } from 'Model/Email';

const resetCryptoState = (message, options) => {
	const
		pgpEncrypted = options.preservePgpEncrypted ? message.pgpEncrypted?.() : null,
		smimeEncrypted = options.preserveSmimeEncrypted ? message.smimeEncrypted?.() : null;

	message.pgpSigned?.(null);
	message.pgpEncrypted?.(pgpEncrypted);
	message.pgpDecrypted?.(false);
	message.smimeSigned?.(null);
	message.smimeEncrypted?.(smimeEncrypted);
	message.smimeDecrypted?.(false);
};

/**
 * @param string data
 * @param MessageModel message
 * @param {Object=} options
 */
export function MimeToMessage(data, message, options = {})
{
	resetCryptoState(message, options);

	const struct = ParseMime(data);
	if (struct.headers) {
		let html = struct.getByContentType('text/html'),
			subject = struct.headerValue('subject');
		html = html ? html.body : '';

		// Content-Type: ...; protected-headers="v1"
		subject && message.subject(subject);

		// EmailCollectionModel
		['from','to'].forEach(name => {
			const items = message[name];
			struct.headerValue(name)?.forEach(item => {
				item = new EmailModel(item.email, item.name);
				// Make them unique
				if (item.email && item.name || !items.find(address => address.email == item.email)) {
					items.push(item);
				}
			});
		});

		struct.forEach(part => {
			let cd = part.header('content-disposition'),
				cId = part.header('content-id'),
				type = part.header('content-type');
			if (cId || cd) {
				// if (cd && 'attachment' === cd.value) {
				let attachment = new AttachmentModel;
				attachment.mimeType = type.value;
				attachment.fileName = type.name || (cd && cd.params.filename) || '';
				attachment.fileNameExt = attachment.fileName.replace(/^.+(\.[a-z]+)$/, '$1');
				attachment.fileType = FileInfo.getType('', type.value);
				attachment.url = part.dataUrl;
				attachment.estimatedSize = part.body.length;
/*
				attachment.contentLocation = '';
				attachment.folder = '';
				attachment.uid = '';
				attachment.mimeIndex = part.id;
*/
				attachment.cId = cId ? cId.value : '';
				if (cId && html) {
					let cid = 'cid:' + attachment.contentId(),
						found = html.includes(cid);
					attachment.isInline(found);
					attachment.isLinked(found);
					found && (html = html
						.replace('src="' + cid + '"', 'src="' + attachment.url + '"')
						.replace("src='" + cid + "'", "src='" + attachment.url + "'")
					);
				} else {
					message.attachments.push(attachment);
				}
			} else if ('multipart/signed' === type.value) {
				let protocol = type.params.protocol;
				if ('application/pgp-signature' === protocol) {
					message.pgpSigned({
						detected: true,
						checked: false,
						checking: false,
						success: null,
						micAlg: type.micalg,
						bodyPart: part.parts[0],
						sigPart: part.parts[1]
					});
				} else if ('application/pkcs7-signature' === protocol.replace('x-')) {
					message.smimeSigned({
						micAlg: type.micalg,
						bodyPart: part,
						sigPart: part.parts[1], // For importing
						detached: true
					});
				}
			} else if ('application/pkcs7-mime' === type.value /*&& 'signed-data' === type.params['smime-type']=*/) {
				message.smimeSigned({
					micAlg: type.micalg,
					bodyPart: part,
					detached: false
				});
			}
		});

		const text = struct.getByContentType('text/plain');
		message.plain(text ? text.body : '');
		message.html(html);
	} else {
		message.plain(data);
	}

	if (message.plain().includes(BEGIN_PGP_SIGNED_MESSAGE)) {
		message.pgpSigned({
			detected: true,
			checked: false,
			checking: false,
			success: null
		});
	}
	if (PgpUserStore.isEncrypted(message.plain())) {
		message.pgpEncrypted(message.pgpEncrypted() || { partId: '', keyIds: [] });
	}
}
