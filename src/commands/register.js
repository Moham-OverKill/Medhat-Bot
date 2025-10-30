import { REST, Routes } from 'discord.js';

export async function registerSlashCommands(client) {
  const commands = [
    {
      name: 'mvp',
      description: 'Open the MVP control panel to configure and manage the MVP system',
      options: [
        {
          name: 'setup',
          description: 'Open the control panel to configure MVP settings',
          type: 1, // SUB_COMMAND
        }
      ]
    }
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('Started refreshing application (/) commands.');

    await rest.put(
      Routes.applicationCommands(client.application.id),
      { body: commands },
    );

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error registering slash commands:', error);
    throw error;
  }
}
