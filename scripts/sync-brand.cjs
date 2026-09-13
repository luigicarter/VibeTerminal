'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const selected = process.argv[2];
if (selected && !['desktop', 'website', 'mobile'].includes(selected)) throw new Error('Expected desktop, website or mobile.');
const copies = {
  desktop: {
    'lina-mark.svg': ['frontend/assets/lina-logo.svg'],
    'lina-logo.png': ['frontend/assets/lina-logo.png', 'frontend/assets/vibeterminal-logo.png', 'frontend/assets/vibeterminal-logo-source.png'],
    'lina-logo.ico': ['frontend/assets/lina-logo.ico', 'frontend/assets/vibeterminal-logo.ico']
  },
  website: {
    'lina-mark.svg': ['frontend/public/brand/lina-mark.svg'],
    'lina-symbol.svg': ['frontend/public/brand/lina-symbol.svg'],
    'lina-logo.png': ['frontend/public/brand/lina-logo.png', 'frontend/public/vibeterminal-logo.png', 'frontend/public/vibeterminal-logo-source.png'],
    'lina-logo.ico': ['frontend/public/brand/lina-logo.ico', 'frontend/public/favicon.ico']
  },
  mobile: {
    'lina-logo-1024.png': ['assets/brand/icon.png', 'assets/brand/splash-icon.png'],
    'lina-logo-adaptive-1024.png': ['assets/brand/adaptive-icon.png'],
    'lina-logo.png': ['assets/brand/favicon.png']
  }
};
for (const app of selected ? [selected] : Object.keys(copies)) {
  for (const [source, targets] of Object.entries(copies[app])) {
    const bytes = fs.readFileSync(path.join(root, 'packages/brand', source));
    for (const target of targets) {
      const output = path.join(root, 'apps', app, target);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      if (!fs.existsSync(output) || !bytes.equals(fs.readFileSync(output))) fs.writeFileSync(output, bytes);
    }
  }
  console.log(`Brand assets synchronized: ${app}`);
}
