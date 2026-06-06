import http from 'http';
import https from 'https';

const payload = JSON.stringify({
  type: 'test',
  user: '12345'
});

const options = {
  hostname: 'medhat-bot-production.up.railway.app',
  path: '/dblwebhook',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'whs_93aca7e0c8b1658bf041d7e449df28f8f678b1a1d00bbc160a50a84959e9a831',
    'Content-Length': Buffer.byteLength(payload)
  }
};

const req = https.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    console.log(`BODY: ${chunk}`);
  });
});

req.on('error', (e) => {
  console.error(`problem with request: ${e.message}`);
});

req.write(payload);
req.end();
