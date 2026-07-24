const fs = require('fs');
let c = fs.readFileSync('src/a2mcp-server.ts', 'utf8');

const find = 'async function handleHealth(res: http.ServerResponse) {';
const replace = `function handleIndex(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(CHAT_UI_HTML);
}

async function handleHealth(res: http.ServerResponse) {`;

c = c.replace(find, replace);
fs.writeFileSync('src/a2mcp-server.ts', c);
console.log(c.includes('function handleIndex') ? 'OK' : 'FAIL');
