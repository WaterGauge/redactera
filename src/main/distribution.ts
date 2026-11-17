import path from 'node:path';

export type UpdateAuthority = 'github-manual' | 'system-managed';
export interface DistributionProfile {
  readonly userData: string;
  readonly sessionData: string;
  readonly fileSessions: string;
}

// Electron's read-only marker detects MSIX, not Store authenticity. This
// release supports desktop distribution only; never route MSIX to legacy data.
export function desktopDistribution(markers: { windowsStore: unknown; mas: unknown }):
  Readonly<{ channel: 'github'; updateAuthority: 'github-manual' }> | null {
  if ((markers.windowsStore !== undefined && markers.windowsStore !== false) ||
      (markers.mas !== undefined && markers.mas !== false)) return null;
  return Object.freeze({ channel: 'github', updateAuthority: 'github-manual' });
}

export function captureDesktopProfile(userData: string, sessionData: string): DistributionProfile {
  if (!path.isAbsolute(userData) || !path.isAbsolute(sessionData)) throw Error('Invalid desktop profile directory');
  // Preserve the existing Electron profile exactly, including E2E isolation.
  return Object.freeze({ userData, sessionData, fileSessions: path.join(userData, 'file-sessions') });
}

// Planning only. A future native adapter must obtain the package family and
// canonical LocalState directory from Windows, and verify path/ACL/reparse
// ownership before setting Electron paths or enabling Store execution.
// This function does not attest package identity or authorize filesystem IO.
export function planStoreProfile(input: {
  expectedFamily: string;
  nativeFamily: string;
  canonicalLocalState: string;
  legacyUserData: string;
  legacySessionData: string;
}): DistributionProfile {
  const { expectedFamily, nativeFamily, canonicalLocalState, legacyUserData, legacySessionData } = input;
  if (!/^[a-zA-Z0-9.-]{3,50}_[a-z0-9]{13}$/.test(expectedFamily) || expectedFamily !== nativeFamily) {
    throw Error('Unapproved package family');
  }
  const win = path.win32;
  const canonical = (value: string) => {
    if (!/^[a-zA-Z]:\\/.test(value) || win.normalize(value) !== value || value.endsWith('\\') ||
        value.slice(3).split('\\').some(part => !part || /[<>:"/|?*\x00-\x1f]/.test(part) || /[ .]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw Error('Invalid canonical profile directory');
    return value.toLowerCase();
  };
  const local = canonical(canonicalLocalState);
  if (win.basename(local) !== 'localstate' || win.basename(win.dirname(local)) !== expectedFamily.toLowerCase()) {
    throw Error('LocalState does not match the package family');
  }
  const userData = win.join(canonicalLocalState, 'Redactera');
  const root = canonical(userData);
  const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '\\') || b.startsWith(a + '\\');
  if ([legacyUserData, legacySessionData].some(value => overlaps(local, canonical(value)) || overlaps(root, canonical(value)))) {
    throw Error('Distribution profiles overlap');
  }
  return Object.freeze({ userData, sessionData: win.join(userData, 'chromium'), fileSessions: win.join(userData, 'file-sessions') });
}
