// This entry is compiled only by the explicitly named E2E package flavor.
// Normal packages compile src/index.ts directly and contain no test host.
process.env.PDF_E2E_PACKAGED = 'true';
require('./bootstrap.cjs');
require('../../src/index.ts');
