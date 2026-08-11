<p align="center">
  <img src="docs/assets/cloudflareOS.svg" alt="Cloudflare OS" width="480">
</p>

<h1 align="center">Customized for your Company</h1>

<p align="center">
  Run a pinned Cloudflare OS release behind Cybernest Core, with its standard UI and runtime upgraded as one unit.
</p>

<p align="center">
  <a href="https://developers.cloudflare.com/workers/"><img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-F6821F?logo=cloudflare&logoColor=white"></a>
  <a href="https://nodejs.org/"><img alt="Node.js 24" src="https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white"></a>
  <a href="https://pnpm.io/"><img alt="pnpm 11" src="https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white"></a>
  <a href="https://github.com/cloudflare/cloudflare-os"><img alt="Cloudflare OS upstream" src="https://img.shields.io/badge/upstream-Cloudflare_OS-24292F?logo=github"></a>
</p>

> [!IMPORTANT]
> Cloudflare OS is early-access software. Pin upstream releases, review changes, and verify the trust boundary before every production upgrade.

## Four steps

1. Install the dependencies and run `pnpm exec wrangler login`.
2. Fill in the active values in `deployment.jsonc`: account ID, Worker names, and organization settings.
3. Run `pnpm check`, then `pnpm deploy`.
4. Sign in through Cybernest and open `/workspace`; no second Cloudflare OS login should appear.

[Deploy](#deploy) and [Customization](#customization) expand each step. Everything else on this page is optional reading.

## Overview

This repository adds deployment controls and a thin Cybernest frontend adapter around a pinned [Cloudflare OS](https://github.com/cloudflare/cloudflare-os) fork.

| Control | What you own |
| --- | --- |
| Branding | The Cybernest build supplies the site name; independent OS branding remains an upstream standalone feature |
| Identity | Cybernest Core/Auth0 owns the browser entry; the Workshop runtime stays private behind its Service Binding |
| Routing | Private Workshop runtime plus same-zone `/workspace` Workspace UI Worker routes |
| Data | Existing KV/R2 resources or [automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning) |
| Integrations | Wrapper-owned Gatekeepers and service bindings without patching upstream |
| AI | No platform model by default; opt into [Workers AI](https://developers.cloudflare.com/workers-ai/) and [AI Gateway](https://developers.cloudflare.com/ai-gateway/) when needed |
| Operations | [Structured logs, traces, explicit error reports](docs/observability.md), validation, deployment order, and upgrades |

### Architecture

<img src="docs/assets/architecture.svg" alt="Cloudflare OS deployment architecture: users sign in and reach the pinned Cloudflare OS release, holding the Workshop kernel, Gadgets, Blueprints, and the default Gatekeepers. Service bindings connect it to the Workers this repository owns: optional AI, custom Gatekeepers, the Error Reporter, and KV and R2 storage.">

The deploy command derives temporary Wrangler files from upstream base configs, builds the pinned frontend in Cybernest mode, deploys the private Workshop runtime before the stateless `/workspace` UI Worker, and removes generated files even on failure. Secrets never enter tracked configuration.

### If you only want branding

A hosted flow deploys the same upstream release to your Cloudflare account without this repository. It builds nothing locally, configures sign-in and your admin emails for you, and leaves the whole `/admin` surface intact: site name, logo, accent color, announcements, agent instructions, featured blueprints, and which connectors your users can reach. Built-in Gatekeepers such as GitHub and Google are still yours to connect with your own OAuth credentials.

<a href="https://os.cloudflare.app/deploy"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>

Anything past that needs your own code or settings, which is what this repository is for: custom Gatekeepers, customized error reporting, your own Worker names, reusing storage you already have, choosing how much logging to keep, and a pinned version you upgrade when you decide. Hosted deployments also run on a `workers.dev` address, so deploy from here if you want the app on your own domain, or the email Gatekeeper, which needs a zone. Come back when branding stops being enough.

## Deploy

### 1. Prepare the workspace

Install [Node.js 24](https://nodejs.org/), [pnpm 11](https://pnpm.io/installation), and authenticate [Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/#login):

```sh
git submodule update --init
pnpm install
pnpm --dir cloudflare-os install
pnpm exec wrangler login
```

Your account needs [Workers](https://developers.cloudflare.com/workers/), [KV](https://developers.cloudflare.com/kv/), [R2](https://developers.cloudflare.com/r2/), [Browser Rendering](https://developers.cloudflare.com/browser-rendering/), and [Dynamic Worker Loaders](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/). AI products are optional.

### 2. Configure the private Cybernest deployment

Open [`deployment.jsonc`](deployment.jsonc) and replace the active placeholders. Keep `workers.workshop.route` as `null`: Cybernest Core/Auth0 owns sign-in and reaches the Workshop only through its private Service Binding. The Workspace UI routes stay on `dev.dennoba.net/workspace` and `dev.dennoba.net/workspace/*` for this development deployment.

The validator rejects a public Workshop route because this release always builds the Cybernest frontend. Do not create a second Cloudflare Access login for this path. A standalone public Cloudflare OS deployment is a separate release mode; follow the upstream project instead.

### 3. Validate and deploy

```sh
pnpm check
pnpm deploy
```

With resource values left as `null`, Wrangler creates the three KV namespaces and R2 bucket automatically and reconnects them on later deploys. Set explicit IDs or a bucket name when the deployment must reuse existing resources.

AI is disabled by default. The application can deploy without an AI Gateway or token; see [AI models](docs/customization.md#ai-models) to enable deployment-funded models.

Backend error reporting is enabled without a vendor account. Explicit upstream issue events become structured logs in the private Error Reporter Worker; see [Observability and error reporting](docs/observability.md).

### 4. Verify the deployment

- Open `/workspace` on the configured zone and confirm the Core gateway reaches the pinned Workshop runtime without a second OS login.
- Confirm an unauthenticated or unregistered browser returns to the Cybernest identity surface instead of an OS login or signup page.
- Open the Error Reporter Worker's [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) and verify its structured `error_report` query surface.
- Review logs for the Workshop, Context, custom Gatekeeper, and Error Reporter Workers.

## Customization

| Customize | Best place | Deploy required |
| --- | --- | --- |
| Cybernest site name | `VITE_SITE_NAME` in the wrapper-owned build | Yes |
| Standalone OS branding and runtime policy | Upstream `/admin` surface | Depends on a separate standalone deployment |
| AI, storage, observability, Worker identities | [`deployment.jsonc`](deployment.jsonc) | Yes |
| Logs, traces, error destinations, browser reporting | [Observability guide](docs/observability.md) | Sometimes |
| Organization APIs and capabilities | [`packages/custom-gatekeeper`](packages/custom-gatekeeper/README.md) | Yes |
| Product behavior unavailable through Worker boundaries | Pinned upstream fork/commit | Yes |

The complete control reference and recipes live in [Customization](docs/customization.md). The upstream [`write-gatekeeper` skill](https://github.com/cloudflare/cloudflare-os/blob/main/.agents/skills/write-gatekeeper/SKILL.md) covers richer integrations.

## Operations and upgrades

- Stream production events with [`wrangler tail`](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/).
- Triage explicit failures and choose export destinations with the [observability guide](docs/observability.md).
- Roll a Worker back from its dashboard deployment history or with [`wrangler rollback`](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
- Follow the [upgrade checklist](docs/customization.md#upgrade) before changing the pinned submodule.
- Update the Workspace UI Worker and private Workshop runtime from the same Cloudflare OS full SHA; do not update the UI alone.
- Review the upstream Cloudflare OS documentation and release history before adopting behavior changes.
