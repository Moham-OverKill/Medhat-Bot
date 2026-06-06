import fetch from 'node-fetch'; // wait, is node-fetch installed or do we use global fetch?
// Let's use global fetch if available, or dynamic import, or https module.
import https from 'https';

const url = "https://media.discordapp.net/attachments/1502133243187560479/1512923506843586640/image.png?ex=6a25db50&is=6a2489d0&hm=24a28652b9702165d2fa8984c24966576419c74331161ea74acc1f70abf741ba&animated=true";

https.get(url, (res) => {
  console.log('Status Code:', res.statusCode);
  console.log('Headers:', res.headers);
  let data = [];
  res.on('data', (chunk) => data.push(chunk));
  res.on('end', () => {
    const buffer = Buffer.concat(data);
    console.log('Buffer Length:', buffer.length);
  });
}).on('error', (err) => {
  console.error('Error:', err);
});
