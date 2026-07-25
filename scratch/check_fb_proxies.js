async function checkFbProxies() {
  const testUrls = [
    'https://ezfacebook.com',
    'https://fixfacebook.com',
    'https://fxfacebook.com'
  ];
  for (const url of testUrls) {
    try {
      const start = Date.now();
      const res = await fetch(url, { headers: { 'User-Agent': 'Discordbot/2.0' } });
      console.log(url, `[${Date.now() - start}ms] Status:`, res.status);
    } catch (e) {
      console.log(url, 'Err:', e.message);
    }
  }
}
checkFbProxies();
