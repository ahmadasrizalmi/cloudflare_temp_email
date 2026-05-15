const fs = require('fs');
const path = 'd:/9 KANDA/vibecoding/cloudflare_temp_email/frontend/src/App.vue';
let content = fs.readFileSync(path, 'utf8');

// Remove ad variables
content = content.replace(/const adClient = import\.meta\.env\.VITE_GOOGLE_AD_CLIENT;\s*/g, '');
content = content.replace(/const adSlot = import\.meta\.env\.VITE_GOOGLE_AD_SLOT;\s*/g, '');
content = content.replace(/const showAd = computed\(\(\) => !isMobile\.value && adClient && adSlot\);\s*/g, '');
content = content.replace(/const gridMaxCols = computed\(\(\) => showAd\.value \? 8 : 12\);/g, 'const gridMaxCols = 12;');

// Remove ad script loading
content = content.replace(/\/\/ Load Google Ad script[\s\S]*?async: true,[\s\S]*?}\s*/g, '');

// Remove ad initialization in onMounted
content = content.replace(/\/\/ check if google ad is enabled[\s\S]*?window\.adsbygoogle\.push\({}\);[\s\S]*?}\s*/g, '');

// Remove ads from template
content = content.replace(/v-if="showAd"/g, 'v-if="false"'); // Temporary disable
content = content.replace(/<ins class="adsbygoogle"[\s\S]*?<\/ins>/g, '');
content = content.replace(/<div class="side" v-if="false">[\s\S]*?<\/div>/g, '<div class="side"></div>');

fs.writeFileSync(path, content);
console.log('Removed Google Adsense from App.vue');
