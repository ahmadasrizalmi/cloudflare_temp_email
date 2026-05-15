const fs = require('fs');

const filePath = 'd:/9 KANDA/vibecoding/cloudflare_temp_email/frontend/src/i18n/message-registry.ts';
let content = fs.readFileSync(filePath, 'utf8');

// A more robust way: find each object block and sync zh to en
// Example: { "en": "...", "zh": "..." }
const lines = content.split('\n');
let inEn = false;
let enValue = '';
for (let i = 0; i < lines.length; i++) {
    const enMatch = lines[i].match(/"en":\s*("(?:[^"\\]|\\.)*")/);
    if (enMatch) {
        enValue = enMatch[1];
        inEn = true;
        continue;
    }
    const zhMatch = lines[i].match(/"zh":\s*("(?:[^"\\]|\\.)*")/);
    if (zhMatch && inEn) {
        lines[i] = lines[i].replace(zhMatch[1], enValue);
        inEn = false;
    }
}

fs.writeFileSync(filePath, lines.join('\n'));
console.log('Fixed message-registry.ts by syncing all zh values to en values line by line');
