export type MotionPreference = 'system' | 'off';
const MOTION_KEY = 'pdf.ui.motion';

export function readMotionPreference(): MotionPreference {
  try { return window.localStorage.getItem(MOTION_KEY) === 'off' ? 'off' : 'system'; }
  catch { return 'system'; }
}

export function writeMotionPreference(value: MotionPreference): void {
  try { window.localStorage.setItem(MOTION_KEY, value); }
  catch { /* The preference still applies for the current window. */ }
}
