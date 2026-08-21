/* RainLoop Webmail (c) RainLoop Team | Licensed under MIT */
const gulp = require('gulp');

const { config } = require('./config');
const { del } = require('./common');
const { ensureClassifierAssets } = require('../scripts/fetch-email-classifier-assets.cjs');

// fontastic
const fontasticFontsClear = () => del('snappymail/v/' + config.devVersion + '/static/css/fonts/snappymail.*');

const fontasticFontsCopy = () =>
	gulp
		.src('vendors/fontastic/fonts/snappymail.*', { encoding: false })
		.pipe(gulp.dest('snappymail/v/' + config.devVersion + '/static/css/fonts'));

const fontastic = gulp.series(fontasticFontsClear, fontasticFontsCopy);

const classifierDestination = 'snappymail/v/' + config.devVersion + '/static/classifier-v1';

const classifierClear = () => del([
	'snappymail/v/' + config.devVersion + '/static/classifier',
	classifierDestination
]);

const classifierAssets = async () => ensureClassifierAssets();

const classifierSourceCopy = () =>
	gulp
		.src([
			'vendors/email-classifier/email-classifier-v1.worker.js',
			'vendors/email-classifier/THIRD_PARTY_NOTICES.md',
			'vendors/email-classifier/licenses/**/*'
		], { base: 'vendors/email-classifier', encoding: false })
		.pipe(gulp.dest(classifierDestination));

const classifierDistCopy = () =>
	gulp
		.src('vendors/email-classifier/dist/**/*', {
			base: 'vendors/email-classifier/dist',
			encoding: false
		})
		.pipe(gulp.dest(classifierDestination));

const classifier = gulp.series(
	classifierClear,
	classifierAssets,
	gulp.parallel(classifierSourceCopy, classifierDistCopy)
);

exports.vendors = gulp.parallel(fontastic, classifier);
