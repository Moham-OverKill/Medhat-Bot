async function fetchInstaTitleFast(targetUrl) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);

    const kkUrl = targetUrl.replace(/https?:\/\/(www\.)?(instagram\.com|instagr\.am)/i, 'https://kkinstagram.com');

    const res = await fetch(kkUrl, {
      headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
      signal: controller.signal
    });

    clearTimeout(timeout);
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                    html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
      console.log(`[${Date.now() - start}ms] Raw Title:`, match ? match[1] : 'null');
    }
  } catch (e) {
    console.log(`[${Date.now() - start}ms] Fetch err:`, e.message);
  }
}

fetchInstaTitleFast('https://www.instagram.com/p/DbL49O4ACR8/');
