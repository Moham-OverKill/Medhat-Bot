
const testRegex = (text) => {
    try {
        const regex = /(?<!<@)(?<!<@&)(?<!\d)(\d{17,19})(?!\d)(?!>)/g;
        return text.replace(regex, '<@$1>');
    } catch (e) {
        return `Error: ${e.message}`;
    }
};

console.log('Test 1 (Standard):', testRegex('Awarded to 1234567890123456789'));
console.log('Test 2 (Mention):', testRegex('Awarded to <@1234567890123456789>'));
console.log('Test 3 (Special Chars):', testRegex('☆𝓟𝓻𝓲𝓷𝓬𝓮𝓼𝓼_𝓳𝓲𝓷𝓸𝓾 ☆ 1234567890123456789'));
console.log('Test 4 (Null):', testRegex(null));
console.log('Test 5 (Large Number):', testRegex('1'.repeat(100)));
