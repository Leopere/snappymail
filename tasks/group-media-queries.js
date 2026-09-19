/* RainLoop Webmail (c) RainLoop Team | Licensed under MIT */
// Groups top-level @media blocks by query and moves them behind the root rules,
// matching the ordering of the retired gulp-group-css-media-queries plugin:
// min-width only ascending, max-width only descending, then ranges and other
// queries in first-appearance order. Only postcss is required.
const { Transform } = require('node:stream');
const postcss = require('postcss');

const EM_TO_PX = 16;

const widthOf = (params, feature) => {
	const match = params.match(new RegExp(feature + ':\\s*(\\d+)(px|em)?'));
	if (!match) {
		return null;
	}
	return parseInt(match[1], 10) * ('em' === match[2] ? EM_TO_PX : 1);
};

const groupMediaQueries = css => {
	const root = postcss.parse(css);
	const groups = new Map();
	for (const node of [...root.nodes]) {
		if ('atrule' === node.type && 'media' === node.name.toLowerCase()) {
			const query = node.params;
			if (!groups.has(query)) {
				groups.set(query, {
					query,
					nodes: [],
					minWidth: widthOf(query, 'min-width'),
					maxWidth: widthOf(query, 'max-width')
				});
			}
			groups.get(query).nodes.push(...node.nodes);
			node.remove();
		}
	}
	const all = [...groups.values()];
	const onlyMin = all.filter(g => null !== g.minWidth && null === g.maxWidth)
		.sort((a, b) => a.minWidth - b.minWidth);
	const onlyMax = all.filter(g => null !== g.maxWidth && null === g.minWidth)
		.sort((a, b) => b.maxWidth - a.maxWidth);
	const ranges = all.filter(g => null !== g.minWidth && null !== g.maxWidth);
	const others = all.filter(g => null === g.minWidth && null === g.maxWidth);
	for (const group of [...onlyMin, ...onlyMax, ...ranges, ...others]) {
		root.append(postcss.atRule({ name: 'media', params: group.query, nodes: group.nodes }));
	}
	return root.toString();
};

const gulpGroupMediaQueries = () => new Transform({
	objectMode: true,
	transform(file, encoding, callback) {
		if (file.isNull()) {
			callback(null, file);
			return;
		}
		if (file.isStream()) {
			callback(new Error('group-media-queries: streaming is not supported'));
			return;
		}
		try {
			file.contents = Buffer.from(groupMediaQueries(file.contents.toString()));
			callback(null, file);
		} catch (error) {
			callback(error);
		}
	}
});

module.exports = { groupMediaQueries, gulpGroupMediaQueries };
