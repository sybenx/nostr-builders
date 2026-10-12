# Nostr Builders

A directory of people building on Nostr, each with a Nostr profile you can follow:
**https://sybenx.github.io/nostr-builders/**

## Where the data comes from

Rebuilt daily by a GitHub Action (`collect.ts`, run with Bun, no dependencies):

- **Git repos announced on Nostr** (NIP-34 `kind:30617`), plus their recent patches, issues and status events.
  The repo is announced by the profile's own key.
- **The most-starred GitHub repos tagged `nostr`** whose README names an `npub` or `nprofile`. Usually that's the
  maintainer or the project's own account, sometimes a contributor.

For each profile it reads the Nostr profile, posts from the last 30 days and follow list from public relays.

## How it's ranked

By default: how many other builders follow someone, plus repo activity, recent posting and GitHub stars.

**See it through your network** (Nostr extension or a pasted npub) re-ranks by how many of the people *you*
follow follow each builder. Your browser reads those follow lists from public relays itself; nothing is sent
anywhere else, and there is no server.

## Run it yourself

```sh
bun collect.ts          # writes site/data.json (set GITHUB_TOKEN for higher GitHub rate limits)
bunx serve site         # or any static file server
```

Made by nostr:npub175rnagjgxtvwvfrdytkqkkn4h062zf2cuwkx0jc8xc9nga895s8qgsef5g
