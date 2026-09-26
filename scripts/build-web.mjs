// Build step for the Vercel deployment: copies the static web UI
// (index.html + app.js) into public/, which vercel.json declares as the
// deployment's output directory. Locally the same files are served from
// the project root by `npm run dev` (scripts/dev-server.ts).
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outputDir = join(root, 'public');

await mkdir(outputDir, { recursive: true });
await copyFile(join(root, 'index.html'), join(outputDir, 'index.html'));
await copyFile(join(root, 'app.js'), join(outputDir, 'app.js'));
console.log('Copied the web UI into public/ (deployment output directory).');