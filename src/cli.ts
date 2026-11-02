#!/usr/bin/env node
// The varis command. The only file that touches the process: it passes the
// arguments in, and turns the result into an exit code.

import os from "node:os";
import { removeLeftoverUpgrade, resolvedExecPath } from "./commands/upgrade.ts";
import { runCli } from "./lib/cli.ts";
import { detectChannel } from "./lib/install-channel.ts";
import { processOutput } from "./lib/output.ts";
import { checkForUpdate } from "./lib/update-check.ts";
import { VERSION } from "./lib/version.ts";

// On Windows, varis upgrade leaves the replaced binary beside the new one,
// because a running program can't delete itself. The next run removes it.
await removeLeftoverUpgrade();

const home = os.homedir();
process.exitCode = await runCli(process.argv.slice(2), processOutput, {
  checkForUpdate: (command) =>
    checkForUpdate(command, {
      env: process.env,
      home,
      platform: process.platform,
      version: VERSION,
      channel: detectChannel(resolvedExecPath(), home, process.platform),
      interactive: process.stderr.isTTY === true,
      fetch,
      now: () => Date.now(),
    }),
});
