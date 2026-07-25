async function inspectKkInstaHtml(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Discordbot/2.0 (+https://discordapp.com)' } });
    const text = await res.text();
    console.log('HTML length:', text.length);
    const metaMatches = text.match(/<meta[^>]+>/gi) || [];
    metaMatches.forEach(m => {
      if (m.includes('og:') || m.includes('twitter:') || m.includes('description') || m.includes('title')) {
        console.log('META:', m);
      }
    });
    const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
    console.log('TITLE:', titleMatch ? titleMatch[1] : 'NONE');
  } catch (e) {
    console.log('Err:', e.message);
  }
}

inspectKkInstaHtml('https://www.kkinstagram.com/p/DbL49O4ACR8/');
