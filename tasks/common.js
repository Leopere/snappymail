/* RainLoop Webmail (c) RainLoop Team | Licensed under MIT */
const del = require('del');

const { config } = require('./config');

exports.del = (dir) => del(dir);

// JavaScript is rebuilt by tasks/js.js, which preserves the active minified bundle.
exports.cleanStatic = () => del(config.paths.staticCSS);
