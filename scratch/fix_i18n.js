const fs = require('fs');
const path = require('path');

// Root is one level up from scratch
const rootDir = path.join(__dirname, '..');
const filePath = path.join(rootDir, 'frontend/src/i18n/message-registry.ts');
let content = fs.readFileSync(filePath, 'binary');

const buffer = Buffer.from(content, 'binary');
const fixedContent = buffer.toString('utf8');

fs.writeFileSync(filePath, fixedContent, 'utf8');
console.log('Successfully fixed encoding in message-registry.ts');
