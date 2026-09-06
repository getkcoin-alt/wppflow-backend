# WppFlow Core Backend Engine

Production-grade multi-session WhatsApp automation backend orchestrating Chromium instances with `@wppconnect-team/wppconnect`, WebSockets, and persistent token storage.

## Features
* **Multi-Session Orchestration**: Run multiple isolated WhatsApp Web sessions.
* **Persistent Token Volume**: Retains WhatsApp Web credentials across container redeployments and restarts (`/app/tokens`).
* **Real-time WebSockets**: Emits QR codes, status events, and message events to frontend clients.
* **RESTful API**: Endpoints to send messages, buttons, list chats, and monitor health.
* **Optimized Headless Chromium**: Configured with `--no-sandbox` and `dumb-init` process supervisor.

## Deployment on Railway
Built with custom Dockerfile and attached Persistent Volume at `/app/tokens`.
