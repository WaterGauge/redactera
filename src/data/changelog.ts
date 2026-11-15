// Webpack and Vite load the Markdown source as a string.
// eslint-disable-next-line import/no-unresolved
import markdown from '../../CHANGELOG.md?raw';
import pkg from '../../package.json';

export interface ChangelogEntry {
  version: string;
  publishedAt: string;
  summary: string;
}

const entries: ChangelogEntry[] = [];
let current: ChangelogEntry | undefined;
for (const line of markdown.split(/\r?\n/)) {
  const heading = line.match(/^#{2,3}\s+(Unreleased|v?\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)(?:\s|$)/i);
  if (heading) {
    current = { version: heading[1] === 'Unreleased' ? 'v' + pkg.version : heading[1],
      publishedAt: '', summary: '' };
    entries.push(current);
  } else if (/^##\s/.test(line)) {
    current = undefined;
  } else if (current && line.trim() && !line.startsWith('#')) {
    const text = line.replace(/^-\s+/, '').trim();
    current.summary += (current.summary ? '\n' : '') + text;
  }
}

export const changelogEntries = entries;
