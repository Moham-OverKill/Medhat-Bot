function getActiveMediaUrl(targetUrl) {
  if (/(instagram\.com|instagr\.am)/i.test(targetUrl)) {
    // Replace instagram.com or www.instagram.com with kkinstagram.com
    return targetUrl.replace(/https?:\/\/(www\.)?(instagram\.com|instagr\.am)/i, 'https://kkinstagram.com');
  }
  return targetUrl;
}

console.log('Active Media URL:', getActiveMediaUrl('https://www.instagram.com/p/DbL49O4ACR8/'));
console.log('Reel URL:', getActiveMediaUrl('https://instagram.com/reel/C6_12345678/'));
