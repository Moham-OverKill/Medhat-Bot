async function testInstaEmbedCaptioned(url) {
  const start = Date.now();
  try {
    const cleanUrl = url.split('?')[0].replace(/\/$/, '');
    const embedUrl = `${cleanUrl}/embed/captioned/`;
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const text = await res.text();
    console.log(`[${Date.now() - start}ms] Embed Captioned Status:`, res.status, 'Len:', text.length);
    const m = text.match(/<div\s+class=["']Caption["'][^>]*>([\s\S]*?)<\/div>/i) ||
              text.match(/CaptionCommentsContainer[^>]*>([\s\S]*?)<\/div>/i) ||
              text.match(/class=["']CaptionText["'][^>]*>([\s\S]*?)<\/span>/i);
    if (m) {
      console.log('Found Caption HTML:', m[1].replace(/<[^>]+>/g, '').trim());
    } else {
      console.log('No caption match, searching for text snippets...');
      const matches = text.match(/"caption":\s*\{\s*"text":\s*"([^"]+)"/i) || text.match(/"text":\s*"([^"]+)"/i);
      console.log('JSON Caption match:', matches ? matches[1] : 'null');
    }
  } catch (e) {
    console.log('Err:', e.message);
  }
}

testInstaEmbedCaptioned('https://www.instagram.com/p/DbL49O4ACR8/');
