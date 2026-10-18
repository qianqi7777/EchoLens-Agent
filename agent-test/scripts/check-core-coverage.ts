import { readFile } from 'node:fs/promises';
import { coreCoverage } from '../src/evals/core-coverage.js';

const result = coreCoverage(await readFile('coverage/lcov.info', 'utf8'));
console.log(`Core lines: ${result.percent.toFixed(2)}% (${result.covered}/${result.total}); required >= 95%`);
if (!result.passed) process.exitCode = 1;
