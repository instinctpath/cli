#!/usr/bin/env node
import { main } from "../src/main.js";

// Piping into `head` closes the pipe early. That is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
}

process.exitCode = await main(process.argv.slice(2));
