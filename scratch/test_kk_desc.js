async function testKkDescription(url) {
  try {
    const res = await fetch('https://www.kkinstagram.com/p/DbL49O4ACR8/', {
      headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' }
    });
    const text = await res.text();
    const matches = text.match(/<meta[^>]+>/gi) || [];
    matches.forEach(m => {
      if (m.includes('og:') || m.includes('description')) {
        console.log('META:', m);
      }
    });
  } catch (e) {
    console.log('Err:', e.message);
  }
}

testKkDescription();
