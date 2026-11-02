# Proofable Agent

An AI agent that runs on a permission you sign instead of your keys. Proofable checks every action outside the agent before it runs, the work can run on an isolated computer, and every run leaves a signed receipt anyone can verify offline.

The permission lives with Proofable, not with the runtime. Run the agent from your AI tools, a hosted runtime or CI, and the same limits hold in each one. Revoke it once and every copy stops.

Click **Use this template** for your own copy, or [open it in Codespaces](https://codespaces.new/proofable/agent).

## Quick start

You need Node 20 or later and a Proofable account (free, with 500 credits a month). Create an access key under [Profile, Account, Access keys](https://proofable.me/profile?tab=account) and keep it in your shell.

```bash
npm install
export PROOFABLE_ACCESS_KEY=npk_...
npm run setup
npm run status
npm run job -- "Run the tests and report each exit code" --repo proofable/mcp
npm run verify
```

`setup` gives the agent its own key in `.agent/` and signs its identity, then prints a link. Open the link, check the limits, and sign with your wallet. Commit `agent.json` afterwards: it holds the agent's public account. Each job is one hosted run paid from your credits.

## Run it anywhere

The agent lives on Proofable. Its identity, its permission and its receipts are records any runtime reads, so there is nothing to deploy. Every runtime gets the same limits, and revoking the permission stops all of them at once. The agent's own key never leaves the machine that ran `setup`.

**From any app, server or runtime**, one call talks to the agent. The turn runs on Proofable as the agent, checks every tool call against the permission before it runs, and cites the records it read:

```js
import { ProofableClient } from '@proofable/sdk';

const client = new ProofableClient({ apiKey: process.env.PROOFABLE_ACCESS_KEY });
const turn = await client.agentChat({
  agentId: 'proofable-agent',
  messages: [{ role: 'user', content: 'What did the last run find?' }],
});
console.log(turn.answer, turn.citations);
```

[Talk to your agent from any app](https://docs.proofable.me/agents/talk-to-an-agent) covers the HTTP call, the events and the costs.

**In your AI tools**:

```bash
npx -y @proofable/sdk mount proofable-agent --apply claude
```

`--apply` takes `claude`, `cursor`, `codex`, `hermes`, `openclaw`, or `opencode`; VS Code uses `cursor`.

**From this repository**, `npm run job` runs a task as the agent on an isolated computer, and `npm run verify` checks its receipt offline. Give each place you run it its own access key, so you can revoke one without the others.

## Give it knowledge

Put what the agent should know in `knowledge/`, one file per subject. The folder sets the kind of record: `knowledge/rule/` for limits such as what it must never say, `knowledge/instruction/` for voice, `knowledge/research/` for sourced material, and anything else is memory.

```bash
npm run knowledge -- --dry-run
npm run knowledge
```

Each file becomes one record, filed as written. The agent reads them when it answers and cites the ones it used. Edit a file and run it again: that record is replaced and the rest are left alone. Delete a file and its record goes too. Records are private unless `knowledge.visibility` is `public`, and a reader who opens a private citation sees that it is private.

## Already run an agent?

Bring it as it is: a GitHub repository, an MCP server URL, an A2A agent card, or a package. Secrets stay out of the import.

```bash
npx -y @proofable/sdk auth --oauth
npx -y @proofable/sdk import <repository, URL, or folder>
npx -y @proofable/sdk mount <agentId> --apply claude
```

`import` prints a link to register the agent's identity.

## Commands

| Command | What it does |
|---|---|
| `setup` | Creates the agent's key and identity, then prints the permission link |
| `permit` | Prints the link again, to renew the permission or sign new limits |
| `status` | Shows the permission and which actions it allows or refuses |
| `knowledge` | Files `knowledge/` as the records the agent answers from and cites. `-- --dry-run` shows what would change. |
| `job "<task>"` | Runs a task. `--repo owner/name` checks out a public repository on an isolated computer (`--ref` picks the commit); `--computer` asks for one without a repository. |
| `verify` | Checks the latest run's receipt and dispatch decision offline, with no network and no account. Pass a folder under `runs/` to check another run. |
| `listing` | Saves an AI service listing that runs as this agent, as a draft. `-- --publish` puts it live. |

## Make it yours

Edit `agent.json`, then run `npm run setup`.

| Field | Sets |
|---|---|
| `agentId`, `label`, `description`, `instructions` | Who the agent is and how it behaves |
| `permission.actions` | The only actions it may take; anything else is refused before it runs |
| `permission.expiresInDays` | When access ends. Leave it out and the permission has no end date until you revoke it. |
| `permission.maxSpend` | Spend cap in USDC base units (`1000000` is 1 USDC); `0` for an agent that never pays |
| `knowledge.topic`, `knowledge.visibility` | The topic its knowledge is filed under (the agent id when left out), and `private` (the default) or `public` records |
| `listing` | The service buyers order: name, description, the repository input, and the prompt each order runs |

## CI

Add your access key as a repository secret named `PROOFABLE_ACCESS_KEY`. The **Trust checks** workflow runs Proofable's eight live permission cases and the prompt injection test on your account. It fails when an attack gets past the scoped permission. Run it from the Actions tab; it also runs on pull requests that change `agent.json`. It starts 12 hosted jobs.

## Learn more

- [Docs](https://docs.proofable.me)
- [Benchmark](https://docs.proofable.me/benchmark): Proofable's published results for these checks
- [Prompt injection test](https://github.com/proofable/mcp/tree/main/examples/injection-test)

Apache-2.0
