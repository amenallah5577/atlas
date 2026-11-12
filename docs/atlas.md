# Atlas setup

Atlas is served at `/atlas` with its own `/api/atlas/*` endpoints and native email/password accounts. It uses the configured MongoDB connection by default, or explicitly selected local JSON storage for personal development. Native Atlas sessions override the inherited guest/account profile for Atlas requests; the original EchoSphere routes retain their existing behavior.

Set the following server environment variables for Atlas. Put the provider keys in Render's environment settings or an ignored local `.env` file.

| Variable | Value |
| --- | --- |
| `MONGODB_URI` | Working MongoDB connection string |
| `SESSION_SECRET` | Stable signing secret for guest sessions |
| `ATLAS_GROQ_API_KEY` | Dedicated key from a Groq Free-plan account |
| `ATLAS_TAVILY_API_KEY` | Dedicated Tavily free-tier key with paid overages disabled |
| `ATLAS_FREE_PROVIDERS_CONFIRMED` | Set to `true` after confirming both provider accounts above |

Atlas reserves up to 900 basic Tavily searches per UTC calendar month and applies model request and token limits. Provider limits still apply to the entire provider account. The free-plan confirmation is an operator setting. A provider key does not identify the account's billing plan to Atlas.

Run `npm ci`, then `npm start`. Open `http://localhost:3000/atlas`. Run `node --test test/atlas.test.js` for the Atlas fixture evaluation and HTTP workflow. `npm test` includes those checks together with the account, settings, and inherited EchoSphere tests.

For a hosted smoke test, open Atlas in two guest sessions, send an ordinary message and one small research request, reopen the results, and verify the sessions see only their own history. Run the same check with native Atlas accounts, then test each OAuth provider you have configured. Measure live extraction and citation quality with reviewed results before treating the fixture scores as production accuracy.

## Free local model

Atlas also supports installed Ollama models for personal use. Start `ollama serve`, then set these variables in the ignored local `.env` file.

```dotenv
ATLAS_LLM_PROVIDER=ollama
ATLAS_OLLAMA_QUICK_MODEL=qwen3.5:4b
ATLAS_OLLAMA_DETAILED_MODEL=qwen3.5:9b
ATLAS_STORAGE=local
SESSION_SECRET=your_stable_random_secret
```

Run `npm start`. Local mode uses the fixed loopback Ollama API and stores conversations and usage counters in the ignored `.atlas-data/store.json` file. Keep the signing secret stable to retain access to guest conversations after restarting. This storage mode is for one local server process and is rejected in production. Hosted deployments retain MongoDB.

Ordinary chat and PDF analysis need no cloud model key in this mode. Web, job, and shopping searches still require a confirmed free-tier Tavily key. The UI runs against the real application server when started with `npm start`. The `fixtureApp` export is only for isolated interface tests.

## Accounts and owner administration

Atlas has its own email/password account system. Passwords use salted scrypt hashes. Opaque session tokens are stored as hashes in the database, expire automatically, and are revoked after logout, password changes, and account suspension. Production cookies require HTTPS.

Configure MongoDB and a stable `SESSION_SECRET` before starting the standard setup. A local connection can use `mongodb://127.0.0.1:27017/atlas`; use the actual host and port of your MongoDB server. Back up the database or its persistent volume. Use a hosted MongoDB connection for public deployment, or select local storage only for personal development.

Set `ATLAS_OWNER_EMAIL` to the owner's chosen email and run:

```powershell
node scripts/atlas-owner.js
```

The script provisions the owner, writes `ATLAS_OWNER_ID` into the ignored local environment file, and saves a generated password in the ignored `.atlas-data/owner-access.txt` file. Sign in at `/atlas`, change the generated password in Your account, and open `/atlas/admin`. Keep the configured owner ID stable. Admin access is decided by that server setting, never by a role supplied during signup.

To import an existing local Atlas store into the configured MongoDB database, stop the application and run `node scripts/atlas-owner.js --import-local`. Import uses insert-only upserts and retains the source file.

The owner dashboard can filter account histories, read complete saved conversations, record private review notes, suspend accounts, and pause registration or live research. Session versions prevent an in-flight old-password login from remaining valid after a password change or suspension. The protected HTML template resides outside the public directory. Every admin API independently checks the owner identity.

Registration requires acceptance of Terms and Conditions. Its final section explains owner review of saved conversations and retained activity records. Submitted account requests and owner actions are audited. Conversation deletion removes the saved conversation while activity records remain for moderation.

Atlas can run locally with Ollama and MongoDB, or with the explicit local-storage development option. Public hosting needs its own MongoDB connection, HTTPS, stable session secret, owner ID, and confirmed free-plan Groq/Tavily keys. Email verification and email-based password recovery require a separate email delivery configuration. Password changes are available inside signed-in accounts.

## Social sign-in

Atlas supports Google (including Gmail), GitHub, and Microsoft through server-side authorization-code flows using `openid-client`. Requires Node 20.19 or newer. No authentication subscription is required. Provider app credentials must be created in the owner's provider developer accounts; unconfigured buttons stay disabled. Email/password sign-in remains available.

Set `ATLAS_PUBLIC_URL` to the exact site origin (for example `https://atlas.example.com`, or `http://127.0.0.1:3000` locally). Production requires HTTPS. Register these exact callback URLs in the corresponding provider app, replacing the origin as needed:

| Provider | Callback path | Server environment variables |
| --- | --- | --- |
| [Google](https://developers.google.com/identity/protocols/oauth2/web-server) | `/api/atlas/auth/oauth/google/callback` | `ATLAS_GOOGLE_CLIENT_ID`, `ATLAS_GOOGLE_CLIENT_SECRET` |
| [GitHub](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) | `/api/atlas/auth/oauth/github/callback` | `ATLAS_GITHUB_CLIENT_ID`, `ATLAS_GITHUB_CLIENT_SECRET` |
| [Microsoft](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app) | `/api/atlas/auth/oauth/microsoft/callback` | `ATLAS_MICROSOFT_CLIENT_ID`, `ATLAS_MICROSOFT_CLIENT_SECRET` |

Google requests only identity/profile/email. GitHub requests `read:user user:email`. Microsoft requests delegated `User.Read`; register for organizational directories and personal Microsoft accounts to support both. No email inbox or repository access is requested. Configure consent screens and any provider testing/publishing restrictions, then restart Atlas. Store secrets only in the ignored `.env` or hosting environment settings.

First-time social signup requires the same Terms checkbox as email signup. Existing social accounts can use Sign in directly. Atlas stores the provider's stable identity ID, never access or refresh tokens. Google ID token signatures, audience, issuer, expiry, nonce, and UserInfo subject are validated. All providers use state, PKCE, an HttpOnly browser-binding cookie, one-use database attempts, expiry, and bounded exchanges.

Matching email addresses never merge accounts or grant owner access. To add Google or another method to an existing email account, sign in using the original method, open Your account, and link it after confirming the password. A social-only account needs a login within the last five minutes before linking another method. Suspended accounts cannot log in or link. The configured owner account must also use explicit linking before its first social login.

## Profile and settings

The account button opens Profile, Settings, Help, and Sign out. Profile names and photos persist with the account. PNG and JPEG photos are decoded, stripped of metadata, cropped, and stored as a 256-pixel JPEG. Executable image formats and remote image URLs are rejected.

Settings includes General, Appearance, Notifications, Profile, Security and login, Account, Archived chats, Parental controls, Safety & wellbeing, Storage, and Data controls. Preferences are stored per account and applied after sign-in. General controls cover research depth, Enter to send, and automatic scrolling. Appearance supports system/light/dark themes, text size, background motion, and reduced motion. Reply notifications need browser permission for background desktop alerts; in-app notices remain available. Break reminders count active time in the open tab.

Security lists active sessions using identifiers that cannot authenticate a request. Users can revoke another session, sign out other sessions after authentication, change their password, and explicitly connect a configured social provider. The owner account cannot delete itself through the settings interface.

Archiving removes a conversation from ordinary history while preserving its messages and sources. Restore it before continuing the conversation. Export includes the account's profile, preferences, and owned conversations, including archived chats. Storage totals count encoded conversation records (BSON in MongoDB, JSON locally), not infrastructure disk allocation. Bulk chat deletion and account deletion require typed confirmation and reject active replies. Account deletion also requires a password or a recent social login. Server mutation guards serialize deletion against other changes for that owner in the current Express process; run a single application process with the current in-memory research coordinator.

Parental controls protect this account's web research, PDF uploads, and explicit-content filtering with a six-digit PIN. Enabling them first requires the password or a recent social login; later changes require the current PIN. These controls do not link separate parent and child accounts. The explicit-content filter conservatively blocks recognizable sexual or graphic-gore requests and matching replies; it is a limited text filter, not a comprehensive classification of every page or response. Research and upload restrictions are enforced before provider calls. Saved evidence can still answer follow-up questions while web research is disabled.

## Intelligence profiles

Quick and Detailed are server-owned workflows. Groq defaults to GPT-OSS 20B/low effort for Quick and GPT-OSS 120B/high effort for Detailed. Planning uses the smaller model. Ordinary chat uses one inference in either mode: Quick favors concise answers; Detailed checks assumptions, tradeoffs, edge cases, and constraints. The context builder preserves code formatting and includes saved listing fields, with up to 8 messages / 6,000 characters for Quick and 20 messages / 16,000 characters for Detailed.

Quick research has one search and one synthesis, with its second allowed model call reserved for repair. Detailed research plans complementary searches, uses up to three searches/eight pages, synthesizes, and reviews supported claims in a third model call. Repairs consume the same budget and may replace the review. An incomplete review is labeled and retains the previously source-validated candidate. This is a model-assisted evidence review, not proof that every claim is true. PDF retrieval retains up to five relevant passages in Quick and twelve in Detailed. Each saved report keeps mode, model provenance, call/search usage, and review status.

OpenRouter is optional: configure ATLAS_OPENROUTER_API_KEY and select ATLAS_LLM_PROVIDER=openrouter. Model IDs must end in :free and be listed at zero prices in the public catalogue; inference requests also enforce a zero prompt/completion price ceiling and disable provider fallbacks. There is no paid model fallback, cross-provider retry, or browser-supplied model override. Conservative OpenRouter caps are 40 calls/day and 10/minute; account/provider limits can be lower. Groq caps each model across all users at 27 requests/minute, 950/day, and conservatively estimated 7,500 tokens/minute and 190,000/day. Detailed can wait once for a local minute reservation within the run deadline, with cancellation available; provider failures are not automatically retried. Older chat context and the model's working evidence copy are shortened to fit the free limit, while saved evidence remains complete. Actual account limits can be lower, and provider backoff is honored.

Local defaults are Qwen3.5 4B for Quick and 9B for Detailed. Install both with a compatible Ollama release. ATLAS_OLLAMA_QUICK_MODEL and ATLAS_OLLAMA_DETAILED_MODEL select explicit installed local models; the legacy ATLAS_OLLAMA_MODEL variable can still select one model for both profiles. Local thinking is enabled for Detailed plain chat on supported Qwen models; structured evidence extraction uses JSON without a thinking response. Cloud-backed Ollama models remain blocked. Models run one at a time on the local Ollama server to bound GPU memory use.

Use npm run models:check to check credentials and model availability without inference. The script does not verify a cloud billing plan: operators must confirm their free provider accounts and billing settings. No provider key is included in this repository. Live Groq/OpenRouter quality and latency require configured keys and separate measurement.
