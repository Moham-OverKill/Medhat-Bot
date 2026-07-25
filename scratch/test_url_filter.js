// Test social media URL classification
function isMediaPostUrl(url) {
  if (!url) return false;
  
  // Instagram: must contain /p/, /reel/, /reels/, /tv/
  if (/(instagram\.com|instagr\.am)/i.test(url)) {
    return /\/(p|reel|reels|tv)\/[\w-]+/i.test(url);
  }

  // TikTok: must contain /video/ or /photo/ or /v/
  if (/tiktok\.com/i.test(url)) {
    return /\/(video|photo|v)\/\d+/i.test(url) || /vt\.tiktok\.com/i.test(url);
  }

  // YouTube: must contain watch?v=, /shorts/, or youtu.be/
  if (/(youtube\.com|youtu\.be)/i.test(url)) {
    return /(watch\?v=|\/shorts\/|youtu\.be\/)/i.test(url);
  }

  // Twitter/X: must contain /status/
  if (/(twitter\.com|x\.com)/i.test(url)) {
    return /\/status\/\d+/i.test(url);
  }

  return true;
}

console.log('Insta Profile:', isMediaPostUrl('https://www.instagram.com/moham_overkill'));
console.log('Insta Post:', isMediaPostUrl('https://www.instagram.com/p/DbL49O4ACR8/'));
console.log('Insta Reel:', isMediaPostUrl('https://www.instagram.com/reel/C6_12345/'));
console.log('TikTok Profile:', isMediaPostUrl('https://www.tiktok.com/@moham_overkill'));
console.log('TikTok Video:', isMediaPostUrl('https://www.tiktok.com/@user/video/123456789'));
