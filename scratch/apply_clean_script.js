const fs = require('fs');
const appPath = 'd:/9 KANDA/vibecoding/cloudflare_temp_email/frontend/src/App.vue';
const cleanScriptPath = 'd:/9 KANDA/vibecoding/cloudflare_temp_email/scratch/app_script_clean.vue';

const appContent = fs.readFileSync(appPath, 'utf8');
const cleanScript = fs.readFileSync(cleanScriptPath, 'utf8');

const newContent = appContent.replace(/<script setup>[\s\S]*?<\/script>/, cleanScript);

fs.writeFileSync(appPath, newContent);
console.log('Successfully replaced script section in App.vue with clean code.');
