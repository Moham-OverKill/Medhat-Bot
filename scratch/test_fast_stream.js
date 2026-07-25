async function fetchFastOgTitle(url) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200); // 1.2s timeout

    const fetchUrl = /(instagram\.com|instagr\.am)/i.test(url)
      ? url.replace(/https?:\/\/(www\.)?(instagram\.com|instagr\.am)/i, 'https://www.kkinstagram.com')
      : url;

    const res = await fetch(fetchUrl, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Range': 'bytes=0-30000'
      },
      signal: controller.signal
    });

    if (!res.ok && res.status !== 206) {
      clearTimeout(timeout);
      return null;
    }

    // Read only the first 30KB of the stream to avoid downloading megabytes
    const reader = res.body.getReader();
    let text = '';
    const decoder = new TextDecoder();

    while (text.length < 30000) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes('</head>')) break;
    }

    controller.abort(); // Close remaining stream
    clearTimeout(timeout);

    const elapsed = Date.now() - start;
    console.log(`Fetch completed in ${elapsed}ms (read ${text.length} chars)`);

    const titleMatch = text.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                       text.match(/<title>([^<]+)<\/title>/i);
    return titleMatch ? titleMatch[1] : null;
  } catch (e) {
    console.log('Fast fetch failed:', e.message);
    return null;
  }
}

(async () => {
  const title = await fetchFastOgTitle('https://www.instagram.com/p/DbL49O4ACR8/');
  console.log('Result Title:', title);
})();
