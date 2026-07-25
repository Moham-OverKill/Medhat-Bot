function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\u200e/g, '')
    .trim();
}

const testTitle = 'Moham OverKill on Instagram&#x200e;: &quot;&#x627;&#x644;&#x646;&#x648;&#x631; &#x642;&#x637;&#x639; &#x641;&#x649; &#x646;&#x635; &#x627;&#x644;&#x644;&#x627;&#x64a;&#x641;&quot;';
console.log('Decoded:', decodeHtmlEntities(testTitle));

const instaUrl = 'https://www.instagram.com/p/DbL49O4ACR8/';
const mediaUrl = instaUrl.replace(/https?:\/\/(www\.)?instagram\.com/i, 'https://www.kkinstagram.com');
console.log('Media URL:', mediaUrl);
