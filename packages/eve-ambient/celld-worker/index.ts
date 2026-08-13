// The celld fleet entry point for the eve-ambient correlation mailbox.
//
// The implementation is `src/celld-worker.ts`, published as
// `eve-ambient/celld-worker`. This file exists because celld requires a
// Worker's `main` to be a path inside the project directory, and because a
// fleet project wants a directory of its own for wrangler.jsonc and build.mjs.
//
// Copy this whole directory out of the installed package, edit the vars in
// wrangler.jsonc, and deploy it: the bare import below resolves through your
// application's node_modules, so the copy needs nothing else from the package.
//
// See ./README.md for the walkthrough.

export { MonitorInstance, default } from "eve-ambient/celld-worker";
