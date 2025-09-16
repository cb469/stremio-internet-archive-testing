// Minimal Stremio addon skeleton (smoke test)
const { addonBuilder } = require('stremio-addon-sdk');

const manifest = {
id: 'org.test.addon',
version: '1.0.0',
name: 'Test Add-on',
description: 'Smoke test',
resources: ['stream'],
types: ['movie', 'series'],
catalogs: []
};

const builder = new addonBuilder(manifest);
builder.defineStreamHandler(async () => ({ streams: [] }));

const iface = builder.getInterface();

module.exports = async (req, res) => {
// remove the /api/addon prefix so the SDK sees /manifest.json, /stream/...
if (req.url && req.url.startsWith('/api/addon')) {
req.url = req.url.replace(/^/api/addon/, '') || '/';
}
return iface(req, res);
};
