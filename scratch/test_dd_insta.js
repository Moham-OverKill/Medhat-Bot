async function testDdInsta(url) {
  const start = Date.now();
  try {
    const ddUrl = url.replace(/https?:\/\/(www\.)?(instagram\.com|instagr\.am)/i, 'https://ddinstagram.com');
    const res = await fetch(ddUrl, {
      headers: { 'User-Agent': 'facebookexternalhit/1.1' }
    });
    const text = await res.text();
    console.log(`[${Date.now() - start}ms] Status:`, res.status, 'Len:', text.length);
    const m = text.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
              text.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
    console.log('Match:', m ? m[1] : 'null');
  } catch (e) {
    console.log('Err:', e.message);
  }
}

testDdInsta('https://www.instagram.com/p/DbL49O4ACR8/');
