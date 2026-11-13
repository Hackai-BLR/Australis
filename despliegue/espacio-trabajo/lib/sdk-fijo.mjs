import fs from 'node:fs';
import { register } from 'node:module';

if (fs.existsSync('/usr/local/lib/campusia/sdk/dist/index.js')) {
  register('file:///usr/local/lib/campusia/sdk-ganchos.mjs');
}
