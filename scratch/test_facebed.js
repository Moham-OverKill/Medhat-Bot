async function testFacebed() {
  const urls = [
    'https://www.facebed.com/reel/1957689215619341',
    'https://facebed.com/reel/1957689215619341',
    'https://www.facebed.com/watch/?v=1957689215619341'
  ];
  for (const u of urls) {
    try {
      const start = Date.now();
      const res = await fetch(u, { headers: { 'User-Agent': 'Discordbot/2.0 (+https://discordapp.com)' } });
      console.log(u, `[${Date.now() - start}ms] Status:`, res.status);
      if (res.ok) {
        const text = await res.text();
        const m = text.match(/<meta\s+property=["']og:video["']\s+content=["']([^"']+)["']/i) ||
                  text.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
        console.log('Match:', m ? m[1] : 'null');
      }
    } catch(e) {
      console.log(u, 'Err:', e.message);
    }
  }
}

testFacebed();
