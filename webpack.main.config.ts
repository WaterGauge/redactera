import type { Configuration } from 'webpack';
import { DefinePlugin } from 'webpack';

import { rules } from './webpack.rules';
import { plugins } from './webpack.plugins';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { contract } = require('./scripts/backend-contract.cjs') as { contract(root: string): { sourceSha256: string } };
export const backendSourceSha256 = contract(__dirname).sourceSha256;

export const mainConfig: Configuration = {
  /**
   * This is the main entry point for your application, it's the first file
   * that runs in the main process.
   */
  entry: process.env.PDF_E2E_BUILD === 'true' ? './e2e/support/packaged-entry.cjs' : './src/index.ts',
  // Put your normal webpack config below here
  module: {
    rules,
  },
  plugins: [...plugins, new DefinePlugin({ __BACKEND_SOURCE_SHA256__: JSON.stringify(backendSourceSha256) })],
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
  },
};
