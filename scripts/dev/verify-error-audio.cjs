const { createLocalErrorAudio, ERROR_AUDIO_TEXT } = require('../../backend/localErrorAudio.cjs');
const audio = createLocalErrorAudio();
for (const category of Object.keys(ERROR_AUDIO_TEXT)) audio.load(category);
console.log('Bundled offline error announcements verified.');
