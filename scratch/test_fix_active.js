function fixActiveUrl(url) {
  if (/(instagram\.com|instagr\.am)/i.test(url)) {
    return url.replace(/https?:\/\/(www\.)?(instagram\.com|instagr\.am)/i, 'https://kkinstagram.com');
  }
  return url;
}

console.log(fixActiveUrl('https://www.instagram.com/p/DbL49O4ACR8/'));
console.log(fixActiveUrl('https://instagram.com/p/DbL49O4ACR8/'));
console.log(fixActiveUrl('https://www.instagram.com/reel/DbL49O4ACR8/'));
