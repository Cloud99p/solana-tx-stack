const fs = require('fs');
let content = fs.readFileSync('src/a2mcp-server.ts', 'utf8');

// Check if handleIndex function exists
if (content.includes('function handleIndex')) {
  console.log('OK: handleIndex already defined');
  process.exit(0);
}

console.log('FIXING: adding handleIndex function...');

// Add after the imports, before handleHealth
const fn = `
// ===== Index / Chat UI =====
function handleIndex(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(CHAT_UI_HTML);
}

`;

content = content.replace(
  '// ===== Health Endpoint =====',
  fn.trimEnd() + '\n\n// ===== Health Endpoint ====='
);

fs.writeFileSync('src/a2mcp-server.ts', content);
console.log('DONE: handleIndex added');

// Verify
content = fs.readFileSync('src/a2mcp-server.ts', 'utf8');
console.log('Verified handleIndex:', content.includes('function handleIndex'));
