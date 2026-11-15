import type { Configuration } from 'webpack';
import { DefinePlugin } from 'webpack';

import { rules } from './webpack.rules';
import { plugins } from './webpack.plugins';
import { PdfAssetsPlugin } from './webpack.pdf-assets';

const NODE_ONLY_LOADERS = new Set([
  'node-loader',
  '@vercel/webpack-asset-relocator-loader',
]);

function extractLoaderNames(rule: unknown): string[] {
  if (!rule || typeof rule !== 'object') {
    return [];
  }

  const typedRule = rule as { loader?: unknown; use?: unknown };
  const loaderNames: string[] = [];

  if (typeof typedRule.loader === 'string') {
    loaderNames.push(typedRule.loader);
  }

  const uses = typedRule.use
    ? (Array.isArray(typedRule.use) ? typedRule.use : [typedRule.use])
    : [];

  for (const use of uses) {
    if (typeof use === 'string') {
      loaderNames.push(use);
    } else if (use && typeof use === 'object' && 'loader' in use && typeof use.loader === 'string') {
      loaderNames.push(use.loader);
    }
  }

  return loaderNames;
}

const rendererRules = rules.filter((rule) =>
  extractLoaderNames(rule).every((loaderName) => !NODE_ONLY_LOADERS.has(loaderName))
);

rendererRules.push({
  test: /\.css$/,
  use: [{ loader: 'style-loader' }, { loader: 'css-loader' }],
});

export const rendererConfig: Configuration = {
  module: {
    rules: rendererRules,
  },
  plugins: [
    ...plugins,
    // Resolve module URLs in the browser without embedding PDF.js's build path.
    new DefinePlugin({ 'import.meta.url': 'document.baseURI' }),
    new PdfAssetsPlugin(),
  ],
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'],
  },
};
