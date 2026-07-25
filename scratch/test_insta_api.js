async function testInstaTitleApis(postUrl) {
  // Test 1: ddinstagram oembed API
  try {
    const res = await fetch(`https://ddinstagram.com/oembed?url=${encodeURIComponent(postUrl)}`);
    if (res.ok) {
      const data = await res.json();
      console.log('ddinstagram oembed:', data.title || data.author_name);
    } else {
      console.log('ddinstagram status:', res.status);
    }
  } catch (e) {
    console.log('ddinstagram err:', e.message);
  }

  // Test 2: kkinstagram page fetch
  try {
    const res = await fetch(postUrl.replace('instagram.com', 'kkinstagram.com'), {
      headers: { 'User-Agent': 'TelegramBot (like TwitterBot)' }
    });
    if (res.ok) {
      const text = await res.text();
      const m = text.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) || text.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
      console.log('kkinstagram Telegram UA:', m ? m[1] : 'null');
    }
  } catch (e) {
    console.log('kkinstagram err:', e.message);
  }
}

(async () => {
  await testInstaTitleApis('https://www.instagram.com/p/DbL49O4ACR8/');
})();
