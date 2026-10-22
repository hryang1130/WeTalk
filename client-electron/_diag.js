const e = require('electron');
console.log('TYPE=' + (typeof e));
console.log('KEYS=' + Object.keys(e).slice(0, 30).join(','));
setTimeout(() => process.exit(0), 800);
