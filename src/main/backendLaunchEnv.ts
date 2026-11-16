/** A new Main-owned backend or read-only probe is an independent process.
 * Never inherit another PyInstaller bootloader's private process state.
 * Do not apply this to the bootloader's own parent/child launches.
 */
export function freshBackendEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...input };
  for (const key of Object.keys(result)) {
    // Windows environment names are case-insensitive. Normalize the filter
    // on every platform so even differently cased stale settings are removed.
    const name = key.toUpperCase();
    if (name.startsWith('_PYI_') || name === '_MEIPASS2' || name === 'PYINSTALLER_RESET_ENVIRONMENT') delete result[key];
  }
  result.PYINSTALLER_RESET_ENVIRONMENT = '1';
  return result;
}
