#!/usr/bin/env node
// resolve-profile.cjs — Map a profile email/alias or "ask" → Chrome profile directory name.
//
// Usage:
//   node resolve-profile.cjs <user_data_dir> <email|ask|list>
//
// Examples:
//   node resolve-profile.cjs ~/.config/cdp-sniffer-chrome andreictg338@gmail.com  → "Profile 1"
//   node resolve-profile.cjs ~/.config/cdp-sniffer-chrome list                    → all profiles
//   node resolve-profile.cjs ~/.config/cdp-sniffer-chrome ask                     → "Guest Profile"
//
// Reads <user_data_dir>/Local State → profile.info_cache. Emails are looked up
// case-insensitively. Prints the profile directory name to stdout; exit 0 on
// success, 1 when the profile is not found (lists available ones to stderr).

const { readFileSync, existsSync } = require('fs');
const path = require('path');

const [userDataDir, target] = process.argv.slice(2);

function usageErr(msg) {
  console.error(msg);
  process.exit(1);
}

if (!userDataDir || !target) {
  usageErr('Usage: resolve-profile.js <user_data_dir> <email|ask|list>');
}

const localStatePath = path.join(userDataDir, 'Local State');

if (!existsSync(localStatePath)) {
  usageErr(`No "Local State" at ${localStatePath} — run Chrome at least once with this user-data-dir first.`);
}

let localState;
try {
  localState = JSON.parse(readFileSync(localStatePath, 'utf8'));
} catch (e) {
  usageErr(`Cannot parse ${localStatePath}: ${e.message}`);
}

const infoCache = localState?.profile?.info_cache || {};
const entries = Object.entries(infoCache);

if (!entries.length) {
  usageErr(`No profiles found in ${localStatePath} — launch Chrome interactively once to create one.`);
}

function listProfiles() {
  for (const [dir, info] of entries) {
    const email = info?.user_name || info?.gaia_name || '(no email)';
    const name = info?.name || '';
    console.log(`  ${dir.padEnd(20)} ${email}${name ? '  [' + name + ']' : ''}`);
  }
}

const targetLower = target.toLowerCase().trim();

if (targetLower === 'list' || targetLower === '--list') {
  listProfiles();
  process.exit(0);
}

if (targetLower === 'ask' || targetLower === 'picker') {
  console.log('Guest Profile');
  process.exit(0);
}

const match = entries.find(([, info]) => {
  const email = (info?.user_name || '').toLowerCase();
  const gaiaName = (info?.gaia_name || '').toLowerCase();
  const profileName = (info?.name || '').toLowerCase();
  return email === targetLower || gaiaName === targetLower || profileName === targetLower;
});

if (!match) {
  console.error(`Profile "${target}" not found. Available:`);
  listProfiles();
  process.exit(1);
}

console.log(match[0]);
