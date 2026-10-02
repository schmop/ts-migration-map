const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');
const madge = require('madge');
const ts = require('typescript');
// Must be the instance madge itself resolves imports with
const cabinet = require(require.resolve('filing-cabinet', {paths: [require.resolve('dependency-tree', {paths: [require.resolve('madge')]})]}));

if (process.argv.length < 3) {
	console.error('Usage: node index.js <projectRoot> [outputFile]');
	process.exit(1);
}

// Usage: node index.js <projectRoot> [outputFile]
// The output format follows the file extension (svg, png, pdf, dot, ...).
const root = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3] || 'graph.svg');

const JS_EXTENSIONS = ['js', 'jsx', 'mjs', 'cjs'];
const TS_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts'];

const KINDS = {
	jsBlocked: {label: 'JS with JS dependencies', fill: '#851c1f', font: '#ffffff'},
	jsReady: {label: 'JS without JS dependencies', fill: '#be7d1a', font: '#111111'},
	ts: {label: 'TS', fill: '#154272', font: '#ffffff'},
	other: {label: 'Other', fill: '#9e9e9e', font: '#111111'}
};

// Without this, extensionless imports in .mjs/.cjs files are not resolved
['.mjs', '.cjs'].forEach((ext) => cabinet.register(ext, cabinet.getLookup('.js')));

function extension(id) {
	return path.extname(id).replace('.', '');
}

function isJs(id) {
	return JS_EXTENSIONS.includes(extension(id));
}

function isTs(id) {
	return TS_EXTENSIONS.includes(extension(id));
}

function kindOf(id, dependencies) {
	if (isTs(id)) {
		return 'ts';
	}

	if (!isJs(id)) {
		return 'other';
	}

	return dependencies.some(isJs) ? 'jsBlocked' : 'jsReady';
}

/**
 * Compiler options used to resolve imports. "allowJs" is forced on, without it
 * imports from JS files to TS files are not resolved and the edges go missing.
 */
function compilerOptions() {
	const configPath = path.join(root, 'tsconfig.json');
	let options = {moduleResolution: ts.ModuleResolutionKind.Bundler};

	if (fs.existsSync(configPath)) {
		const host = Object.assign({}, ts.sys, {onUnRecoverableConfigFileDiagnostic: () => {}});
		const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);

		if (parsed) {
			options = parsed.options;
		}
	}

	return Object.assign({}, options, {allowJs: true});
}

/**
 * Keep this tool out of the graph if it lives inside the project.
 */
function excludeRegExp() {
	const self = path.relative(root, __dirname).split(path.sep).join('/');

	if (!self || self.startsWith('..')) {
		return false;
	}

	return [new RegExp('^' + self.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/')];
}

function quote(value) {
	return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function createDot(modules) {
	const kinds = {};
	const counts = {};

	Object.keys(modules).forEach((id) => {
		kinds[id] = kindOf(id, modules[id]);

		modules[id].forEach((depId) => {
			if (!modules[depId]) {
				kinds[depId] = kindOf(depId, []);
			}
		});
	});

	Object.values(kinds).forEach((kind) => {
		counts[kind] = (counts[kind] || 0) + 1;
	});

	const lines = [
		'digraph G {',
		'\tgraph [overlap=false, pad=0.3, rankdir=LR, bgcolor="#0c0023"];',
		'\tnode [fontname="Arial", fontsize=14, shape=box, style="rounded,filled", height=0];',
		'\tedge [color="#757575"];',
		'\tsubgraph cluster_legend {',
		'\t\tlabel="Legend"; fontname="Arial"; color="#757575";'
	];

	Object.keys(KINDS).filter((kind) => counts[kind]).forEach((kind) => {
		const {label, fill, font} = KINDS[kind];

		lines.push(`\t\t${quote('legend:' + kind)} [label=${quote(`${label} (${counts[kind]})`)}, color=${quote(fill)}, fillcolor=${quote(fill)}, fontcolor=${quote(font)}];`);
	});

	lines.push('\t}');

	Object.keys(kinds).sort().forEach((id) => {
		const {fill, font} = KINDS[kinds[id]];

		lines.push(`\t${quote(id)} [color=${quote(fill)}, fillcolor=${quote(fill)}, fontcolor=${quote(font)}];`);
	});

	Object.keys(modules).forEach((id) => {
		modules[id].forEach((depId) => {
			lines.push(`\t${quote(id)} -> ${quote(depId)};`);
		});
	});

	lines.push('}');

	return {dot: lines.join('\n') + '\n', counts};
}

function render(dot) {
	const format = extension(output) || 'svg';

	if (format === 'dot' || format === 'gv') {
		fs.writeFileSync(output, dot);
		return;
	}

	const result = spawnSync('dot', ['-T' + format, '-o', output], {input: dot, encoding: 'utf8'});

	if (result.error) {
		throw new Error(`Graphviz could not be run. Ensure that "dot" is in your $PATH. ${result.error}`);
	}

	if (result.status !== 0) {
		throw new Error(`Graphviz failed: ${result.stderr}`);
	}
}

madge(root, {
	baseDir: root,
	fileExtensions: JS_EXTENSIONS.concat(TS_EXTENSIONS),
	excludeRegExp: excludeRegExp(),
	tsConfig: {options: compilerOptions()}
})
	.then((res) => {
		const {dot, counts} = createDot(res.obj());
		const {skipped} = res.warnings();

		render(dot);

		Object.keys(KINDS).filter((kind) => counts[kind]).forEach((kind) => {
			console.log(`${String(counts[kind]).padStart(5)}  ${KINDS[kind].label}`);
		});

		if (skipped.length) {
			console.warn(`\n${skipped.length} imports could not be resolved and are missing from the graph:`);
			skipped.forEach((id) => console.warn(`  ${id}`));
		}

		console.log(`\nGraph written to ${output}`);
	})
	.catch((err) => {
		console.error(err.message);
		process.exit(1);
	});
