module.exports = (req, res) => {
// Parse and normalize the URL
const u = new URL(req.url, 'http://localhost');
let pathname = u.pathname;

// Strip the /api/addon prefix so downstream sees the Stremio paths
if (pathname.startsWith('/api/addon')) {
pathname = pathname.slice('/api/addon'.length) || '/';
}

// Vercel adds the dynamic catch‑all as a query param (?path=...)
// Remove it so matching works
u.searchParams.delete('path'); // because file is [...path].js / [[...path]].js
u.searchParams.delete('slug'); // safe if you ever rename to [...slug].js

const normalizedUrl = pathname + (u.search || '');

if (pathname === '/manifest.json') {
res.setHeader('content-type', 'application/json');
res.end(JSON.stringify({
id: 'org.test.addon',
version: '1.0.0',
name: 'Test Add-on',
resources: ['stream'],
types: ['movie', 'series'],
catalogs: []
}));
return;
}

if (pathname.startsWith('/stream/')) {
res.setHeader('content-type', 'application/json');
res.end(JSON.stringify({ streams: [] }));
return;
}

res.statusCode = 404;
res.setHeader('content-type', 'application/json');
res.end(JSON.stringify({ error: 'Not found', url: normalizedUrl }));
};

Once that returns the manifest OK, switch to the Stremio SDK skeleton and keep the same URL normalization before calling the SDK router:
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
// Normalize URL so the SDK sees clean paths
const u = new URL(req.url, 'http://localhost');
let pathname = u.pathname;
if (pathname.startsWith('/api/addon')) {
pathname = pathname.slice('/api/addon'.length) || '/';
}
u.searchParams.delete('path');
u.searchParams.delete('slug');
req.url = pathname + (u.search || '');

return iface(req, res);
};
