'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).expo;

function plugin(name) {
  return (config.plugins || []).find(
    entry => entry === name || (Array.isArray(entry) && entry[0] === name)
  );
}

const splashPlugin = plugin('expo-splash-screen');
const notificationsPlugin = plugin('expo-notifications');
const buildPropertiesPlugin = plugin('expo-build-properties');

function resolveAsset(reference) {
  assert.equal(typeof reference, 'string', 'asset reference must be a string');
  assert.ok(reference.startsWith('./'), `asset reference must be app-relative: ${reference}`);
  return path.join(root, reference);
}

function pngSize(file) {
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), `not a PNG: ${file}`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('app.json carries the Lina Terminal identity', () => {
  assert.equal(config.name, 'Lina Terminal');
  assert.equal(config.slug, 'lina-terminal');
  assert.equal(config.scheme, 'lina');
  // A terminal is wide. Landscape is not a nicety here, it is how 80 columns fit.
  assert.equal(config.orientation, 'default');
  assert.equal(config.userInterfaceStyle, 'automatic');
  assert.equal(config.newArchEnabled, true);
  assert.equal(config.ios.supportsTablet, true);
  assert.equal(config.ios.bundleIdentifier, 'com.linaterminal.mobile');
  assert.equal(config.android.package, 'com.linaterminal.mobile');
  assert.equal(config.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
});

test('the packages the terminal page and key bar need are installed', () => {
  for (const dependency of [
    'expo-haptics',
    'expo-screen-orientation',
    'expo-clipboard',
    // The three notifications rest on, plus the one that lets a development
    // build talk to a desktop over plain HTTP on a LAN.
    'expo-notifications',
    'expo-task-manager',
    'expo-background-task',
    'expo-build-properties',
  ]) {
    assert.ok(
      fs.existsSync(path.join(root, 'node_modules', dependency)),
      `${dependency} must be installed`
    );
    const declared = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies;
    assert.ok(declared[dependency], `${dependency} must be a declared dependency`);
  }
});

test('the splash screen is configured through the expo-splash-screen plugin', () => {
  assert.ok(Array.isArray(splashPlugin), 'expo-splash-screen must be configured with options');
  assert.equal(splashPlugin[1].imageWidth, 200);
  assert.equal(splashPlugin[1].resizeMode, 'contain');
  assert.equal(splashPlugin[1].backgroundColor, config.android.adaptiveIcon.backgroundColor);
  assert.ok(fs.existsSync(path.join(root, 'node_modules/expo-splash-screen')), 'expo-splash-screen must be installed');
});

test('every asset referenced by app.json exists on disk', () => {
  const references = [
    config.icon,
    config.android.adaptiveIcon.foregroundImage,
    splashPlugin[1].image,
    config.web.favicon,
    notificationsPlugin[1].icon
  ];
  for (const reference of references) {
    const file = resolveAsset(reference);
    assert.ok(fs.existsSync(file), `missing asset: ${reference}`);
  }
});

test('notifications are configured, on their own channel and their own icon', () => {
  assert.ok(Array.isArray(notificationsPlugin), 'expo-notifications must be configured with options');
  const options = notificationsPlugin[1];
  assert.equal(options.icon, './assets/notification-icon.png');
  assert.equal(options.color, '#FFC466');
  // The same channel the app creates and posts on, named in one place.
  assert.equal(options.defaultChannel, require('../src/state/notifications.js').CHANNEL_ID);
});

test('the notification icon is a 96x96 white-on-transparent silhouette', () => {
  // Android keeps a small icon's alpha and throws its colours away, so the
  // brand PNG — the mark on its dark surface — would arrive as a grey block.
  // `scripts/make-notification-icon.cjs` writes this one from the vector.
  const file = resolveAsset(notificationsPlugin[1].icon);
  const { width, height } = pngSize(file);
  assert.equal(width, 96);
  assert.equal(height, 96);
  const { renderPixels } = require('./make-notification-icon.cjs');
  const pixels = renderPixels(96, 8);
  let opaque = 0;
  for (let index = 0; index < 96 * 96; index += 1) {
    if (pixels[index * 4 + 3] === 0) continue;
    opaque += 1;
    assert.equal(pixels[index * 4], 255, 'every drawn pixel must be white');
    assert.equal(pixels[index * 4 + 1], 255);
    assert.equal(pixels[index * 4 + 2], 255);
  }
  assert.ok(opaque > 2000 && opaque < 96 * 96 * 0.7, `the glyph covers ${opaque} pixels`);
});

test('a development build may talk to a desktop over plain HTTP', () => {
  // The bridge is `http://<address>:47831` on somebody's own network. Android
  // has refused cleartext by default since API 28, so without this the release
  // build cannot reach any desktop at all.
  assert.ok(Array.isArray(buildPropertiesPlugin), 'expo-build-properties must be configured');
  assert.equal(buildPropertiesPlugin[1].android.usesCleartextTraffic, true);
});

test('the release build has a script that can reproduce it', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['android:release'], 'node scripts/build-android-release.cjs');
  assert.equal(scripts['android:dev'], 'expo run:android');
  assert.ok(fs.existsSync(path.join(root, 'scripts/build-android-release.cjs')));
});

test('the icon, adaptive icon and splash icon are 1024x1024 brand exports', () => {
  for (const reference of [config.icon, config.android.adaptiveIcon.foregroundImage, splashPlugin[1].image]) {
    const { width, height } = pngSize(resolveAsset(reference));
    assert.equal(width, 1024, `${reference} width`);
    assert.equal(height, 1024, `${reference} height`);
  }
});

test('the assets directory holds only synchronized brand copies', () => {
  // `brand` is filled by `scripts/sync-brand.cjs`; `notification-icon.png` is
  // written by `scripts/make-notification-icon.cjs` from the same vector, and
  // is separate because Android's small icon is a silhouette, not the mark.
  const allowed = ['brand', 'notification-icon.png'];
  const stray = fs.readdirSync(path.join(root, 'assets')).filter(entry => !allowed.includes(entry));
  assert.deepEqual(stray, [], `unreferenced template assets remain: ${stray.join(', ')}`);
});
