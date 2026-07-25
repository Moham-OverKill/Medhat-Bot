async function testFastInsta(postUrl) {
  const providers = [
    `https://kxinstagram.com/oembed?url=${encodeURIComponent(postUrl)}`,
    `https://vxinstagram.com/oembed?url=${encodeURIComponent(postUrl)}`,
    `https://igp.app/oembed?url=${encodeURIComponent(postUrl)}`
  ];

  for (const p of providers) {
    const start = Date.now();
    try {
      const res = await fetch(p);
      if (res.ok) {
        const data = await res.json();
        console.log(p, `[${Date.now() - start}ms] Title:`, data.title || data.description || data.author_name);
        return;
      }
    } catch (e) {
      console.log(p, `[${Date.now() - start}ms] Err:`, e.message);
    }
  }
}

(async () => {
  await testFastInsta('https://www.instagram.com/p/DbL49O4ACR8/');
})();
