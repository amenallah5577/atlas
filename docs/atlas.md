# Atlas setup

Atlas is served at `/atlas` and uses the same MongoDB connection as EchoSphere. On the deployment branch it uses EchoSphere's existing signed guest sessions and configured Clerk accounts. On the older local checkout it uses a separate signed guest cookie.

Set the following server environment variables for Atlas. Put the provider keys in Render's environment settings or an ignored local `.env` file.

| Variable | Value |
| --- | --- |
| `MONGODB_URI` | Working MongoDB connection string |
| `SESSION_SECRET` | Stable signing secret for guest sessions |
| `ATLAS_GROQ_API_KEY` | Dedicated key from a Groq Free-plan account |
| `ATLAS_TAVILY_API_KEY` | Dedicated Tavily free-tier key with paid overages disabled |
| `ATLAS_FREE_PROVIDERS_CONFIRMED` | Set to `true` after confirming both provider accounts above |

Atlas reserves up to 900 basic Tavily searches per UTC calendar month and applies model request and token limits. Provider limits still apply to the entire provider account. The free-plan confirmation is an operator setting. A provider key does not identify the account's billing plan to Atlas.

Run `npm ci`, then `npm start`. Open `http://localhost:3000/atlas`. Run `node --test test/atlas.test.js` for the Atlas fixture evaluation and HTTP workflow. On the deployment branch, `npm test` includes those checks with the existing EchoSphere suite.

For a hosted smoke test, open Atlas in two guest sessions, send an ordinary message and one small research request, reopen the results, and verify the sessions see only their own history. Run the same check with Clerk when configured. Measure live extraction and citation quality with reviewed results before treating the fixture scores as production accuracy.

## Free local model

Atlas also supports installed Ollama models for personal use. Start `ollama serve`, then set these variables in the ignored local `.env` file.

```dotenv
ATLAS_LLM_PROVIDER=ollama
ATLAS_OLLAMA_MODEL=llama3.2:latest
ATLAS_STORAGE=local
SESSION_SECRET=your_stable_random_secret
```

Run `npm start`. Local mode uses the fixed loopback Ollama API and stores conversations and usage counters in the ignored `.atlas-data/store.json` file. Keep the signing secret stable to retain access to guest conversations after restarting. This storage mode is for one local server process and is rejected in production. Hosted deployments retain MongoDB.

Ordinary chat and PDF analysis need no cloud model key in this mode. Web, job, and shopping searches still require a confirmed free-tier Tavily key. The UI runs against the real application server when started with `npm start`. The `fixtureApp` export is only for isolated interface tests.

## Accounts and owner administration

Atlas has its own email/password account system. Passwords use salted scrypt hashes. Opaque session tokens are stored as hashes in the database, expire automatically, and are revoked after logout, password changes, and account suspension. Production cookies require HTTPS.

Configure MongoDB and a stable SESSION_SECRET before starting. For the local MongoDB instance used during implementation, the database is `mongodb://127.0.0.1:27028/atlas` in the existing `codex-echosphere-eval-mongo` Docker container. Its data volume persists across container restarts. Use a hosted MongoDB connection for public deployment.

Set `ATLAS_OWNER_EMAIL` to the owner's chosen email and run:

```powershell
node scripts/atlas-owner.js
```

The script provisions the owner, writes `ATLAS_OWNER_ID` into the ignored local environment file, and saves a generated password in the ignored `.atlas-data/owner-access.txt` file. Sign in at `/atlas`, change the generated password in Your account, and open `/atlas/admin`. Keep the configured owner ID stable. Admin access is decided by that server setting, never by a role supplied during signup.

To import an existing local Atlas store into the configured MongoDB database, stop the application and run `node scripts/atlas-owner.js --import-local`. Import uses insert-only upserts and retains the source file.

The owner dashboard can filter account histories, read complete saved conversations, record private review notes, suspend accounts, and pause registration or live research. Session versions prevent an in-flight old-password login from remaining valid after a password change or suspension. The protected HTML template resides outside the public directory. Every admin API independently checks the owner identity.

Registration requires acceptance of Terms and Conditions. Its final section explains owner review of saved conversations and retained activity records. Submitted account requests and owner actions are audited. Conversation deletion removes the saved conversation while activity records remain for moderation.

The local installation uses Ollama and MongoDB. Public hosting needs its own MongoDB connection, HTTPS, stable session secret, owner ID, and confirmed free-plan Groq/Tavily keys. Email verification and email-based password recovery require a separate email delivery configuration. Password changes are available inside signed-in accounts.

## Social sign-in

Atlas supports Google (including Gmail), GitHub, and Microsoft through server-side authorization-code flows using `openid-client`. Requires Node 20.19 or newer. No authentication subscription is required. Provider app credentials must be created in the owner's provider developer accounts; unconfigured buttons stay disabled. Email/password sign-in remains available.

Set `ATLAS_PUBLIC_URL` to the exact site origin (for example `https://ecosphere-hty6.onrender.com`, or `http://127.0.0.1:3182` locally). Production requires HTTPS. Register these exact callback URLs in the corresponding provider app, replacing the origin as needed:

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
