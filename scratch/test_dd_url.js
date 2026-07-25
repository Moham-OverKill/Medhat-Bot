function getActiveMediaUrl(targetUrl) {
  if (/(instagram\.com|instagr\.am)/i.test(targetUrl)) {
    return targetUrl.replace(/https?:\/\/(www\.)?(instagram\.com|instagr\.am)/i, 'https://ddinstagram.com');
  }
  return targetUrl;
}

console.log(getActiveMediaUrl('https://www.instagram.com/p/DbL49O4ACR8/'));
console.log(getActiveMediaUrl('https://instagram.com/reel/DbL49O4ACR8/'));
