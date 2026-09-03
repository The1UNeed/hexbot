"""Curated model shortlist shown ahead of the live picker results.

EDIT THIS TABLE FREELY. It is plain data with no code depending on any
particular row: `hexbot.models.list` returns it as `curated` and the live
`model.options` payload as `all`. Rows whose provider has no credentials still
show, so the picker can offer a model and then ask for the key.

Ids were checked against the Hermes catalogs in this tree (`agent.models_dev`
disk cache, `hermes_cli.models._PROVIDER_MODELS` / `OPENROUTER_MODELS`, and
`plugins/model-providers/<name>`), not invented. `provider` is the canonical
Hermes slug — note that OpenAI's direct API is `openai-api` and the ChatGPT /
Codex subscription is `openai-codex`; `hexbot.providers` maps the friendlier
`openai` / `chatgpt` aliases onto them.
"""

Model = dict

CURATED_MODELS: list[Model] = [
    # OpenAI direct API (openai-api).
    {"provider": "openai-api", "id": "gpt-5.6", "label": "GPT-5.6"},
    {"provider": "openai-api", "id": "gpt-5.6-sol", "label": "GPT-5.6 Sol"},
    {"provider": "openai-api", "id": "gpt-5.4", "label": "GPT-5.4"},
    # Anthropic direct API.
    {"provider": "anthropic", "id": "claude-fable-5-1", "label": "Claude Fable 5.1"},
    {"provider": "anthropic", "id": "claude-opus-5", "label": "Claude Opus 5"},
    {"provider": "anthropic", "id": "claude-sonnet-5", "label": "Claude Sonnet 5"},
    # xAI. models.dev lists no `grok-4.6-fast`, so only the base route is here.
    {"provider": "xai", "id": "grok-4.6", "label": "Grok 4.6"},
    # OpenRouter — three popular routes from Hermes' own OPENROUTER_MODELS list.
    {"provider": "openrouter", "id": "anthropic/claude-opus-5", "label": "Claude Opus 5 (OpenRouter)"},
    {"provider": "openrouter", "id": "openai/gpt-5.6-sol", "label": "GPT-5.6 Sol (OpenRouter)"},
    {"provider": "openrouter", "id": "google/gemini-3.1-pro-preview", "label": "Gemini 3.1 Pro (OpenRouter)"},
    # Ollama, served from a local endpoint. Hermes routes local Ollama through
    # its custom-endpoint provider, so `hexbot.models.list {provider:"ollama"}`
    # returns these curated rows with an empty live list.
    {"provider": "ollama", "id": "llama3.3", "label": "Llama 3.3 (local)"},
    {"provider": "ollama", "id": "qwen3", "label": "Qwen 3 (local)"},
    # Z.AI / GLM — the defaults declared by plugins/model-providers/zai
    # (`fallback_models`), plus its documented `default_aux_model`.
    {"provider": "zai", "id": "glm-5.2", "label": "GLM-5.2"},
    {"provider": "zai", "id": "glm-5", "label": "GLM-5"},
    {"provider": "zai", "id": "glm-4.5-flash", "label": "GLM-4.5 Flash"},
]
