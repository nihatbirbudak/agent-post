#!/usr/bin/env node
// Command line entry of agent-post: runs the core with this process's arguments and environment.

import { main } from "../src/agent-post.mjs";

main(process.argv.slice(2));
