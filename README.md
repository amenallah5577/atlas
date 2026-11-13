<div align="center">
  <img src="public/atlas-mark.svg" alt="EchoSphere Atlas logo" width="76" height="76">
  <h1>EchoSphere Atlas</h1>
  <p>Chat naturally. Research with evidence. Keep the conversation going.</p>

  <a href="https://github.com/amenallah5577/atlas/actions/workflows/tests.yml"><img src="https://github.com/amenallah5577/atlas/actions/workflows/tests.yml/badge.svg?branch=main" alt="Atlas checks"></a>
  <img src="https://img.shields.io/badge/Node.js-20.19%2B-339933?logo=node.js&logoColor=white" alt="Node.js 20.19 or newer">
  <img src="https://img.shields.io/badge/Express-vanilla_JS-222222" alt="Express and vanilla JavaScript">
</div>

**Atlas is the upgraded, chat-first version of [EchoSphere](https://github.com/amenallah5577/EchoSphere).** Ask a question, write something, explore jobs, compare products, or analyze a PDF from the same conversation.

**[Open the live Atlas app](https://echosphere-atlas.onrender.com/).** The hosted standalone app opens Atlas at `/` and `/atlas`. With the default local configuration, Atlas opens at `/atlas` and the original EchoSphere interface remains at `/`.

[Getting started](#getting-started) · [Model configuration](#model-configuration) · [Accounts and administration](#accounts-and-administration) · [Documentation](#documentation)

## What you can do

| Capability | How it works |
| --- | --- |
| General chat | Ask questions, explain ideas, and draft text without selecting a special mode or triggering unnecessary searches. |
| Web research | Retrieve evidence, inspect supporting passages, and follow citations inside the answer. |
| Jobs | Search vacancies and inspect sourced requirements, location, salary periods, and posting information when available. |
| Marketplace | Research products and offers with explicit variants, currencies, availability, and delivery information when supported by sources. |
| PDFs | Attach a text-readable PDF up to 5 MB and ask questions with page-referenced evidence. |
| Follow-ups | Continue with server-owned conversation context and previously saved evidence. |
| History and exports | Search, archive, restore, delete, download Markdown, or print conversations to PDF. |

Jobs, Marketplace, and Attach PDF sit beside the composer. Contextual filters appear when relevant, and comparisons support up to three results.

### A calmer interface

Warm ivory and graphite themes, teal accents, a custom EchoSphere mark, subtle background motion, and smooth menu transitions. History visibility is remembered. Reduced motion, text size, keyboard navigation, and a single-column mobile layout keep the interface adaptable.

### Accounts that keep your context

- Email/password registration and login, editable display names, and profile photos.
- Google, GitHub, and Microsoft sign-in integrations, enabled when their credentials are configured.
- Active-session management, password changes, account export, and account deletion.
- General, Appearance, Notifications, Profile, Security and login, Account, Archived chats, Parental controls, Safety & wellbeing, Storage, and Data controls.
- An owner-only dashboard for reviewing saved account activity, recording moderation notes, suspending accounts, and managing registration and research availability.

## Getting started

For hosting, see the [Render deployment guide](docs/deployment.md). The included Blueprint creates a separate Atlas service with persistent MongoDB storage and an Atlas homepage at `/`.

**Requirements:** Node.js 20.19 or newer, npm, and a running MongoDB instance for the standard setup. CI runs on Node.js 22.

```powershell
git clone https://github.com/amenallah5577/atlas.git
cd atlas
npm ci
Copy-Item .env.example .env
```

On macOS or Linux, use `cp .env.example .env` instead of `Copy-Item`.

Edit `.env` with your database connection and a stable, randomly generated session secret:

```dotenv
PORT=3000
MONGODB_URI=mongodb://127.0.0.1:27017/atlas
SESSION_SECRET=replace-with-a-long-random-secret
ATLAS_STORAGE=mongodb
ATLAS_PUBLIC_URL=http://127.0.0.1:3000
```

Generate a session secret locally:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Choose a model configuration below, then start the application:

```sh
npm start
```

Open **[http://127.0.0.1:3000/atlas](http://127.0.0.1:3000/atlas)**. Use the same origin in `ATLAS_PUBLIC_URL` and your OAuth callback settings.

If you do not have MongoDB, the personal-development option below uses local JSON storage. Atlas returns an explicit unavailable response when a required database or provider is missing; copying `.env.example` alone does not configure those services.

## Model configuration

Atlas supports a local model or explicitly confirmed free-plan cloud providers. It does not switch to a paid fallback when a provider is unavailable or a quota is exhausted.

### Option A: local Ollama

Install [Ollama](https://docs.ollama.com/quickstart), download the default local model, and keep the Ollama service running:

```sh
ollama pull qwen3.5:4b
ollama pull qwen3.5:9b
```

If the service is not already running, start it in another terminal with `ollama serve`.

```dotenv
ATLAS_LLM_PROVIDER=ollama
ATLAS_OLLAMA_QUICK_MODEL=qwen3.5:4b
ATLAS_OLLAMA_DETAILED_MODEL=qwen3.5:9b
```

General chat and PDF analysis use the loopback Ollama API without a cloud model key. To run Atlas without MongoDB for personal development, also set:

```dotenv
ATLAS_STORAGE=local
MONGODB_URI=
```

This stores Atlas accounts, history, and preferences in the ignored `.atlas-data/store.json` file. Keep `SESSION_SECRET` stable and back up this directory. Local storage supports one server process and is rejected in production. The retained original EchoSphere interface still needs its own database configuration.

Web, job, and marketplace searches additionally require `ATLAS_TAVILY_API_KEY` and `ATLAS_FREE_PROVIDERS_CONFIRMED=true` after confirming a free Tavily account with paid overages disabled.

### Option B: Groq and Tavily

```dotenv
ATLAS_LLM_PROVIDER=groq
ATLAS_GROQ_API_KEY=your-free-plan-groq-key
ATLAS_TAVILY_API_KEY=your-free-tier-tavily-key
ATLAS_FREE_PROVIDERS_CONFIRMED=true
```

Quick uses `openai/gpt-oss-20b` with low reasoning effort; Detailed uses `openai/gpt-oss-120b` with high reasoning effort. Detailed also retains more conversation context and allows a larger final answer. Only set the confirmation flag after checking the provider accounts and billing settings. Keys do not disclose an account's billing plan to Atlas; provider-side limits and charges remain controlled by those accounts.

| Workflow | Search budget | Inspected pages | Model calls | Time budget |
| --- | --- | --- | --- | --- |
| Quick chat | None | None | 1 | 60 seconds |
| Detailed chat | None | None | 1 | 120 seconds |
| Quick research | 1 | Up to 5 | Up to 2 | 60 seconds |
| Detailed research | 3 | Up to 8 | Up to 3 | 120 seconds |

Quick research performs a focused search and a source-validated answer. Detailed research plans three complementary angles, synthesizes the evidence, and runs a separate review pass. If review cannot finish, the validated answer is retained with an incomplete-review label. Retries, repair, planning, and review share the workflow budget. Reopening a saved chat does not make a model request. Research also uses application quotas and bounded concurrency; see [Atlas setup](docs/atlas.md) for the operating details.

### Optional OpenRouter free models

Set `ATLAS_LLM_PROVIDER=openrouter`, `ATLAS_OPENROUTER_API_KEY`, and the free-account confirmation flag. The server accepts only explicit `:free` model IDs, verifies zero pricing against the current model catalogue, and sends a zero-price ceiling with provider fallbacks disabled. Defaults are Gemma 4 26B A4B for Quick and Nemotron 3 Ultra for Detailed; availability can change. See [.env.example](.env.example) for the server-only model settings.

Run `npm run models:check` to verify the configured model IDs are available without sending an inference request. Model IDs and the mode used are recorded with each saved answer.

## Accounts and administration

Email/password signup works once Atlas storage is available. Users accept the [Terms and Conditions](public/atlas-terms.html), whose final section explains owner moderation and retained activity logs.

To provision the owner, set `ATLAS_OWNER_EMAIL` in `.env`, then run:

```sh
node scripts/atlas-owner.js
```

The script creates the owner and writes generated access details into the ignored `.atlas-data/owner-access.txt` file. Sign in at `/atlas`, change the generated password in Settings, and open `/atlas/admin`. Retain the generated `ATLAS_OWNER_ID`; admin access is based on this server-controlled ID.

Social sign-in requires app credentials from each provider. Set the corresponding `ATLAS_GOOGLE_*`, `ATLAS_GITHUB_*`, or `ATLAS_MICROSOFT_*` values and register the exact callback URLs listed in [the OAuth setup guide](docs/atlas.md#social-sign-in). Unconfigured options remain disabled. Accounts are linked explicitly rather than merged by matching email addresses.

## Tests and evaluation

```sh
npm test
npm run check
npm run eval:check
```

The current automated suite contains **106 tests** covering model routing, free quota handling, research review, passage relevance, bounded evidence repair, conversation context, evidence validation, PDF parsing, account isolation, OAuth callbacks, profile photos, preferences, session revocation, parental PIN controls, archives, exports, and deletion races.

[GitHub Actions](https://github.com/amenallah5577/atlas/actions) runs installation, syntax checks, tests, and the evaluation dry run on pushes and pull requests. The [evaluation guide](eval/README.md) explains the fixed-source research benchmark. Fixture results do not establish live search accuracy or production readiness.

## Deployment notes and current limits

- Hosted deployments require MongoDB, HTTPS, stable secrets, owner provisioning, and the selected provider credentials. A GitHub push does not configure or deploy these services.
- The public preview uses a Render Free service and MongoDB Atlas Free storage. Render can take about a minute to wake after inactivity. This service is deployed manually after the GitHub checks pass; see the [deployment guide](docs/deployment.md).
- Use one Express process with the current in-memory research coordinator and cancellation state.
- PDFs are processed in memory; saved answers retain relevant excerpts. Scanned PDFs need OCR before they can be meaningfully analyzed.
- Parental controls protect this account's browsing and upload settings with a PIN. The explicit-content text filter is limited, and separate parent/child account linking is not implemented.
- Browser notifications require permission and an open Atlas tab. Email verification and email-based password recovery require additional email-service integration.
- Atlas can make mistakes. Check the supporting sources and original listings before relying on an answer.

## Documentation

| Resource | Contents |
| --- | --- |
| [Atlas setup](docs/atlas.md) | Storage, providers, owner provisioning, OAuth, settings, and operational limits |
| [Evaluation guide](eval/README.md) | Dataset, scoring, benchmark commands, and interpretation |
| [Historical engineering notes](docs/engineering.md) | Design and verification notes for the EchoSphere foundation |
| [Environment template](.env.example) | Server-side configuration variables |

Built on [EchoSphere](https://github.com/amenallah5577/EchoSphere), with Atlas-specific UI, account services, research routing, and `/api/atlas/*` endpoints.
