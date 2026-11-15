const fs = require('node:fs');
const path = require('node:path');
const webpack = require('webpack');
const ts = require('typescript');
const { pathToFileURL } = require('node:url');

module.exports = async function build(root, output) {
  process.env.PDF_E2E_BUILD = 'false';
  process.env.ELECTRON_ENABLE_NODE_CLI_INSPECT_ARGUMENTS = 'false';
  require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, file);
  const forge = require(path.join(root, 'forge.config.ts')).default;
  const plugin = forge.plugins.find(item => item.constructor.name === 'WebpackPlugin');
  if (!plugin) throw Error('Production Webpack plugin not found');
  // Forge 8 exports only the plugin entry. Its locked production generator
  // remains adjacent to that entry, and is now an ES module.
  const generatorFile = path.join(path.dirname(require.resolve('@electron-forge/plugin-webpack')), 'WebpackConfig.js');
  const { default: Generator } = await import(pathToFileURL(generatorFile).href);
  const generator = new Generator(plugin.config, root, true, 0);
  generator.webpackDir = output;
  const configs = [await generator.getMainConfig(), ...await generator.getRendererConfig(plugin.config.renderer)];
  await new Promise((resolve, reject) => {
    const compiler = webpack(configs);
    compiler.run((error, stats) => {
      if (stats) console.log(stats.toString({ all: false, errors: true, warnings: true, timings: true }));
      compiler.close(closeError => error || closeError || !stats || stats.hasErrors()
        ? reject(error || closeError || Error('Production build failed')) : resolve());
    });
  });
};
