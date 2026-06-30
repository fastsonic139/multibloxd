# Publish MULTIBLOXD worldwide

The game is configured as one public Node.js web service. Every player who opens
the same public URL shares one matchmaking queue.

## Render deployment

1. Put this folder in a GitHub, GitLab, or Bitbucket repository.
2. In Render, choose **New > Blueprint** and select that repository.
3. Render detects `render.yaml`. Apply the `multibloxd` service.
4. When deployment finishes, share the generated `https://...onrender.com` URL.
5. Players open that URL, click into the game, and press **F6**.

The browser automatically uses encrypted `wss://` multiplayer on the public URL.
Keep `numInstances: 1`: matchmaking is held in memory, so multiple instances
would create separate queues. Upgrade the single instance size if usage grows.

The included Blueprint starts on Render's free instance for easy testing. Free
instances sleep after 15 minutes with no incoming HTTP or WebSocket traffic, so
the first visitor after a quiet period may wait for it to wake. Change
`plan: free` to `plan: starter` for an always-on public game.

## Other hosts

`Dockerfile` works with Railway, Fly.io, Google Cloud Run, Azure Container Apps,
and other hosts that support WebSockets. Deploy one container, expose its HTTP
port, and enable HTTPS. The server reads the host-provided `PORT` automatically.

## Local testing

Double-click `start-multiplayer.bat`, then open `http://localhost:8080`.
