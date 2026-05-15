const fs = require('fs');

const filePath = 'd:/9 KANDA/vibecoding/cloudflare_temp_email/frontend/src/i18n/message-registry.ts';
let content = fs.readFileSync(filePath, 'utf8');

// Regex to find "zh": "..." blocks and replace them with "zh": "English version"
// But even better, just replace the zh value with the en value found in the same block.
const regex = /("en":\s*("[^"]*"),\s*"zh":\s*)("[^"]*")/g;
content = content.replace(regex, (match, p1, p2, p3) => {
    return p1 + p2; // p1 is "en": "...", "zh": , p2 is "..." (en value)
});

fs.writeFileSync(filePath, content);
console.log('Fixed message-registry.ts by replacing zh with en');
