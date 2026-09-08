// Build the complete, unnotarized Apple Silicon preview from a clean source revision.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageApp, MIN_MACOS_VERSION, PROD_BUNDLE_ID } from './package-app.mjs';
import { VOICEPRINT_MODEL, VOICEPRINT_MODEL_SHA256 } from './fetch-voiceprint-model.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This preview requires a macOS arm64 build host');
if (run('git', ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Commit the complete source tree before preparing a release');
const sourceCommit = run('git', ['rev-parse', 'HEAD']);
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release version must be a numeric major.minor.patch');
const model = join(root, 'models', VOICEPRINT_MODEL);
if (!existsSync(model) || digest(model) !== VOICEPRINT_MODEL_SHA256) throw new Error('Fetch the verified voiceprint model before preparing the complete release');
const output = join(root, 'release', version);
if (existsSync(output)) throw new Error('Release output already exists; preserve or remove it explicitly before rebuilding');

const app = packageApp(root);
run('codesign', ['--verify', '--deep', '--strict', app]);
const plist = join(app, 'Contents/Info.plist');
if (run('plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', plist]) !== MIN_MACOS_VERSION) throw new Error('Packaged minimum macOS does not match the release declaration');
if (digest(join(app, 'Contents/Resources/models', VOICEPRINT_MODEL)) !== VOICEPRINT_MODEL_SHA256) throw new Error('Packaged model mismatch');
if (run('git', ['rev-parse', 'HEAD']) !== sourceCommit || run('git', ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Source changed during packaging');
mkdirSync(output, { recursive: true });
const name = `Earshot-${version}-macos-arm64.zip`;
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, join(output, name)]);
const sha256 = digest(join(output, name));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const runtimeVersions = Object.fromEntries(['electron', 'koffi', 'node-mac-permissions', 'sherpa-onnx-node', 'sherpa-onnx-darwin-arm64'].map(name => [name, lock.packages[`node_modules/${name}`].version]));
writeFileSync(join(output, 'SHA256SUMS.txt'), `${sha256}  ${name}\n`);
writeFileSync(join(output, 'release-manifest.json'), JSON.stringify({
  schemaVersion: 1, version, tag: `v${version}`, channel: 'preview',
  repository: 'https://github.com/chasey-myagi/earshot', sourceCommit,
  lockfileSha256: digest(join(root, 'package-lock.json')), bundleId: PROD_BUNDLE_ID,
  architecture: 'arm64', minimumMacOS: MIN_MACOS_VERSION,
  buildHostMacOS: run('sw_vers', ['-productVersion']), runtimeVersions,
  notarization: 'not-performed', signatureIntegrityVerified: true,
  freshMacInstallationVerified: false,
  model: { file: VOICEPRINT_MODEL, sha256: VOICEPRINT_MODEL_SHA256, license: 'Apache-2.0' },
  archive: { file: name, bytes: readFileSync(join(output, name)).length, sha256 },
}, null, 2) + '\n');
console.log(output);
