# AI Client Layer

This directory is reserved for the vision-capable GPT client in task 8: provider requests, structured output, bounded retries, and a replaceable test client.

Read provider settings from `src/config/env.js`. Do not expose API keys or provider response bodies to the browser or application logs. The health endpoint does not call this layer.
