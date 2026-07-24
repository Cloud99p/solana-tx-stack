const fs = require('fs');
const lines = fs.readFileSync('src/a2mcp-server.ts', 'utf8').split('\n');
for (let i = 274; i <= 282; i++) {
  const marker = i === 277 ? '>>>' : '   ';
  console.log(marker, i + 1, lines[i]);
}
