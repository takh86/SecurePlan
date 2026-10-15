import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

// Include pending source files, but never ignored runtime configuration or outputs.
// Historical commits and GitHub artifacts still need a separate review.
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const blocked = /^(?:docs\/(?:private|design-sources)\/|internal\/|secrets\/)|(?:^|\/)\.env(?:$|\.(?!example$))/;
const credentialPatterns = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[A-Z0-9]{16}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /sk-[A-Za-z0-9_-]{24,}/,
];
const failures = [];
for (const file of files) {
  if (!existsSync(file)) continue;
  if (blocked.test(file)) failures.push(`${file}: internal path`);
  const bytes = readFileSync(file);
  if (bytes.includes(0)) continue; // Binary files need a separate content review.
  const content = bytes.toString('utf8');
  if (credentialPatterns.some(pattern => pattern.test(content))) failures.push(`${file}: credential pattern`);
}
if (failures.length) {
  console.error('Public publication check failed (values omitted):\n' + failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Current tracked and non-ignored untracked text passed the limited publication check.');
}
