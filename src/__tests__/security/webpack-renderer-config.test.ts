import { describe, expect, it } from 'vitest';
import { rendererConfig } from '../../../webpack.renderer.config';

function getRuleLoaderName(rule: unknown): string | undefined {
  if (!rule || typeof rule !== 'object') {
    return undefined;
  }

  const maybeRule = rule as {
    loader?: unknown;
    use?: unknown;
  };

  if (typeof maybeRule.loader === 'string') {
    return maybeRule.loader;
  }

  if (typeof maybeRule.use === 'string') {
    return maybeRule.use;
  }

  if (!maybeRule.use) {
    return undefined;
  }

  const uses = Array.isArray(maybeRule.use) ? maybeRule.use : [maybeRule.use];
  for (const use of uses) {
    if (typeof use === 'string') {
      return use;
    }

    if (use && typeof use === 'object' && 'loader' in use && typeof use.loader === 'string') {
      return use.loader;
    }
  }

  return undefined;
}

describe('renderer webpack config', () => {
  it('does not include node-only loaders that emit __dirname runtime usage', () => {
    const configuredRules = rendererConfig.module?.rules ?? [];
    const loaders = configuredRules
      .map((rule) => getRuleLoaderName(rule))
      .filter((loader): loader is string => typeof loader === 'string');

    expect(loaders).not.toContain('node-loader');
    expect(loaders).not.toContain('@vercel/webpack-asset-relocator-loader');
  });
});
