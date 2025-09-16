module.exports = (req, res) => {
let url = req.url || '/';
if (url.startsWith('/api/addon')) {
url = url.slice('/api/addon'.length) || '/';
}

if (url === '/manifest.json') {
res.setHeader('content-type', 'application/json');
res.end(JSON.stringify({
id: 'org.test.addon',
version: '1.0.0',
name: 'Test Add-on',
description: 'Manifest smoke test',
resources: ['stream'],
types: ['movie', 'series'],
catalogs: []
}));
return;
}

if (url.startsWith('/stream/')) {
res.setHeader('content-type', 'application/json');
res.end(JSON.stringify({ streams: [] }));
return;
}

res.statusCode = 404;
res.end(Not found: ${url});
};
