# Cloudflare Pages deployment (Astro `web/`)

`.github/workflows/pages.yml` publishes the static Astro build in `web/dist` to
the Cloudflare Pages project `rotor-site`. The pipeline is prepared but inert
until the two repository secrets below exist; it never needs a value in the
repository.

## Provisioning is the owner's / Hermes's task

The `rotor-site` Pages project and both repository secrets are provisioned by
the owner (through Hermes when it is available). Neither exists as of this
change. Until they do:

- the workflow makes no Cloudflare API call, because the `build-and-deploy` job
  is skipped before it starts;
- the only way to see the Astro build is local:
  `npm --prefix web run preview` (Astro preview server) or a static file server
  rooted at `web/dist`;
- a push to `main` under `web/**` still exercises nothing but the credential
  check, and reports `CF secrets not configured — deploy skipped.` in the run
  summary.

## One-time owner setup (when provisioning)

1. Create the Pages project `rotor-site` in the Cloudflare account (dashboard:
   Workers & Pages -> Create -> Pages -> Direct Upload, or
   `npx wrangler pages project create rotor-site --production-branch main`).
   The workflow deploys with `wrangler pages deploy`, so the project has no Git
   integration and no build command of its own.
2. Add the repository secrets in
   `mytab0r/Rotor-Cuda` -> Settings -> Secrets and variables -> Actions:

   | Secret | What it is |
   |---|---|
   | `CF_API_TOKEN` | A Cloudflare API token scoped to the account with the **Cloudflare Pages: Edit** permission. |
   | `CF_ACCOUNT_ID` | The account ID shown in the Cloudflare dashboard (Workers & Pages overview). |

   No token, account ID or other credential is committed, written to the
   checkout, or printed by the workflow.

## What the workflow does

- Trigger: a push to `main` that touches `web/**`, or a manual
  `workflow_dispatch` run.
- Steps: `npm --prefix web ci`, `npm --prefix web run check`,
  `npm --prefix web run build`, then
  `wrangler pages deploy web/dist --project-name rotor-site` through
  `cloudflare/wrangler-action@v3`.
- Credentials: a separate `credentials` job reads `CF_API_TOKEN` and
  `CF_ACCOUNT_ID` and publishes only a boolean. GitHub does not allow the
  `secrets` context in `jobs.<job_id>.if`, so the deploy job is gated on that
  boolean (`needs.credentials.outputs.ready`). When either secret is missing
  the deploy job is skipped with a notice, not failed; this covers forks and a
  repository where the secrets are not configured yet.
- Output: the `pages` job exposes `preview-url` (the Wrangler deployment URL)
  and `alias-url` (the project alias). Both are written to the run summary.
- The token is exposed to the deploy step only, never to the build steps.

## What this does NOT do

- It does not change DNS, add a custom domain, or point `rotor.pxbt.app` at
  Pages. The origin cutover is a separate owner-approved step
  (`openspec/changes/frontend-platform/tasks.md` §6).
- It does not add Worker routes, `/api/*` forwarding, Pages Functions or any
  coordinator change. Deployments are reachable only on `*.pages.dev` until
  DNS/custom-domain work is approved.
- It does not create the Pages project or the secrets. Those are the one-time
  owner actions above; the workflow only consumes them.

## Verifying a run

Open the `pages` workflow run: the summary shows the deployment URL, and the
same value is the `preview-url` job output. A skipped `build-and-deploy` job
with the "Cloudflare Pages skipped" notice means one or both secrets are
missing, not that the build failed.
