const fs = require('fs');
const path = require('path');

const filePath = 'd:/9 KANDA/vibecoding/cloudflare_temp_email/frontend/src/i18n/locales/source/id.ts';
const content = fs.readFileSync(filePath, 'utf8');

const regex = /^\s*"([^"]+)"\s*:\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/gm;
const matches = [...content.matchAll(regex)];

const messages = {};
for (const match of matches) {
    messages[match[1]] = match[2];
}

const output = [
    'export const idMessages = {',
    ...Object.entries(messages).map(([key, value], index, array) => {
        return `  "${key}": ${value}${index === array.length - 1 ? '' : ','}`;
    }),
    '}'
].join('\n');

fs.writeFileSync(filePath, output);
console.log('Cleaned id.ts');
