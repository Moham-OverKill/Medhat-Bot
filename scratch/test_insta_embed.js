async function testInstaEmbed(url) {
  const start = Date.now();
  try {
    const cleanUrl = url.split('?')[0].replace(/\/$/, '');
    const embedUrl = `${cleanUrl}/embed/`;
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const text = await res.text();
    console.log(`[${Date.now() - start}ms] Status:`, res.status, 'Len:', text.length);
    const titleMatch = text.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                       text.match(/<title>([^<]+)<\/title>/i);
    console.log('Title Match:', titleMatch ? titleMatch[1] : 'null');
  } catch (e) {
    console.log('Err:', e.message);
  }
}

testInstaEmbed('https://www.instagram.com/p/DbL49O4ACR8/');
