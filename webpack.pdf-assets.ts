import fs from 'node:fs';
import path from 'node:path';
import type { Compiler } from 'webpack';

// Keep the API, parser worker, CMaps, standard fonts and image decoders from
// one pinned package. These resources must also work without a network.
export class PdfAssetsPlugin {
  apply(compiler: Compiler): void {
    compiler.hooks.thisCompilation.tap('PdfAssetsPlugin', compilation => {
      compilation.hooks.processAssets.tap({ name: 'PdfAssetsPlugin', stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL }, () => {
        const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
        const emit = (source: string, target: string) => {
          compilation.emitAsset(`main_window/pdf-assets/${target}`, new compiler.webpack.sources.RawSource(fs.readFileSync(source)));
        };
        emit(path.join(root, 'legacy/build/pdf.worker.min.mjs'), 'pdf.worker.mjs');
        for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
          for (const file of fs.readdirSync(path.join(root, directory))) {
            const source = path.join(root, directory, file);
            if (fs.statSync(source).isFile()) emit(source, `${directory}/${file}`);
          }
        }
      });
    });
  }
}
