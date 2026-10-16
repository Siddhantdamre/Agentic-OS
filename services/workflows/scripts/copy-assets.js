// Copies the files tsc does not emit into dist/. Plain Node, so `pnpm build` runs the same on Windows, macOS and Linux
// (the old `mkdir -p … && cp …` needed a POSIX shell).
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const assets = [['src/metrics/core-kpis.yaml', 'dist/metrics/core-kpis.yaml']];

for (const [from, to] of assets) {
  const dest = path.join(root, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, from), dest);
}
