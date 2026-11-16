import { describe, expect, it } from 'vitest';
import { freshBackendEnvironment } from './backendLaunchEnv';

describe('new backend launch environment', () => {
  it('clears only inherited PyInstaller process state, including Windows case aliases', () => {
    const original = { _PYI_ARCHIVE_FILE: 'old', _pyi_application_home_dir: 'old', _MEIPASS2: 'old',
      _PyI_Parent_Process_Level: 'old', pyinstaller_reset_environment: '0',
      PYINSTALLER_RESET_ENVIRONMENT: '0', PATH: 'path', TEMP: 'owned', PDF_DESENSITIZATION_SESSION: 'synthetic',
      PDF_DESENSITIZATION_GENERATION: 'new', HTTPS_PROXY: 'synthetic-proxy' };
    expect(freshBackendEnvironment(original)).toEqual({ PATH: 'path', TEMP: 'owned',
      PDF_DESENSITIZATION_SESSION: 'synthetic', PDF_DESENSITIZATION_GENERATION: 'new',
      HTTPS_PROXY: 'synthetic-proxy', PYINSTALLER_RESET_ENVIRONMENT: '1' });
    expect(original._PYI_ARCHIVE_FILE).toBe('old');
  });
  it('marks every new launch independent without requiring inherited state', () => {
    expect(freshBackendEnvironment({})).toEqual({ PYINSTALLER_RESET_ENVIRONMENT: '1' });
  });
});
