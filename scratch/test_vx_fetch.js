async function testVxInstaFetch(targetUrl) {
  const start = Date.now();
  try {
    const vxUrl = targetUrl.replace(/https?:\/\/(www\.)?(instagram\.com|instagr\.am)/i, 'https://vxinstagram.com');
    const res = await fetch(vxUrl, {
      headers: { 'User-Agent': 'facebookexternalhit/1.1' }
    });
    const html = await res.text();
    console.log(`[${Date.now() - start}ms] Status:`, res.status, 'HTML length:', html.length);
    const m = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
              html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
    console.log('Match:', m ? m[1] : 'null');
  } catch (e) {
    console.log(`[${Date.now() - start}ms] Err:`, e.message);
  }
}

testVxInstaFetch('https://www.instagram.com/p/DbL49O4ACR8/');
