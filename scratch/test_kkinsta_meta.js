async function fetchMeta(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' } });
    if (res.ok) {
      const html = await res.text();
      const titleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) || html.match(/<title>([^<]+)<\/title>/i);
      console.log(url, 'Title:', titleMatch ? titleMatch[1] : 'null');
    } else {
      console.log(url, 'Status:', res.status);
    }
  } catch (e) {
    console.log(url, 'Err:', e.message);
  }
}

(async () => {
  await fetchMeta('https://www.kkinstagram.com/p/DbL49O4ACR8/');
  await fetchMeta('https://www.instagram.com/p/DbL49O4ACR8/');
})();
