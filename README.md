# Eve + OpenAI

This repository contains examples of how Eve can take advantage of OpenAI when you use Eve and OpenAI together. Some features demonstrated here require using Eve alongside a ChatGPT Enterprise or Business account.

> **Important:** The connector extension in this repository uses an undocumented OpenAI API. That API may change, become restricted, or stop working without notice, so treat the integration as experimental and review upgrades carefully.

## Development

This repository is a pnpm monorepo. Example applications live in `apps/`, and shared packages live in `packages/`.

Install dependencies with:

```sh
pnpm install
```

## Packages

- [`eve-openai-connectors`](packages/eve-openai-connectors) — an Eve extension that exposes a user's authorized ChatGPT connectors through provider-native deferred tool search. It currently requires the version-pinned Eve patch documented in the package README.
