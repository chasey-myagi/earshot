import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'assets/earshot-icon.png');
const temp = mkdtempSync(join(tmpdir(), 'earshot-icon-'));
try {
  const iconset = join(temp, 'Earshot.iconset'); mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) execFileSync('sips', ['-z', String(size * scale), String(size * scale), source,
      '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'pipe' });
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(root, 'assets/Earshot.icns')]);
} finally { rmSync(temp, { recursive: true, force: true }); }
