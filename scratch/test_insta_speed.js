async function testFetchSpeed(url) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
      signal: controller.signal
    });
    clearTimeout(timeout);
    const text = await res.text();
    const elapsed = Date.now() - start;
    const match = text.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) || text.match(/<title>([^<]+)<\/title>/i);
    console.log(url, `[${elapsed}ms] Status:`, res.status, 'Title:', match ? match[1] : 'null');
  } catch (e) {
    console.log(url, `[${Date.now() - start}ms] Err:`, e.message);
  }
}

(async () => {
  await testFetchSpeed('https://www.kkinstagram.com/p/DbL49O4ACR8/');
  await testFetchSpeed('https://www.instagram.com/p/DbL49O4ACR8/');
})();
