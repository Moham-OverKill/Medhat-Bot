function cleanInstagramTitle(rawTitle) {
  if (!rawTitle) return '';
  let str = rawTitle
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\u200e|\u200f/g, '')
    .trim();

  // Remove "Name on Instagram:" or "Name on Instagram : "
  str = str.replace(/^[^\n:]+?\s+on\s+Instagram\s*:\s*/gi, '');

  // Remove surrounding quotes
  if (str.startsWith('"') && str.endsWith('"')) {
    str = str.slice(1, -1).trim();
  }

  // Reject generic Instagram fallbacks
  if (/Instagram photos and videos|Login • Instagram|Open in App/i.test(str)) {
    return '';
  }

  return str;
}

const example1 = 'Moham OverKill on Instagram&#x200e;: &quot;&#x627;&#x644;&#x646;&#x648;&#x631; &#x642;&#x637;&#x639; &#x641;&#x649; &#x646;&#x635; &#x627;&#x644;&#x644;&#x627;&#x64a;&#x641; #fyp&quot;&#x200e;';
console.log('Result 1:', cleanInstagramTitle(example1));

const example2 = 'Moham OverKill (@moham_overkill) • Instagram photos and videos';
console.log('Result 2:', cleanInstagramTitle(example2));
