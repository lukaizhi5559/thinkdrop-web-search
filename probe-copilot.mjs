import os from 'os';
os.homedir = () => '/tmp/cft-probe-home';
const { searchBingCopilot } = await import('./src/providers/bingCopilot.js');
let chunks = 0;
const r = await searchBingCopilot('what is the percentage of people that work out', { onChunk: () => chunks++ });
console.log('provider:', r.provider, '| results:', r.results.length, '| ms:', r.elapsedMs, '| chunks:', chunks);
console.log('=== OVERVIEW ===\n' + (r.aiOverview || '(none)'));
console.log('=== SOURCES ===\n' + r.results.map(x => '- ' + x.title.slice(0,50) + ' -> ' + x.url.slice(0, 60)).join('\n'));
process.exit(0);
