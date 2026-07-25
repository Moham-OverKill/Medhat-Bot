async function testVxInstaMeta(url) {
  try {
    const vxUrl = url.replace(/https?:\/\/(www\.)?(instagram\.com|instagr\.am)/i, 'https://www.vxinstagram.com');
    const res = await fetch(vxUrl, {
      headers: { 'User-Agent': 'TelegramBot (like TwitterBot)' }
    });
    const text = await res.text();
    const titleMatch = text.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                       text.match(/<title>([^<]+)<\/title>/i);
    const descMatch = text.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
    console.log('Vx Insta Title:', titleMatch ? titleMatch[1] : 'null');
    console.log('Vx Insta Desc:', descMatch ? descMatch[1] : 'null');
  } catch (e) {
    console.log('Err:', e.message);
  }
}

testVxInstaMeta('https://www.instagram.com/p/DbL49O4ACR8/');
