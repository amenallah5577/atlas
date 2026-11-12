# EchoSphere Atlas

An upgraded version of [EchoSphere](https://github.com/amenallah5577/EchoSphere), built around a general-purpose chat assistant with optional research tools.

Atlas lives at **/atlas**. The original EchoSphere application remains included at the root route.

## Features

- Chat-first interface with optional Jobs, Marketplace, and PDF tools.
- Evidence passages, citations, product/job comparisons, saved conversations, and exports.
- Light and dark themes, animated backgrounds, and responsive account/settings controls.
- Email/password accounts, editable profile names and photos, session management, and private history.
- Google, GitHub, and Microsoft sign-in integrations; provider credentials are required to activate them.
- Account preferences, archived chats, parental PIN controls, storage summaries, and data export/deletion.
- Owner-only moderation dashboard at /atlas/admin.
- Free-only model configuration: local Ollama or explicitly confirmed free-plan Groq/Tavily accounts, without a paid fallback.

## Run locally

Requires Node.js 20.19 or newer and MongoDB for the normal server configuration.

~~~powershell
git clone https://github.com/amenallah5577/atlas.git
cd atlas
npm ci
Copy-Item .env.example .env
~~~

Edit the ignored .env with a working MONGODB_URI and a stable SESSION_SECRET. Configure the model/search providers described in [Atlas setup](docs/atlas.md), then run:

~~~powershell
npm start
~~~

Open http://localhost:3000/atlas (or the PORT configured in .env).

For personal development, Atlas also supports explicitly selected local JSON storage and installed Ollama models. See [the setup guide](docs/atlas.md) for the configuration, owner provisioning, and OAuth callbacks. Local JSON storage is rejected in production.

## Verify

~~~powershell
npm test
npm run check
~~~

The suite covers routing, evidence validation, account isolation, OAuth security, preferences, profile photos, sessions, parental controls, archives, exports, and deletion races.

## Configuration and data

This repository contains source code and configuration examples. Real provider credentials, environment files, local databases, uploaded account photos, owner passwords, dependencies, and local test-server data are excluded.

OAuth credentials and provider free-plan confirmation must be configured by the operator. Parental controls apply to the current account and use a limited text filter. Read [Atlas setup](docs/atlas.md) for operational details and limits.
