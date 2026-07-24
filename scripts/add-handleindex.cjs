const fs = require('fs');
let content = fs.readFileSync('src/a2mcp-server.ts', 'utf8');

console.log('Before: handleIndex exists?', content.includes('function handleIndex'));

const search = `// ===== Health Endpoint =====
async function handleHealth`;

const replacement = `// ===== Index / Chat UI =====
function handleIndex(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(CHAT_UI_HTML);
}

// ===== Health Endpoint =====
async function handleHealth`;

content = content.replace(search, replacement);
fs.writeFileSync('src/a2mcp-server.ts', content);

console.log('After: handleIndex exists?', content.includes('function handleIndex'));
console.log('Replacement applied:', content.includes('function handleIndex'));
