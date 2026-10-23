#!/usr/bin/env node
import { runCli } from './run.js'

const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) return ''
  let text = ''
  for await (const chunk of process.stdin) text += String(chunk)
  return text
}

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  isTTY: process.stdout.isTTY === true,
  readStdin,
  stderr: (text) => process.stderr.write(text),
  stdout: (text) => process.stdout.write(text),
})
