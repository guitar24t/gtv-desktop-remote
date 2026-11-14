#!/usr/bin/env node
'use strict';
// Synthetic process boundary. Production -B/-L/-G parsing remains untouched.
const fs = require('node:fs');
const args = process.argv.slice(2);
const path = process.env.GTV_DNS_SD_STATE;
// Apple mDNSResponder Clients/dns-sd.c browse_reply prints raw UTF-8 names.
// ShowTXTRecord alone applies shell-friendly metacharacter/control escaping:
// https://github.com/apple-oss-distributions/mDNSResponder/blob/main/Clients/dns-sd.c
function escape(value) {
  let result = '';
  for (const character of String(value)) {
    if (character === '\\') result += '\\'.repeat(4);
    else if (character.charCodeAt(0) < 32)
      result +=
        '\\'.repeat(2) + 'x' + character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
    else if (' &;`\'"|*?~<>^()[]{}$'.includes(character)) result += '\\' + character;
    else result += character;
  }
  return result;
}
// resolve_reply prints the escaped DNS full name: '.' and '\\' get a
// backslash, bytes <= space become \DDD (e.g. a space is \032).
function escapeFullNameLabel(value) {
  let result = '';
  for (const character of String(value)) {
    const code = character.charCodeAt(0);
    if (character === '.' || character === '\\') result += '\\' + character;
    else if (code <= 32) result += '\\' + String(code).padStart(3, '0');
    else result += character;
  }
  return result;
}
// browse_reply: printf("%s %8X %3d %-20s %-20s %s\n", op, flags, ifIndex, domain, type, name)
// after a "%2d:%02d:%02d.%03d  " timestamp. Columns are padded to 20 characters
// plus ONE space, so 20+ character service types (e.g. "_androidtvremote2._tcp.")
// are followed by a single space before the instance name.
function browseLine(stamp, type, name) {
  return `${stamp}  Add ${'3'.padStart(8)} ${'19'.padStart(3)} ${'local.'.padEnd(20)} ${`${type}.`.padEnd(20)} ${name}\n`;
}
try {
  if (!path) throw new Error('GTV_DNS_SD_STATE is required');
  const state = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (state.error) throw new Error(state.error);
  const records = state.available === false ? [] : state.records || [];
  const stamp = ' 0:05:10.480';
  const serviceOf = (record) => record.service || '_androidtvremote2._tcp';
  const hostOf = (record) => record.hostName || 'synthetic-tv.local.';
  if (state.malformed) process.stdout.write('synthetic malformed record: no DNS fields\n');
  else if (args[0] === '-B') {
    process.stdout.write(
      `Browsing for ${args[1]}.${args[2] || 'local.'}\nDATE: ---Thu 12 Nov 2026---\n${stamp}  ...STARTING...\nTimestamp     A/R    Flags  if Domain               Service Type         Instance Name\n`
    );
    for (const record of records.filter((record) => serviceOf(record) === args[1])) {
      for (let count = 0; count < (record.duplicate || 1); count++) {
        process.stdout.write(
          record.malformed ? 'not a DNS browse record\n' : browseLine(stamp, args[1], record.name)
        );
      }
    }
  } else if (args[0] === '-L') {
    const record = records.find(
      (record) => record.name === args[1] && serviceOf(record) === args[2]
    );
    if (record && !record.malformed) {
      process.stdout.write(
        `Lookup ${args[1]}.${args[2]}.local.\nDATE: ---Thu 12 Nov 2026---\n${stamp}  ...STARTING...\n${stamp}  ${escapeFullNameLabel(args[1])}.${args[2]}.local. can be reached at ${hostOf(record)}:${record.port || 6466} (interface 19)\n`
      );
      process.stdout.write(
        ' ' +
          Object.entries(record.txt || {})
            .map(([key, value]) => `${key}=${escape(value)}`)
            .join(' ') +
          '\n'
      );
    } else process.stdout.write('No matching service record\n');
  } else if (args[0] === '-G') {
    process.stdout.write('Timestamp     A/R Flags if Hostname Address TTL\n');
    for (const record of records.filter(
      (record) => hostOf(record) === args[2] && !record.malformed
    )) {
      process.stdout.write(`${stamp}  Add 2 1 ${args[2]} ${record.host || '127.0.0.1'} 120\n`);
    }
  } else throw new Error(`unsupported dns-sd arguments: ${args.join(' ')}`);
} catch (error) {
  process.stderr.write(`Synthetic dns-sd: ${error.message}\n`);
  process.exitCode = 1;
}
