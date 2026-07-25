async function checkFbDomains() {
  const domains = [
    'https://fxfb.com',
    'https://ezfb.com',
    'https://fixfb.com',
    'https://facebook.gcp.fxtwitter.com',
    'https://fixupfacebook.com'
  ];
  for (const url of domains) {
    try {
      const start = Date.now();
      const res = await fetch(url, { headers: { 'User-Agent': 'Discordbot/2.0' } });
      console.log(url, `[${Date.now() - start}ms] Status:`, res.status);
    } catch (e) {
      console.log(url, 'Err:', e.message);
    }
  }
}
checkFbDomains();
