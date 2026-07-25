async function testFxFb() {
  const urls = [
    'https://fxfb.com/reel/123456789/',
    'https://www.fxfb.com/watch/?v=123456789'
  ];
  for (const u of urls) {
    try {
      const res = await fetch(u, { headers: { 'User-Agent': 'TelegramBot (like TwitterBot)' } });
      console.log(u, 'Status:', res.status);
    } catch(e) {
      console.log(u, 'Err:', e.message);
    }
  }
}
testFxFb();
