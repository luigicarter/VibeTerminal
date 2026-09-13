import { resolve } from 'node:path';
// This module lives directly in src/; the Bun artifact lives directly in dist/.
export const serverRoot = resolve(import.meta.dir, '..');
