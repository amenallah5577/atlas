# Deploy Atlas on Render

The repository includes `render.yaml` for a separate Node.js web service. The service opens Atlas at `/` and `/atlas`, uses MongoDB for durable accounts and chats, and keeps the original EchoSphere service unchanged. The application currently requires a single running instance because active research is coordinated in process memory.

## Private configuration

Use a hosted MongoDB database, such as a MongoDB Atlas Free cluster, with an application database user and network access for the Render service. Keep the connection string, provider keys, and owner credentials out of Git. Do not upload the local development database or test accounts as deployment assets.

Create the service from the repository's Render Blueprint. It selects the Free instance, Node.js 22, `npm ci --omit=dev`, `npm start`, and `/healthz` for readiness. Enter the private values requested by Render:

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | Hosted database connection for Atlas |
| `ATLAS_GROQ_API_KEY` | Confirmed Groq Free key |
| `ATLAS_TAVILY_API_KEY` | Tavily free key with paid overages disabled |
| `ATLAS_FREE_PROVIDERS_CONFIRMED` | `true` after checking both accounts |
| `ATLAS_OWNER_EMAIL` | Owner email, reserved from public registration |
| `ATLAS_OWNER_ID` | Provisioned owner account ID |

The Blueprint generates a stable private `SESSION_SECRET`. Preserve it on later deploys. Render's `RENDER_EXTERNAL_URL` supplies the public HTTPS origin automatically; set `ATLAS_PUBLIC_URL` explicitly if using a custom domain. `ATLAS_TRUST_PROXY=1` trusts the single hosting proxy hop. Direct local development keeps this at `0`.

## Provision the owner

Prepare an ignored `.env.production` containing the hosted database settings, chosen owner email, and owner ID. Provision against that database from a machine allowed to connect:

```sh
node scripts/atlas-owner.js --env-file=.env.production --access-file=.atlas-data/owner-access.production.txt
```

The generated password is saved privately in the specified ignored file. Put the resulting `ATLAS_OWNER_ID` in Render's environment settings. Sign in on the deployed site, change the generated password, and open `/atlas/admin`. Do not run the optional local-data import unless intentionally migrating those records.

## Verify and update

Startup waits for the database and indexes before accepting requests. `/healthz` pings MongoDB without using model or search quota, and returns `503` while storage is unavailable or the server is draining. Shutdown cancels active research, saves available results, and then closes database connections. A cancelled draft can be retried; a deployment does not resume an unfinished model request.

After deployment, verify HTTPS, account creation and login, a Quick reply, a Detailed reply, a small sourced research request, restoration of a saved conversation, account isolation, and denial of unauthenticated admin access. The Blueprint deploys future commits after GitHub checks pass. Keep provider keys in host environment settings; they are never part of the GitHub push.

Render Free instances sleep after inactivity and can take about a minute to wake. They share the workspace's free-hour allowance. This is suitable for the current personal preview; the Free instance does not provide continuous uptime or persistent local disk. MongoDB remains the source of saved account data. No paid service or provider fallback is required by this configuration.
