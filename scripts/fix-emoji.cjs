const fs = require('fs');
let h = fs.readFileSync('frontend/index.html', 'utf8');

// Remove sidebar logo emoji
h = h.replace('<div class="icon">⚡</div>', '<div class="icon">M</div>');
// Remove header emoji
h = h.replace('<span>💬</span>', '');
// Update sidebar title
h = h.replace('<span>MEV Agent</span>', '<span>Solana MEV Agent</span>');

fs.writeFileSync('frontend/index.html', h);
console.log('EMOJIS REMOVED:', !h.includes('⚡') && !h.includes('💬'));
