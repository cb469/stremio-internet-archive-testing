// Minimal Stremio addon skeleton (smoke test)
const { addonBuilder } = require('stremio-addon-sdk');

const manifest = {
  id: 'org.test.addon',
  version: '1.0.0',
  name: 'Test Add-on',
  description: 'Smoke test manifest',
  resources: ['stream'],
  types: ['movie', 'series'],
  catalogs: []
};

const builder = new addonBuilder(manifest);

// Always return an empty array (just to prove stream endpoint is wired)
builder.defineStreamHandler(async () => ({ streams: [] }));

// Build the interface once
const iface = builder.getInterface();

// Vercel entrypoint: strip the /api/addon prefix, forward to SDK
module.exports = async (req, res) => {
  if (req.url && req.url.startsWith('/api/addon')) {
    req.url = req.url.replace(/^\/api\/addon/, '') || '/';
  }
  return iface(req, res);
};
