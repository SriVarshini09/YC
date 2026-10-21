#!/usr/bin/env node
import { run } from "../dist/index.js";

process.exitCode = await run(process.argv);
