# Discord MVP Bot

A production-ready Discord bot that tracks member activity (messages and voice) and awards MVP roles on a configurable schedule.

## Features

- **Activity Tracking**: Monitors messages and voice participation per member
- **Smart Scoring**: Messages (1 point each with 5s cooldown) + Voice minutes (1 point per minute when eligible)
- **Configurable Scheduling**: Choose from hourly, 12-hour, daily, or weekly MVP awards
- **Ephemeral Control Panel**: Single slash command with clean UI that edits the same message
- **Role Management**: Automatically assigns and removes MVP roles
- **Announcement System**: Posts formatted MVP announcements with user mentions
- **Stats & Leaderboard**: View current activity and top 10 leaderboard
- **Resilient Design**: Handles permission errors, missing data, and edge cases gracefully

## Quick Start

1. Set your `DISCORD_TOKEN` environment variable
2. Run `npm start`
3. Use `/mvp setup` in any server to configure the bot

## Environment Variables

Required:
- `DISCORD_TOKEN`: Your Discord bot token

Optional:
- `PORT`: HTTP server port (defaults to 3000)

## Bot Permissions

The bot requires these permissions:
- View Channels
- Send Messages  
- Manage Roles
- Read Message History
- Connect to Voice
- Speak (for voice state tracking)

## Configuration

Use `/mvp setup` to configure:
- **MVP Role**: Select which role to assign to winners
- **Announcement Channel**: Choose where MVP announcements are posted
- **Schedule**: Set award frequency (1h, 12h, 24h, or 1w)
- **Winners**: Choose how many members get MVP (1-5)

## Scoring System

**Messages**: 1 point per message (5-second cooldown per user)
**Voice**: 1 point per full minute when:
- Member is not self-muted/deafened
- Voice channel has ≥2 eligible humans
- Voice tracking pauses/resumes automatically based on conditions

Tie-breaking: Most recently active member wins

## Deployment

The bot includes an HTTP keepalive server for platforms like Railway. Simply deploy with your DISCORD_TOKEN set as an environment variable.
