const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

try {
    const modal = new ModalBuilder()
        .setCustomId('test')
        .setTitle('Adjust Balance: ☆𝓟𝓻𝓲𝓷𝓬𝓮𝓼𝓼_𝓳𝓲𝓷𝓸𝓾 ☆'); // Length is 33
    console.log('Title length:', 'Adjust Balance: ☆𝓟𝓻𝓲𝓷𝓬𝓮𝓼𝓼_𝓳𝓲𝓷𝓸𝓾 ☆'.length);

    const input = new TextInputBuilder()
        .setCustomId('new_balance')
        .setLabel('New Exact Balance')
        .setStyle(TextInputStyle.Short);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    console.log('Modal built successfully.');
} catch (e) {
    console.log('Error 1:', e.name, e.message);
}

try {
    const modal2 = new ModalBuilder()
        .setCustomId('test')
        .setTitle('12345678901234567890123456789012345678901234567890'); // 50 chars
    
    console.log('Modal 2 built successfully.');
} catch (e) {
    console.log('Error 2:', e.name, e.message);
}
