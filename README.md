# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/ryan-akmal/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/ryan-akmal/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

One server, two APIs, six real prompts, and a live free model behind every answer. This server answers `POST /v1/chat/completions` as an OpenAI-compatible server does and `POST /v1/messages` as an Anthropic-compatible one does, in JSON and in streaming, and dials every answer through the gateway from one of OpenRouter's fourteen free models. It routes each prompt to the highest-rated free model that meets its requirements (ranked on the brief's own ratings), fails over down the ranking when a provider refuses — reporting every recovered refusal in the `x-makefun-upstream-failures` header — and cools a refused model down for the rest of the trial so one rate-limited model cannot take the later prompts down with it. Every choice derives from the brief, the requests and the gateway's answers alone, so a replay leaves the same state export.

## Run it

```sh
node main.ts --list
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_PROMPT_FILE=brief.txt OPENAI_BASE_URL=http://127.0.0.1:8080 OPENAI_API_KEY=dummy node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=tf75e7z1&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
