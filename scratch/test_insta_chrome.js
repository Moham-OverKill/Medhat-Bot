async function inspectInstaMeta(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const text = await res.text();
    const titleMatch = text.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                       text.match(/<meta\s+name=["']title["']\s+content=["']([^"']+)["']/i) ||
                       text.match(/<title>([^<]+)<\/title>/i);
    const descMatch = text.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i) ||
                      text.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
    console.log('Title match:', titleMatch ? titleMatch[1] : 'null');
    console.log('Desc match:', descMatch ? descMatch[1] : 'null');
  } catch (e) {
    console.log('Err:', e.message);
  }
}

inspectInstaMeta('https://www.instagram.com/p/DbL49O4ACR8/');
