#!/usr/bin/env node
'use strict';

/**
 * Build a signed, sideloadable Android release APK.
 *
 * The project is managed: there is no `android/` folder in the repository and
 * there is not going to be one. So this script produces the whole thing from
 * `app.json` every time — `expo prebuild --clean` writes the native project,
 * this patches the one thing a generated project gets wrong for a real release
 * (Expo's template signs `release` with the *debug* key, which is the right
 * default for a template and the wrong one for a phone), and Gradle builds it.
 *
 * That is what makes the output reproducible after a clean checkout: nothing
 * is carried between builds except the key, which cannot be — it is the
 * identity of the app and is deliberately not in the repository.
 *
 *   node scripts/build-android-release.cjs           # the whole thing
 *   node scripts/build-android-release.cjs --no-prebuild   # reuse android/
 *
 * The key comes from `.tmp/keys` (gitignored): `lina-release.keystore`, the
 * alias `lina-release`, and the password from `.tmp/keys/.password` or the
 * environment variable `LINA_ANDROID_KEYSTORE_PASSWORD`. `.tmp/keys/README.txt`
 * says how the key was made and how to make another. The password is passed to
 * Gradle as a `-P` property rather than written into `gradle.properties`, so
 * the only copy of it on this disk is the one in `.tmp/keys`.
 *
 * The signature is then *checked* rather than assumed: the finished APK's
 * signer certificate has to be the one in the keystore, or this fails. That
 * matters because the patched Gradle config falls back to the debug key when
 * the properties are missing — it has to, or every `expo run:android` would
 * break — and a debug-signed "release" APK is the exact mistake worth catching.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const androidDir = path.join(root, 'android');
const keysDir = path.join(root, '.tmp', 'keys');
const distDir = path.join(root, '.tmp', 'dist');
const keystore = path.join(keysDir, 'lina-release.keystore');
const KEY_ALIAS = 'lina-release';

function fail(message) {
  process.stderr.write(`\nBUILD FAILED: ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  // Never print the key's password, not even into a gitignored log.
  const shown = args.map(arg => arg.replace(/(PASSWORD=).*/, '$1********'));
  process.stdout.write(`\n$ ${command} ${shown.join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...(options.env || {}) },
  });
  if (result.error) fail(`${command} could not be started: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

/** The SDK, which Gradle needs and which is not always exported. */
function androidSdk() {
  const named = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (named && fs.existsSync(named)) return named;
  const guess = path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
  if (fs.existsSync(guess)) return guess;
  fail('ANDROID_HOME is not set and no SDK was found. Point it at your Android SDK.');
  return '';
}

/** `apksigner` from the newest installed build-tools. */
function apksignerPath(sdk) {
  const buildTools = path.join(sdk, 'build-tools');
  if (!fs.existsSync(buildTools)) return null;
  const versions = fs
    .readdirSync(buildTools)
    .filter(entry => fs.existsSync(path.join(buildTools, entry, `apksigner${process.platform === 'win32' ? '.bat' : ''}`)))
    .sort();
  if (!versions.length) return null;
  const newest = versions[versions.length - 1];
  return path.join(buildTools, newest, `apksigner${process.platform === 'win32' ? '.bat' : ''}`);
}

function keystorePassword() {
  if (process.env.LINA_ANDROID_KEYSTORE_PASSWORD) return process.env.LINA_ANDROID_KEYSTORE_PASSWORD;
  const file = path.join(keysDir, '.password');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  fail(
    `no keystore password. Put it in ${path.relative(root, file)} or set LINA_ANDROID_KEYSTORE_PASSWORD. See ${path.relative(root, path.join(keysDir, 'README.txt'))}.`
  );
  return '';
}

/**
 * Teach the generated project about the release key.
 *
 * Both edits are anchored on exact text from Expo's template and both insist on
 * finding it exactly once, so a template that changes shape stops the build
 * instead of quietly producing something else.
 */
function injectSigning() {
  const file = path.join(androidDir, 'app', 'build.gradle');
  let source = fs.readFileSync(file, 'utf8');

  if (source.includes('LINA_RELEASE_STORE_FILE')) {
    process.stdout.write('SIGNING already injected\n');
    return;
  }

  const configsAnchor = '    signingConfigs {\n        debug {';
  if (source.split(configsAnchor).length !== 2) {
    fail(`could not find the signingConfigs block in ${path.relative(root, file)}`);
  }
  source = source.replace(
    configsAnchor,
    [
      '    signingConfigs {',
      '        release {',
      '            // Set by scripts/build-android-release.cjs. The fallback to the',
      '            // debug key keeps `expo run:android` working on a project this',
      '            // script has already patched; the script verifies the finished',
      '            // APK\'s signer, so a fallback can never ship unnoticed.',
      "            storeFile file(findProperty('LINA_RELEASE_STORE_FILE') ?: 'debug.keystore')",
      "            storePassword findProperty('LINA_RELEASE_STORE_PASSWORD') ?: 'android'",
      "            keyAlias findProperty('LINA_RELEASE_KEY_ALIAS') ?: 'androiddebugkey'",
      "            keyPassword findProperty('LINA_RELEASE_KEY_PASSWORD') ?: 'android'",
      '        }',
      '        debug {',
    ].join('\n')
  );

  const buildTypeAnchor = [
    '            // Caution! In production, you need to generate your own keystore file.',
    '            // see https://reactnative.dev/docs/signed-apk-android.',
    '            signingConfig signingConfigs.debug',
  ].join('\n');
  if (source.split(buildTypeAnchor).length !== 2) {
    fail(`could not find the release build type's signing config in ${path.relative(root, file)}`);
  }
  source = source.replace(buildTypeAnchor, '            signingConfig signingConfigs.release');

  fs.writeFileSync(file, source);
  process.stdout.write(`SIGNING injected into ${path.relative(root, file)}\n`);
}

/**
 * Put back what `expo prebuild` helpfully changed.
 *
 * Creating a native folder rewrites the `ios` and `android` npm scripts to
 * `expo run:*`. That is a sensible default for a project that keeps its native
 * folders; this one does not, so a *build* silently editing a checked-in file is
 * just a diff to explain later. `android:dev` is the native build here.
 */
function restoreScripts() {
  const file = path.join(root, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const wanted = { ios: 'expo start --ios', android: 'expo start --android' };
  let changed = false;
  for (const [name, value] of Object.entries(wanted)) {
    if (manifest.scripts[name] !== value) {
      manifest.scripts[name] = value;
      changed = true;
    }
  }
  if (!changed) return;
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write('SCRIPTS restored the ios/android npm scripts prebuild rewrote\n');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The keystore's own certificate fingerprint, to compare the APK's against. */
function certificateFingerprint(password) {
  const javaHome = process.env.JAVA_HOME;
  const keytool = javaHome
    ? path.join(javaHome, 'bin', `keytool${process.platform === 'win32' ? '.exe' : ''}`)
    : 'keytool';
  const output = capture(`"${keytool}"`, [
    '-list',
    '-v',
    '-keystore',
    `"${keystore}"`,
    '-alias',
    KEY_ALIAS,
    '-storepass',
    `"${password}"`,
  ]);
  const match = /SHA256:\s*([0-9A-F:]{95})/i.exec(output);
  return match ? match[1].toUpperCase().replace(/:/g, '') : null;
}

function main() {
  const argv = process.argv.slice(2);
  const prebuild = !argv.includes('--no-prebuild');

  if (!fs.existsSync(keystore)) {
    fail(
      `no keystore at ${path.relative(root, keystore)}. Create one — ${path.relative(root, path.join(keysDir, 'README.txt'))} has the exact keytool command — or restore your backup of it.`
    );
  }
  const password = keystorePassword();
  const sdk = androidSdk();
  const version = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).expo.version;

  // The brand assets the icons come from, exactly as `npm run build` does.
  run('node', ['../../scripts/sync-brand.cjs', 'mobile']);
  // The notification icon is generated rather than stored, for the same reason.
  run('node', [path.join(__dirname, 'make-notification-icon.cjs')]);

  if (prebuild) {
    run('npx', ['expo', 'prebuild', '--platform', 'android', '--clean', '--no-install'], {
      env: { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk },
    });
    restoreScripts();
  } else if (!fs.existsSync(androidDir)) {
    fail('--no-prebuild was given but there is no android/ folder to build');
  }

  injectSigning();

  // An absolute path, because a bare `gradlew.bat` is not on cmd.exe's search
  // path even when it is sitting in the working directory.
  const gradlew = path.join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  run(
    process.platform === 'win32' ? `"${gradlew}"` : gradlew,
    [
      'assembleRelease',
      '--no-daemon',
      `-PLINA_RELEASE_STORE_FILE=${keystore.replace(/\\/g, '/')}`,
      `-PLINA_RELEASE_KEY_ALIAS=${KEY_ALIAS}`,
      `-PLINA_RELEASE_STORE_PASSWORD=${password}`,
      `-PLINA_RELEASE_KEY_PASSWORD=${password}`,
    ],
    { cwd: androidDir, env: { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk } }
  );

  const built = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  if (!fs.existsSync(built)) fail(`Gradle reported success but ${path.relative(root, built)} is not there`);

  fs.mkdirSync(distDir, { recursive: true });
  const out = path.join(distDir, `LinaTerminal-${version}-android.apk`);
  fs.copyFileSync(built, out);

  // Prove it is signed by the release key and not by the template's debug one.
  const signer = apksignerPath(sdk);
  const expected = certificateFingerprint(password);
  if (signer && expected) {
    const report = capture(`"${signer}"`, ['verify', '--print-certs', `"${out}"`]);
    const actual = (/SHA-256 digest:\s*([0-9a-f]{64})/i.exec(report) || [])[1];
    const normalized = actual ? actual.toUpperCase() : null;
    if (!normalized) {
      process.stdout.write('SIGNATURE could not be read; apksigner said:\n' + report + '\n');
    } else if (normalized !== expected) {
      fail(
        `the APK is signed by ${normalized}, not by the release key ${expected}. Something fell back to the debug keystore.`
      );
    } else {
      process.stdout.write(`SIGNATURE ${normalized} (matches ${path.relative(root, keystore)})\n`);
    }
  } else {
    process.stdout.write('SIGNATURE not verified: apksigner or keytool was not found.\n');
  }

  const bytes = fs.statSync(out).size;
  process.stdout.write(`\nAPK      ${out}\n`);
  process.stdout.write(`SIZE     ${bytes} bytes (${(bytes / (1024 * 1024)).toFixed(1)} MB)\n`);
  process.stdout.write(`SHA256   ${sha256(out)}\n`);
  process.stdout.write(`INSTALL  adb install -r "${out}"\n`);
}

main();
