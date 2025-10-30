# Railway Deployment Guide

## Quick Deployment Steps

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Initial Discord MVP bot"
   git branch -M main
   git remote add origin <your-github-repo-url>
   git push -u origin main
   ```

2. **Deploy on Railway**
   - Go to [railway.app](https://railway.app)
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your repository
   - Railway will automatically detect the Node.js project

3. **Set Environment Variable**
   - In your Railway project, go to "Variables"
   - Add: `DISCORD_TOKEN` = `your_discord_bot_token_here`

4. **Deploy**
   - Railway will automatically build and deploy
   - Your bot will be online once the deployment completes

## Required Environment Variables

- `DISCORD_TOKEN`: Your Discord bot token (required)

## Optional Environment Variables

- `PORT`: HTTP server port (defaults to 3000, Railway sets this automatically)

## What Railway Does Automatically

- Detects Node.js project from `package.json`
- Runs `npm install` during build
- Starts with `npm start` command
- Provides health checks via the HTTP server
- Handles restarts and scaling

## Bot Permissions Required

Make sure your Discord bot has these permissions in the servers you want to use it:
- View Channels
- Send Messages
- Manage Roles
- Read Message History
- Connect to Voice
- Speak

## After Deployment

1. Invite your bot to your Discord server
2. Use `/mvp setup` in any server to configure the MVP system
3. The bot will start tracking activity immediately

## Troubleshooting

If the bot doesn't start:
1. Check that `DISCORD_TOKEN` is set correctly in Railway variables
2. Check the deployment logs in Railway dashboard
3. Ensure your bot has the proper Discord intents enabled in the Discord Developer Portal
