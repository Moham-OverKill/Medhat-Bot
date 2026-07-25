async function inspectInstaFacebookUa(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
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

inspectInstaFacebookUa('https://www.instagram.com/p/DbL49O4ACR8/');
