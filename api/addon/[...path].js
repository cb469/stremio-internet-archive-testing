module.exports = (req, res) => {
try {
const u = new URL(req.url, 'http://localhost');
let pathname = u.pathname;
// strip the Vercel prefix
if (pathname.startsWith('/api/addon')) {
  pathname = pathname.slice('/api/addon'.length) || '/';
}

// Vercel adds the catch-all param (?path=...), remove it
u.searchParams.delete('path');
u.searchParams.delete('slug');

if (pathname === '/manifest.json') {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    id: 'org.test.addon',
    version: '1.0.0',
    name: 'Test Add-on (Manifest OK)',
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
res.end(JSON.stringify({ error: 'Not found', path: pathname }));
} catch (e) {
res.statusCode = 500;
res.setHeader('content-type', 'application/json');
res.end(JSON.stringify({ error: e.message }));
}
};
