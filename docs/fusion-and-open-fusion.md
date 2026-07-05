# Fusion & Open Fusion

Fusion and Open Fusion are two features of vibeTerminal that let you run **two AI
models together as a single coding agent** — one that plans and reviews, and one
that writes the code, runs it, and tests it. You talk to a single chat pane; the
work is split between the two models automatically.

The idea behind both is simple: models are different and have different
strengths. Instead of locking you to one model for everything, Fusion pairs a
strong **planner/architect** with a strong **executor**, so each part of a task
goes to the model best suited for it. Think of it as bringing together
complementary specialists rather than picking one all-rounder.

## Fusion

Fusion pairs two premium first-party coding agents:

- **Planner — Claude (Opus or Sonnet 5):** the architect. It reasons about the
  task, designs the approach, decides what should change, and reviews the result.
  It is read-only — it never edits your files directly.
- **Executor — Codex (GPT-5.5):** the builder. It writes the code, runs commands,
  executes tests, fixes what breaks, generates images, drives the browser when
  needed, and verifies its own work.

You get the full strength of both vendors' tuned coding agents working in
concert: Claude plans and keeps the executor honest, Codex does the hands-on
building, and Claude signs off before anything is called done. Both run on your
existing Claude and Codex subscriptions — no extra API keys to manage. You can
also choose which family fills each role, mixing and matching Claude and Codex on
either the planner or executor side.

**Best for:** getting the highest-quality result from two premium, purpose-built
coding agents working as a team.

## Open Fusion

Open Fusion takes the same planner-plus-executor idea and opens it up to **any
two models you choose**. Instead of a fixed pair, you pick one model for the
planner (Brain) role and another for the executor role from a large catalog of
providers and models.

- Mix and match freely — for example, a strong reasoning model to plan paired
  with a strong coding model to build.
- Connect your own providers and models inside the app; your threads,
  credentials, and settings stay owned by vibeTerminal.
- The planner stays read-only and reviews the executor's work, just like Fusion —
  the difference is that you decide which two models play those roles.

**Best for:** flexibility — combining the specific models you prefer, across
vendors, into one planner-plus-executor agent.

## At a glance

| | Fusion | Open Fusion |
|---|---|---|
| The pair | Claude + Codex, two premium first-party coding agents | Any two models you pick from a large catalog |
| Who chooses the models | You pick which family fills each role | You pick any two models for planner and executor |
| Strength | Highest ceiling — each side is a vendor-tuned agent | Maximum flexibility — mix complementary models |
| Credentials | Your existing Claude / Codex subscriptions | Your own connected providers, owned by the app |
| Best for | Premium, out-of-the-box quality | Choosing the exact models you want |

## What they share

- **One agent, one conversation.** You chat with a single agent; the split
  between planner and executor happens behind the scenes.
- **A planner that reviews.** The executor never has the final say on its own
  work — the planner independently checks the result and decides whether it's
  done or needs another pass.
- **A read-only planner.** All code changes go through the executor, so the
  planner stays focused on design and review.
- **Steering and interrupting.** You can stop a running turn or send a follow-up
  mid-task without losing the session.

For the technical deep-dives, see `docs/fusion-terminal.md` (Fusion) and
`docs/openfusion.md` (Open Fusion).
