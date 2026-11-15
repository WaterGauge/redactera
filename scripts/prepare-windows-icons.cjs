// Squirrel embeds its bootstrapper. Brand the assembled unsigned Setup before any signing.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
function executableIdentity(executable) {
  const sections = executable.getAllSections()
    .filter(section => section.info.name !== '.rsrc' && section.data)
    .map(section => ({ name: section.info.name, sha256: hash(section.data) }));
  const { fileHeader, optionalHeader } = executable.newHeader;
  return { machine: fileHeader.machine, entryPoint: optionalHeader.addressOfEntryPoint, sections };
}
function nonIconResources(resources) {
  return resources.entries.filter(entry => entry.type !== 3 && entry.type !== 14)
    .map(entry => ({ type: entry.type, id: entry.id, lang: entry.lang, sha256: hash(entry.bin) }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
}
async function prepareWindowsInstallerIcons(file, iconFile) {
  const { NtExecutable, NtExecutableResource, Resource, Data } = await import('resedit');
  const original = fs.readFileSync(file), ico = fs.readFileSync(iconFile);
  // pe-library refuses a PE security directory by default. Never invalidate an
  // Authenticode signature: introduce signing after this hook if it is configured.
  let executable;
  try { executable = NtExecutable.from(original); }
  catch { throw Error('Installer icon preparation requires an unsigned PE; sign after icon preparation.'); }
  const resources = NtExecutableResource.from(executable);
  const codeBefore = executableIdentity(executable), otherBefore = nonIconResources(resources);
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  if (!groups.length) throw Error('Squirrel Setup has no native icon groups');
  const iconItems = Data.IconFile.from(ico).icons.map(item => item.data);
  for (const group of groups) Resource.IconGroupEntry.replaceIconsForResource(resources.entries,
    group.id, group.lang, iconItems);
  resources.outputResource(executable);
  const bytes = Buffer.from(executable.generate());
  const checked = NtExecutable.from(bytes);
  const after = NtExecutableResource.from(checked);
  if (JSON.stringify(executableIdentity(checked)) !== JSON.stringify(codeBefore) ||
      JSON.stringify(nonIconResources(after)) !== JSON.stringify(otherBefore)) {
    throw Error('Installer icon preparation changed code or non-icon resources');
  }
  const expected = iconItems.map(item => hash(item.isRaw() ? item.bin : item.generate())).sort();
  const finalGroups = Resource.IconGroupEntry.fromEntries(after.entries);
  if (finalGroups.length !== groups.length) throw Error('Installer icon preparation lost native groups');
  for (const group of finalGroups) {
    const actual = group.icons.map(icon => {
      const entry = after.entries.find(item => item.type === 3 && item.id === icon.iconID && item.lang === group.lang);
      return entry ? hash(entry.bin) : '';
    }).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Installer icon preparation left an unmatched group');
  }
  if (hash(fs.readFileSync(file)) !== hash(original)) throw Error('Installer changed during icon preparation');
  const temporary = path.join(path.dirname(file), '.redactera-icons-' + crypto.randomUUID() + '.exe');
  try { fs.writeFileSync(temporary, bytes, { flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
  return { artifact: path.basename(file), iconSha256: hash(ico), originalSha256: hash(original),
    preparedSha256: hash(bytes), executableIdentity: codeBefore,
    nonIconResourcesPreserved: true, unsignedInput: true,
    groups: finalGroups.map(group => ({ id: group.id, lang: group.lang, frames: group.icons.length })) };
}
module.exports = { prepareWindowsInstallerIcons, executableIdentity };
