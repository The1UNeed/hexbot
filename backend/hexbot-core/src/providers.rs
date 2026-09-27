//! Provider credentials and model catalogs. The embedded catalog is a snapshot of
//! the Hermes provider profiles in this checkout, with live refresh when requested.
const CATALOG: &str = r###"{"providers":[{"name":"nous","display_name":"Nous Research","env_vars":["NOUS_API_KEY"],"base_url":"https://inference-api.nousresearch.com/v1","auth_type":"oauth_device_code","base_url_env_var":"","aliases":["nous-portal","nousresearch"],"models":["anthropic/claude-fable-5.1","anthropic/claude-fable-5","anthropic/claude-opus-5","anthropic/claude-opus-4.8","anthropic/claude-sonnet-5","anthropic/claude-haiku-4.5","openai/gpt-5.6-sol","openai/gpt-5.6-sol-pro","openai/gpt-5.6-terra","openai/gpt-5.6-terra-pro","openai/gpt-5.6-luna","openai/gpt-5.6-luna-pro","openai/gpt-5.5","openai/gpt-5.5-pro","openai/gpt-5.4-mini","google/gemini-3.1-pro-preview","google/gemini-3.7-flash","x-ai/grok-4.6","deepseek/deepseek-v4-pro","deepseek/deepseek-v4-pro-0813","deepseek/deepseek-v4-flash","deepseek/deepseek-v4-flash-0731","qwen/qwen3.8-max","qwen/qwen3.8-flash","moonshotai/kimi-k3","minimax/minimax-m3","z-ai/glm-5.3","z-ai/glm-5.3-flash","z-ai/glm-5.2","xiaomi/mimo-v2.5-pro","tencent/hy4-preview","tencent/hy3","stepfun/step-3.7-flash","nvidia/nemotron-3-super-120b-a12b","sakana/fugu-ultra"]},{"name":"openai-codex","display_name":"OpenAI Codex","env_vars":[],"base_url":"https://chatgpt.com/backend-api/codex","auth_type":"oauth_external","base_url_env_var":"","aliases":["codex","openai_codex"],"api_mode":"codex_responses","models":["gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gpt-5.5","gpt-5.4-mini","gpt-5.4","gpt-5.3-codex","gpt-5.3-codex-spark"]},{"name":"openai-api","display_name":"OpenAI API","env_vars":["OPENAI_API_KEY"],"base_url":"https://api.openai.com/v1","auth_type":"api_key","base_url_env_var":"OPENAI_BASE_URL","models":["gpt-5.6-sol","gpt-5.6-sol-pro","gpt-5.6-terra","gpt-5.6-terra-pro","gpt-5.6-luna","gpt-5.6-luna-pro","gpt-5.5","gpt-5.5-pro","gpt-5.4","gpt-5.4-mini","gpt-5.4-nano","gpt-5-mini","gpt-5.3-codex","gpt-4.1","gpt-4o","gpt-4o-mini"]},{"name":"xai-oauth","display_name":"xAI Grok OAuth (SuperGrok / Premium+)","env_vars":[],"base_url":"https://api.x.ai/v1","auth_type":"oauth_external","base_url_env_var":"","models":["grok-4.6","grok-build-0.1","grok-4.5","grok-4.3","grok-4.20-0309-reasoning","grok-4.20-0309-non-reasoning","grok-4.20-multi-agent-0309","grok-composer-2.5-fast"]},{"name":"qwen-oauth","display_name":"Qwen OAuth","env_vars":["QWEN_API_KEY"],"base_url":"https://portal.qwen.ai/v1","auth_type":"oauth_external","base_url_env_var":"","aliases":["qwen","qwen-portal","qwen-cli"],"models":[]},{"name":"lmstudio","display_name":"LM Studio","env_vars":["LM_API_KEY"],"base_url":"http://127.0.0.1:1234/v1","auth_type":"api_key","base_url_env_var":"LM_BASE_URL","models":[]},{"name":"copilot","display_name":"GitHub Copilot","env_vars":["COPILOT_GITHUB_TOKEN","GH_TOKEN","GITHUB_TOKEN"],"base_url":"https://api.githubcopilot.com","auth_type":"copilot","base_url_env_var":"COPILOT_API_BASE_URL","aliases":["github-copilot","github-models","github-model","github"],"models":["gpt-5.4","gpt-5.4-mini","gpt-5-mini","gpt-5.3-codex","gpt-5.2-codex","gpt-4.1","gpt-4o","gpt-4o-mini","claude-sonnet-4.6","claude-sonnet-5","claude-sonnet-4","claude-sonnet-4.5","claude-haiku-4.5","gemini-3.1-pro-preview","gemini-3-pro-preview","gemini-3-flash-preview","gemini-2.5-pro"]},{"name":"copilot-acp","display_name":"GitHub Copilot ACP","env_vars":[],"base_url":"acp://copilot","auth_type":"external_process","base_url_env_var":"COPILOT_ACP_BASE_URL","aliases":["github-copilot-acp","copilot-acp-agent"],"api_mode":"chat_completions","models":["copilot-acp"]},{"name":"gemini","display_name":"Google AI Studio","env_vars":["GOOGLE_API_KEY","GEMINI_API_KEY"],"base_url":"https://generativelanguage.googleapis.com/v1beta","auth_type":"api_key","base_url_env_var":"GEMINI_BASE_URL","aliases":["google","google-gemini","google-ai-studio"],"api_mode":"chat_completions","models":["gemini-3.1-pro-preview","gemini-3-pro-preview","gemini-3.6-flash","gemini-3.1-flash-lite-preview"]},{"name":"zai","display_name":"Z.AI (GLM)","env_vars":["GLM_API_KEY","ZAI_API_KEY","Z_AI_API_KEY"],"base_url":"https://api.z.ai/api/paas/v4","auth_type":"api_key","base_url_env_var":"GLM_BASE_URL","aliases":["glm","z-ai","z.ai","zhipu"],"models":["glm-5.3","glm-5.3-flash","glm-5.2","glm-5.1","glm-5","glm-5v-turbo","glm-5-turbo","glm-4.7","glm-4.5","glm-4.5-flash"]},{"name":"kimi-coding","display_name":"Kimi For Coding (Global)","env_vars":["KIMI_API_KEY","KIMI_CODING_API_KEY"],"base_url":"https://api.moonshot.ai/v1","auth_type":"api_key","base_url_env_var":"KIMI_BASE_URL","aliases":["kimi","moonshot","kimi-for-coding"],"models":["kimi-k3","kimi-k2.7-code","kimi-k2.6","kimi-k2.5","kimi-for-coding","kimi-for-coding-highspeed","kimi-k2-thinking","kimi-k2-thinking-turbo","kimi-k2-turbo-preview","kimi-k2-0905-preview"]},{"name":"kimi-coding-cn","display_name":"Kimi For Coding (China)","env_vars":["KIMI_CN_API_KEY"],"base_url":"https://api.moonshot.cn/v1","auth_type":"api_key","base_url_env_var":"","aliases":["kimi-cn","moonshot-cn"],"models":["kimi-k3","kimi-k2.7-code","kimi-k2.7-code-highspeed","kimi-k2.6","kimi-k2.5","kimi-k2-thinking","kimi-k2-turbo-preview","kimi-k2-0905-preview"]},{"name":"stepfun","display_name":"StepFun Step Plan","env_vars":["STEPFUN_API_KEY"],"base_url":"https://api.stepfun.ai/step_plan/v1","auth_type":"api_key","base_url_env_var":"STEPFUN_BASE_URL","aliases":["step","stepfun-coding-plan"],"models":["step-3.5-flash","step-3.5-flash-2603"]},{"name":"arcee","display_name":"Arcee AI","env_vars":["ARCEEAI_API_KEY"],"base_url":"https://api.arcee.ai/api/v1","auth_type":"api_key","base_url_env_var":"ARCEE_BASE_URL","aliases":["arcee-ai","arceeai"],"models":["trinity-large-thinking","trinity-large-preview","trinity-mini"]},{"name":"gmi","display_name":"GMI Cloud","env_vars":["GMI_API_KEY","GMI_BASE_URL"],"base_url":"https://api.gmi-serving.com/v1","auth_type":"api_key","base_url_env_var":"GMI_BASE_URL","aliases":["gmi-cloud","gmicloud"],"models":["zai-org/GLM-5.1-FP8","deepseek-ai/DeepSeek-V3.2","moonshotai/Kimi-K2.5","google/gemini-3.1-flash-lite-preview","anthropic/claude-sonnet-5","anthropic/claude-sonnet-4.6","openai/gpt-5.4"]},{"name":"actual","display_name":"Actual Computer","env_vars":["ACTUAL_API_KEY","ACTUAL_BASE_URL"],"base_url":"https://api.actual.inc/v1","auth_type":"api_key","base_url_env_var":"ACTUAL_BASE_URL","aliases":["actual-computer","actualcomputer","aci"],"api_mode":"codex_responses","models":[]},{"name":"minimax","display_name":"MiniMax","env_vars":["MINIMAX_API_KEY"],"base_url":"https://api.minimax.io/anthropic","auth_type":"api_key","base_url_env_var":"MINIMAX_BASE_URL","aliases":["mini-max"],"api_mode":"anthropic_messages","models":["MiniMax-M3","MiniMax-M2.7","MiniMax-M2.5","MiniMax-M2.1","MiniMax-M2"]},{"name":"minimax-oauth","display_name":"MiniMax (OAuth)","env_vars":[],"base_url":"https://api.minimax.io/anthropic","auth_type":"oauth_external","base_url_env_var":"","aliases":["minimax_oauth","minimax-oauth-io"],"api_mode":"anthropic_messages","models":["MiniMax-M3","MiniMax-M2.7","MiniMax-M2.7-highspeed"]},{"name":"anthropic","display_name":"Anthropic","env_vars":["ANTHROPIC_API_KEY","ANTHROPIC_TOKEN","CLAUDE_CODE_OAUTH_TOKEN"],"base_url":"https://api.anthropic.com","auth_type":"api_key","base_url_env_var":"ANTHROPIC_BASE_URL","aliases":["claude","claude-oauth","claude-code"],"api_mode":"anthropic_messages","models":["claude-fable-5","claude-sonnet-5","claude-opus-4-8","claude-opus-4-7","claude-opus-4-6","claude-sonnet-4-6","claude-opus-4-5-20251101","claude-sonnet-4-5-20250929","claude-opus-4-20250514","claude-sonnet-4-20250514","claude-haiku-4-5-20251001"]},{"name":"alibaba","display_name":"Qwen Cloud","env_vars":["DASHSCOPE_API_KEY"],"base_url":"https://dashscope-intl.aliyuncs.com/compatible-mode/v1","auth_type":"api_key","base_url_env_var":"DASHSCOPE_BASE_URL","aliases":["dashscope","alibaba-cloud","qwen-dashscope"],"models":["qwen3.8-max","qwen3.7-max","qwen3.7-plus","qwen3.6-plus","qwen3.6-flash","kimi-k2.5","qwen3.5-plus","qwen3-coder-plus","qwen3-coder-next","glm-5.2","glm-5","glm-4.7","deepseek-v4-pro","deepseek-v4-flash-0731","MiniMax-M2.5"]},{"name":"alibaba-coding-plan","display_name":"Alibaba Cloud (Coding Plan)","env_vars":["ALIBABA_CODING_PLAN_API_KEY","DASHSCOPE_API_KEY","ALIBABA_CODING_PLAN_BASE_URL"],"base_url":"https://coding-intl.dashscope.aliyuncs.com/v1","auth_type":"api_key","base_url_env_var":"ALIBABA_CODING_PLAN_BASE_URL","aliases":["alibaba_coding","alibaba-coding","dashscope-coding"],"models":["qwen3.7-plus","qwen3.6-plus","qwen3.5-plus","qwen3-max-2026-01-23","qwen3-coder-plus","qwen3-coder-next","kimi-k2.5","glm-5","glm-4.7","MiniMax-M2.5"]},{"name":"minimax-cn","display_name":"MiniMax (China)","env_vars":["MINIMAX_CN_API_KEY"],"base_url":"https://api.minimaxi.com/anthropic","auth_type":"api_key","base_url_env_var":"MINIMAX_CN_BASE_URL","aliases":["minimax-china","minimax_cn"],"api_mode":"anthropic_messages","models":["MiniMax-M3","MiniMax-M2.7","MiniMax-M2.5","MiniMax-M2.1","MiniMax-M2"]},{"name":"deepseek","display_name":"DeepSeek","env_vars":["DEEPSEEK_API_KEY"],"base_url":"https://api.deepseek.com/v1","auth_type":"api_key","base_url_env_var":"DEEPSEEK_BASE_URL","aliases":["deepseek-chat"],"models":["deepseek-v4-pro","deepseek-v4-flash"]},{"name":"xai","display_name":"xAI","env_vars":["XAI_API_KEY"],"base_url":"https://api.x.ai/v1","auth_type":"api_key","base_url_env_var":"XAI_BASE_URL","aliases":["grok","x-ai","x.ai"],"api_mode":"codex_responses","models":[]},{"name":"nvidia","display_name":"NVIDIA NIM","env_vars":["NVIDIA_API_KEY"],"base_url":"https://integrate.api.nvidia.com/v1","auth_type":"api_key","base_url_env_var":"NVIDIA_BASE_URL","aliases":["nvidia-nim"],"models":["nvidia/nemotron-3-ultra-550b-a55b","nvidia/nemotron-3-super-120b-a12b","nvidia/nemotron-3.5-lightning-30b-a3b","nvidia/nemotron-3-nano-omni-30b-a3b-reasoning","z-ai/glm-5.3","z-ai/glm-5.2","moonshotai/kimi-k2.6","minimaxai/minimax-m3"]},{"name":"ai-gateway","display_name":"Vercel AI Gateway","env_vars":["AI_GATEWAY_API_KEY"],"base_url":"https://ai-gateway.vercel.sh/v1","auth_type":"api_key","base_url_env_var":"AI_GATEWAY_BASE_URL","aliases":["vercel","vercel-ai-gateway","ai_gateway","aigateway"],"models":[]},{"name":"opencode-zen","display_name":"OpenCode Zen","env_vars":["OPENCODE_ZEN_API_KEY"],"base_url":"https://opencode.ai/zen/v1","auth_type":"api_key","base_url_env_var":"OPENCODE_ZEN_BASE_URL","aliases":["opencode","opencode_zen","zen"],"models":["x-preview-f-free","kimi-k3","kimi-k2.5","kimi-k2.6","gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gpt-5.5","gpt-5.5-pro","gpt-5.4-pro","gpt-5.4","gpt-5.4-mini","gpt-5.4-nano","gpt-5.3-codex","gpt-5.3-codex-spark","gpt-5.2","gpt-5.2-codex","gpt-5.1","gpt-5.1-codex","gpt-5.1-codex-max","gpt-5.1-codex-mini","gpt-5","gpt-5-codex","gpt-5-nano","claude-fable-5","claude-opus-5","claude-sonnet-5","claude-opus-4-8","claude-opus-4-7","claude-opus-4-6","claude-opus-4-5","claude-sonnet-4-6","claude-sonnet-4-5","claude-sonnet-4","claude-haiku-4-5","gemini-3.7-flash","gemini-3.6-flash","gemini-3.5-flash","gemini-3.5-flash-lite","gemini-3.1-pro","gemini-3-flash","grok-4.6","grok-4.5","grok-build-0.1","muse-spark-1.2","minimax-m3","minimax-m2.7","minimax-m2.5","glm-5.3","glm-5.3-flash","glm-5.2","glm-5.1","glm-5","kimi-k2.7-code","deepseek-v4-pro","deepseek-v4-flash","deepseek-v4-flash-free","qwen3.6-plus","qwen3.5-plus","big-pickle","mimo-v2.5-free","hy3-free","laguna-s-2.1-free","nemotron-3-ultra-free","nemotron-3.5-lightning-free","muse-spark-1.2-contributor-free"]},{"name":"opencode-go","display_name":"OpenCode Go","env_vars":["OPENCODE_GO_API_KEY"],"base_url":"https://opencode.ai/zen/go/v1","auth_type":"api_key","base_url_env_var":"OPENCODE_GO_BASE_URL","aliases":["opencode_go","go","opencode-go-sub"],"models":["kimi-k3","kimi-k2.7-code","kimi-k2.6","kimi-k2.5","gpt-5.6-luna","grok-4.5","glm-5.3","glm-5.3-flash","glm-5.2","glm-5.1","glm-5","mimo-v2.5-pro","mimo-v2.5","mimo-v2-pro","mimo-v2-omni","minimax-m3","minimax-m2.7","minimax-m2.5","deepseek-v4-pro","deepseek-v4-flash","qwen3.8-max","qwen3.7-max","qwen3.7-plus","qwen3.6-plus","qwen3.5-plus","hy3","hy3-preview","muse-spark-1.2-contributor","ox-alpha-free"]},{"name":"opencode-free","display_name":"OpenCode Free","env_vars":[],"base_url":"https://opencode.ai/zen/v1","auth_type":"api_key","base_url_env_var":"","aliases":["free","opencode_free"],"models":["deepseek-v4-flash-free","hy3-free","mimo-v2.5-free","laguna-s-2.1-free","nemotron-3-ultra-free","nemotron-3.5-lightning-free","muse-spark-1.2-contributor-free"]},{"name":"kilocode","display_name":"Kilo Code","env_vars":["KILOCODE_API_KEY"],"base_url":"https://api.kilo.ai/api/gateway","auth_type":"api_key","base_url_env_var":"KILOCODE_BASE_URL","aliases":["kilo-code","kilo","kilo-gateway"],"models":["anthropic/claude-opus-4.6","anthropic/claude-sonnet-4.6","openai/gpt-5.4","google/gemini-3-pro-preview","google/gemini-3-flash-preview"]},{"name":"huggingface","display_name":"HuggingFace","env_vars":["HF_TOKEN"],"base_url":"https://router.huggingface.co/v1","auth_type":"api_key","base_url_env_var":"HF_BASE_URL","aliases":["hf","hugging-face","huggingface-hub"],"models":["moonshotai/Kimi-K2.5","Qwen/Qwen3.5-397B-A17B","Qwen/Qwen3.5-35B-A3B","deepseek-ai/DeepSeek-V3.2","MiniMaxAI/MiniMax-M2.5","zai-org/GLM-5","XiaomiMiMo/MiMo-V2-Flash","moonshotai/Kimi-K2-Thinking","moonshotai/Kimi-K2.6"]},{"name":"xiaomi","display_name":"Xiaomi MiMo","env_vars":["XIAOMI_API_KEY"],"base_url":"https://api.xiaomimimo.com/v1","auth_type":"api_key","base_url_env_var":"XIAOMI_BASE_URL","aliases":["mimo","xiaomi-mimo"],"models":["mimo-v2.5-pro","mimo-v2.5","mimo-v2-pro","mimo-v2-omni","mimo-v2-flash"]},{"name":"tencent-tokenhub","display_name":"Tencent TokenHub","env_vars":["TOKENHUB_API_KEY"],"base_url":"https://tokenhub.tencentmaas.com/v1","auth_type":"api_key","base_url_env_var":"TOKENHUB_BASE_URL","models":["hy4-preview","hy3","hy3-preview"]},{"name":"tencent-tokenplan","display_name":"Tencent TokenPlan","env_vars":["TOKENPLAN_API_KEY"],"base_url":"https://api.lkeap.cloud.tencent.com/plan/anthropic","auth_type":"api_key","base_url_env_var":"TOKENPLAN_BASE_URL","models":["hy4-preview","hy3","hy3-preview"]},{"name":"ollama-cloud","display_name":"Ollama Cloud","env_vars":["OLLAMA_API_KEY"],"base_url":"https://ollama.com/v1","auth_type":"api_key","base_url_env_var":"OLLAMA_BASE_URL","aliases":["ollama_cloud"],"models":[]},{"name":"bedrock","display_name":"AWS Bedrock","env_vars":[],"base_url":"https://bedrock-runtime.us-east-1.amazonaws.com","auth_type":"aws_sdk","base_url_env_var":"BEDROCK_BASE_URL","aliases":["aws","aws-bedrock","amazon-bedrock","amazon"],"api_mode":"bedrock_converse","models":["us.anthropic.claude-sonnet-5","us.anthropic.claude-sonnet-4-6","us.anthropic.claude-opus-4-6-v1","us.anthropic.claude-haiku-4-5-20251001-v1:0","us.anthropic.claude-sonnet-4-5-20250929-v1:0","openai.gpt-5.5","openai.gpt-5.6-sol","openai.gpt-5.6-terra","openai.gpt-5.6-luna","us.amazon.nova-pro-v1:0","us.amazon.nova-lite-v1:0","us.amazon.nova-micro-v1:0","deepseek.v3.2","us.meta.llama4-maverick-17b-instruct-v1:0","us.meta.llama4-scout-17b-instruct-v1:0"]},{"name":"vertex","display_name":"Google Vertex AI","env_vars":[],"base_url":"https://aiplatform.googleapis.com","auth_type":"vertex","base_url_env_var":"","aliases":["google-vertex","vertex-ai","gcp-vertex"],"api_mode":"chat_completions","models":["google/gemini-3.1-pro-preview","google/gemini-3-pro-preview","google/gemini-3.6-flash","google/gemini-3.5-flash","google/gemini-3.5-flash-lite","google/gemini-3-flash-preview","google/gemini-3.1-flash-lite-preview","google/gemini-3.1-flash-lite"]},{"name":"azure-foundry","display_name":"Azure Foundry","env_vars":["AZURE_FOUNDRY_API_KEY","AZURE_FOUNDRY_BASE_URL"],"base_url":"","auth_type":"api_key","base_url_env_var":"AZURE_FOUNDRY_BASE_URL","aliases":["azure","azure-ai-foundry","azure-ai"],"models":[]},{"name":"alibaba-cn","aliases":["dashscope-cn","alibaba-cloud-cn"],"display_name":"Alibaba Cloud DashScope (China)","env_vars":["DASHSCOPE_API_KEY","DASHSCOPE_CN_BASE_URL"],"base_url":"https://dashscope.aliyuncs.com/compatible-mode/v1","models":["qwen3.8-max","qwen3.7-max","qwen3.7-plus","qwen3.6-plus","qwen3.6-flash","kimi-k2.5","qwen3.5-plus","qwen3-coder-plus","qwen3-coder-next","glm-5.2","glm-5","glm-4.7","deepseek-v4-pro","deepseek-v4-flash-0731","MiniMax-M2.5"],"base_url_env_var":"DASHSCOPE_CN_BASE_URL"},{"name":"alibaba-token-plan","aliases":["dashscope-token-plan"],"display_name":"Alibaba Cloud (Token Plan)","env_vars":["ALIBABA_TOKEN_PLAN_API_KEY","ALIBABA_TOKEN_PLAN_BASE_URL"],"base_url":"https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1","auth_type":"api_key","models":["qwen3.8-max-preview","qwen3.7-max","qwen3.7-plus","qwen3.6-plus","qwen3.6-flash","deepseek-v4-pro","deepseek-v4-flash","deepseek-v3.2","kimi-k2.7-code","kimi-k2.6","kimi-k2.5","glm-5.2","glm-5.1","glm-5"],"base_url_env_var":"ALIBABA_TOKEN_PLAN_BASE_URL"},{"name":"alibaba-token-plan-cn","aliases":["dashscope-token-plan-cn"],"display_name":"Alibaba Cloud (Token Plan, China)","env_vars":["ALIBABA_TOKEN_PLAN_API_KEY","ALIBABA_TOKEN_PLAN_CN_BASE_URL"],"base_url":"https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1","auth_type":"api_key","models":["qwen3.8-max-preview","qwen3.7-max","qwen3.7-plus","qwen3.6-plus","qwen3.6-flash","deepseek-v4-pro","deepseek-v4-flash","deepseek-v3.2","kimi-k2.7-code","kimi-k2.6","kimi-k2.5","glm-5.2","glm-5.1","glm-5"],"base_url_env_var":"ALIBABA_TOKEN_PLAN_CN_BASE_URL"},{"name":"alibaba-coding-plan-cn","aliases":["alibaba-coding-cn","dashscope-coding-cn"],"display_name":"Alibaba Cloud (Coding Plan, China)","env_vars":["ALIBABA_CODING_PLAN_API_KEY","DASHSCOPE_API_KEY","ALIBABA_CODING_PLAN_CN_BASE_URL"],"base_url":"https://coding.dashscope.aliyuncs.com/v1","auth_type":"api_key","models":["qwen3.7-plus","qwen3.6-plus","qwen3.5-plus","qwen3-max-2026-01-23","qwen3-coder-plus","qwen3-coder-next","kimi-k2.5","glm-5","glm-4.7","MiniMax-M2.5"],"base_url_env_var":"ALIBABA_CODING_PLAN_CN_BASE_URL"},{"name":"commandcode","aliases":["commandcode-chat"],"api_mode":"chat_completions","env_vars":["COMMANDCODE_API_KEY","COMMANDCODE_BASE_URL"],"display_name":"CommandCode","base_url":"https://api.commandcode.ai/provider/v1","models":["deepseek/deepseek-v4-pro","deepseek/deepseek-v4-flash","Qwen/Qwen3.7-Max","Qwen/Qwen3.6-Plus","moonshotai/Kimi-K2.6","zai-org/GLM-5.1","MiniMaxAI/MiniMax-M2.7","stepfun/Step-3.5-Flash","xiaomi/mimo-v2.5-pro","google/gemini-3.5-flash","gpt-5.5"],"base_url_env_var":"COMMANDCODE_BASE_URL"},{"name":"commandcode-anthropic","aliases":["commandcode-claude"],"api_mode":"anthropic_messages","env_vars":["COMMANDCODE_API_KEY","COMMANDCODE_ANTHROPIC_BASE_URL"],"display_name":"CommandCode (Anthropic)","base_url":"https://api.commandcode.ai/provider/v1","models":["claude-sonnet-4-6","claude-opus-4-7","claude-haiku-4-5-20251001"],"base_url_env_var":"COMMANDCODE_ANTHROPIC_BASE_URL"},{"name":"custom","aliases":["ollama","local","vllm","llamacpp","llama.cpp","llama-cpp"],"env_vars":[],"base_url":"","models":[]},{"name":"deepinfra","aliases":["deep-infra","deepinfra-ai"],"display_name":"DeepInfra","env_vars":["DEEPINFRA_API_KEY","DEEPINFRA_BASE_URL"],"base_url":"https://api.deepinfra.com/v1/openai","auth_type":"api_key","models":[],"base_url_env_var":"DEEPINFRA_BASE_URL"},{"name":"fireworks","aliases":["fireworks-ai","fw"],"display_name":"Fireworks AI","env_vars":["FIREWORKS_API_KEY"],"base_url":"https://api.fireworks.ai/inference/v1","auth_type":"api_key","models":["accounts/fireworks/models/kimi-k2p6","accounts/fireworks/models/glm-5p2","accounts/fireworks/models/kimi-k2p7-code"]},{"name":"meta-ai","aliases":["meta","muse","muse-spark","model-api","msl"],"display_name":"Meta Model API","env_vars":["MODEL_API_KEY","META_API_KEY","META_MODEL_API_KEY","META_BASE_URL"],"auth_type":"api_key","api_mode":"codex_responses","models":["muse-spark-1.2","muse-spark-1.2-contributor"],"base_url":"https://api.meta.ai/v1","base_url_env_var":"META_BASE_URL"},{"name":"nebius-token-factory","aliases":["nebius","nebius-tokenfactory","nebius-tf","token-factory","tokenfactory"],"display_name":"Nebius Token Factory","env_vars":["NEBIUS_API_KEY","NEBIUS_TOKEN_FACTORY_API_KEY","NEBIUS_BASE_URL"],"base_url":"https://api.tokenfactory.nebius.com/v1","models_url":"https://api.tokenfactory.nebius.com/v1/models?verbose=true","auth_type":"api_key","models":["Qwen/Qwen3.5-397B-A17B-fast","deepseek-ai/DeepSeek-V4-Pro","zai-org/GLM-5.1","moonshotai/Kimi-K2.5-fast","MiniMaxAI/MiniMax-M2.5-fast","deepseek-ai/DeepSeek-V3.2-fast","NousResearch/Hermes-4-70B","openai/gpt-oss-120b-fast","meta-llama/Llama-3.3-70B-Instruct"],"base_url_env_var":"NEBIUS_BASE_URL"},{"name":"novita","aliases":["novita-ai","novitaai"],"display_name":"NovitaAI","env_vars":["NOVITA_API_KEY","NOVITA_BASE_URL"],"base_url":"https://api.novita.ai/openai/v1","auth_type":"api_key","models":["moonshotai/kimi-k2.5","minimax/minimax-m2.7","zai-org/glm-5","deepseek/deepseek-v3-0324","deepseek/deepseek-r1-0528","qwen/qwen3-235b-a22b-fp8"],"base_url_env_var":"NOVITA_BASE_URL"},{"name":"openrouter","aliases":["or"],"env_vars":["OPENROUTER_API_KEY"],"display_name":"OpenRouter","base_url":"https://openrouter.ai/api/v1","models_url":"https://openrouter.ai/api/v1/models","models":["anthropic/claude-fable-5.1","anthropic/claude-fable-5","anthropic/claude-opus-5","anthropic/claude-opus-5-fast","anthropic/claude-opus-4.8","anthropic/claude-opus-4.8-fast","anthropic/claude-sonnet-5","anthropic/claude-haiku-4.5","openai/gpt-5.6-sol","openai/gpt-5.6-sol-pro","openai/gpt-5.6-terra","openai/gpt-5.6-terra-pro","openai/gpt-5.6-luna","openai/gpt-5.6-luna-pro","openai/gpt-5.5","openai/gpt-5.5-pro","openai/gpt-5.4-mini","google/gemini-3.1-pro-preview","google/gemini-3.7-flash","x-ai/grok-4.6","deepseek/deepseek-v4-pro","deepseek/deepseek-v4-pro-0813","deepseek/deepseek-v4-flash","deepseek/deepseek-v4-flash-0731","qwen/qwen3.8-max","qwen/qwen3.8-flash","moonshotai/kimi-k3","minimax/minimax-m3","z-ai/glm-5.3","z-ai/glm-5.3-flash","z-ai/glm-5.2","xiaomi/mimo-v2.5-pro","tencent/hy4-preview","tencent/hy3","stepfun/step-3.7-flash","nvidia/nemotron-3-super-120b-a12b","meta/muse-spark-1.2","sakana/fugu-ultra","openrouter/pareto-code","thinkingmachines/inkling:free","thinkingmachines/inkling-small:free","minimax/minimax-m3:free","z-ai/glm-5.2:free","poolside/laguna-s-2.1:free","poolside/laguna-xs-2.1:free","nvidia/nemotron-3-super-120b-a12b:free","nvidia/nemotron-3-ultra-550b-a55b:free","nvidia/nemotron-3.5-lightning:free"]},{"name":"router","aliases":["ramp-router","ramp","router.com"],"api_mode":"codex_responses","display_name":"Ramp Router","env_vars":["RAMP_ROUTER_API_KEY","ROUTER_API_KEY","RAMP_ROUTER_BASE_URL"],"auth_type":"api_key","models":[],"base_url":"https://api.router.com/v1","base_url_env_var":"RAMP_ROUTER_BASE_URL"},{"name":"upstage","aliases":["solar"],"display_name":"Upstage Solar","env_vars":["UPSTAGE_API_KEY","UPSTAGE_BASE_URL"],"base_url":"https://api.upstage.ai/v1","auth_type":"api_key","models":["solar-pro3"],"base_url_env_var":"UPSTAGE_BASE_URL"}],"curated":[{"provider":"openai-api","id":"gpt-5.6","label":"GPT-5.6"},{"provider":"openai-api","id":"gpt-5.6-sol","label":"GPT-5.6 Sol"},{"provider":"openai-api","id":"gpt-5.4","label":"GPT-5.4"},{"provider":"anthropic","id":"claude-fable-5-1","label":"Claude Fable 5.1"},{"provider":"anthropic","id":"claude-opus-5","label":"Claude Opus 5"},{"provider":"anthropic","id":"claude-sonnet-5","label":"Claude Sonnet 5"},{"provider":"xai","id":"grok-4.6","label":"Grok 4.6"},{"provider":"openrouter","id":"anthropic/claude-opus-5","label":"Claude Opus 5 (OpenRouter)"},{"provider":"openrouter","id":"openai/gpt-5.6-sol","label":"GPT-5.6 Sol (OpenRouter)"},{"provider":"openrouter","id":"google/gemini-3.1-pro-preview","label":"Gemini 3.1 Pro (OpenRouter)"},{"provider":"ollama","id":"llama3.3","label":"Llama 3.3 (local)"},{"provider":"ollama","id":"qwen3","label":"Qwen 3 (local)"},{"provider":"zai","id":"glm-5.2","label":"GLM-5.2"},{"provider":"zai","id":"glm-5","label":"GLM-5"},{"provider":"zai","id":"glm-4.5-flash","label":"GLM-4.5 Flash"}]}"###;

use crate::{Error, Result, common};
use base64::Engine;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};

fn catalog() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| serde_json::from_str(CATALOG).expect("provider catalog"))
}
fn profiles() -> &'static [Value] {
    catalog()["providers"].as_array().unwrap()
}
fn string<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub fn canonical_provider(name: &str) -> String {
    let name = name.trim().to_lowercase();
    let alias = match name.as_str() {
        "openai" | "gpt" => "openai-api",
        "chatgpt" | "codex" => "openai-codex",
        "claude" => "anthropic",
        "moonshotai" => "kimi-coding",
        "moonshotai-cn" => "kimi-coding-cn",
        "grok" => "xai",
        "glm" | "z.ai" | "z-ai" => "zai",
        _ => &name,
    };
    profiles()
        .iter()
        .find(|p| {
            p["aliases"]
                .as_array()
                .is_some_and(|a| a.iter().any(|s| s == alias))
        })
        .map(|p| string(p, "name").to_owned())
        .unwrap_or_else(|| alias.to_owned())
}
pub fn pi_provider(name: &str) -> String {
    match canonical_provider(name).as_str() {
        "openai-api" => "openai",
        "gemini" => "google",
        "vertex" => "google-vertex",
        "bedrock" => "amazon-bedrock",
        "copilot" => "github-copilot",
        "kimi-coding" => "moonshotai",
        "kimi-coding-cn" => "moonshotai-cn",
        "xai-oauth" => "xai",
        "opencode-zen" => "opencode",
        "ai-gateway" => "vercel-ai-gateway",
        other => other,
    }
    .to_owned()
}
fn profile(name: &str) -> Result<&'static Value> {
    profiles()
        .iter()
        .find(|p| p["name"] == name)
        .ok_or_else(|| Error::new(4206, format!("unknown provider: {name}")))
}
fn read_json(path: &Path) -> Result<Value> {
    match fs::read(path) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|_| Error::new(5200, format!("invalid JSON in {}", path.display())))?;
            if !value.is_object() {
                return Err(Error::new(
                    5200,
                    format!("expected JSON object in {}", path.display()),
                ));
            }
            Ok(value)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.into()),
    }
}
fn write_json(path: &Path, value: &Value) -> Result<()> {
    common::atomic_write(
        path,
        &serde_json::to_vec_pretty(value).map_err(|e| Error::new(5200, e.to_string()))?,
    )
}
fn credentials_lock() -> &'static Mutex<()> {
    common::credentials_lock()
}
fn key(home: &Path, p: &Value) -> Result<Option<String>> {
    let disabled = read_json(&home.join("providers-disabled.json"))?;
    if disabled[string(p, "name")] == true {
        return Ok(None);
    }
    let values = common::env_values(home)?;
    Ok(p["env_vars"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|name| !name.ends_with("_BASE_URL"))
        .find_map(|name| {
            values
                .get(name)
                .cloned()
                .or_else(|| std::env::var(name).ok())
                .filter(|s| !s.is_empty())
        }))
}
fn oauth(home: &Path, slug: &str) -> Result<Value> {
    Ok(read_json(&home.join("auth.json"))?["providers"][slug].clone())
}
fn configured(home: &Path, p: &Value) -> Result<bool> {
    let slug = string(p, "name");
    if read_json(&home.join("providers-disabled.json"))?[slug] == true {
        return Ok(false);
    }
    if key(home, p)?.is_some() {
        return Ok(true);
    }
    let state = oauth(home, slug)?;
    if ["access_token", "api_key", "agent_key"]
        .iter()
        .any(|k| state[k].as_str().is_some_and(|v| !v.is_empty()))
        || state["tokens"]["access_token"]
            .as_str()
            .is_some_and(|v| !v.is_empty())
    {
        return Ok(true);
    }
    if matches!(slug, "custom" | "ollama" | "lmstudio") {
        let cfg = common::read_config(home)?;
        return Ok(cfg["model"]["base_url"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
            && canonical_provider(string(&cfg["model"], "provider")) == slug);
    }
    Ok(false)
}
fn env_paths(home: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = vec![home.to_path_buf()];
    if home.join("profiles").is_dir() {
        for entry in fs::read_dir(home.join("profiles"))? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                paths.push(entry.path());
            }
        }
    }
    Ok(paths)
}
fn edit_env(path: &Path, names: &[&str], replacement: Option<(&str, &str)>) -> Result<()> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    let mut lines: Vec<String> = text
        .lines()
        .filter(|line| {
            !line
                .trim()
                .strip_prefix("export ")
                .unwrap_or(line.trim())
                .split_once('=')
                .is_some_and(|(k, _)| names.contains(&k.trim()))
        })
        .map(str::to_owned)
        .collect();
    if let Some((name, value)) = replacement {
        lines.push(format!(
            "{name}='{}'",
            value.replace('\\', "\\\\").replace('\'', "\\'")
        ));
    }
    common::atomic_write(path, format!("{}\n", lines.join("\n")).as_bytes())
}
fn scrub_mirrors(value: &mut Value, old: &[String], replacement: Option<&str>) {
    match value {
        Value::Object(object) => {
            if object
                .get("api_key")
                .and_then(Value::as_str)
                .is_some_and(|v| old.iter().any(|k| k == v))
            {
                if let Some(key) = replacement {
                    object.insert("api_key".into(), json!(key));
                } else {
                    object.remove("api_key");
                }
            }
            for child in object.values_mut() {
                scrub_mirrors(child, old, replacement);
            }
        }
        Value::Array(values) => {
            for child in values {
                scrub_mirrors(child, old, replacement);
            }
        }
        _ => {}
    }
}
fn update_mirrors(home: &Path, names: &[&str], replacement: Option<&str>) -> Result<()> {
    for dir in env_paths(home)? {
        let values = common::env_values(&dir)?;
        let old = names
            .iter()
            .filter_map(|name| {
                values
                    .get(*name)
                    .cloned()
                    .or_else(|| std::env::var(name).ok())
            })
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>();
        if dir.join("config.yaml").exists() && !old.is_empty() {
            let mut cfg = common::read_config(&dir)?;
            scrub_mirrors(&mut cfg, &old, replacement);
            common::write_config(&dir, &cfg)?;
        }
    }
    let mut auth = read_json(&home.join("auth.json"))?;
    if let Some(pool) = auth["credential_pool"].as_object_mut() {
        for entries in pool.values_mut() {
            if let Some(entries) = entries.as_array_mut() {
                entries.retain(|entry| {
                    !names
                        .iter()
                        .any(|name| entry["source"] == format!("env:{name}"))
                });
            }
        }
        write_json(&home.join("auth.json"), &auth)?;
    }
    Ok(())
}
pub fn set_key(home: &Path, provider: &str, value: &str) -> Result<Value> {
    let slug = canonical_provider(provider);
    let p = profile(&slug)?;
    let env = p["env_vars"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .ok_or_else(|| Error::new(4207, "provider has no API-key environment variable"))?;
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err(Error::new(
            4200,
            "API key must be nonempty and contain no control characters",
        ));
    }
    let _lock = credentials_lock()
        .lock()
        .map_err(|_| Error::new(5200, "credentials lock unavailable"))?;
    let mut disabled = read_json(&home.join("providers-disabled.json"))?;
    update_mirrors(home, &[env], Some(value.trim()))?;
    for dir in env_paths(home)? {
        edit_env(&dir.join(".env"), &[env], Some((env, value.trim())))?;
    }
    disabled[&slug] = json!(false);
    write_json(&home.join("providers-disabled.json"), &disabled)?;
    Ok(json!({"provider":slug,"configured":true}))
}
pub fn clear_key(home: &Path, provider: &str) -> Result<Value> {
    let slug = canonical_provider(provider);
    let p = profile(&slug)?;
    let _lock = credentials_lock()
        .lock()
        .map_err(|_| Error::new(5200, "credentials lock unavailable"))?;
    let names = p["env_vars"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    let mut disabled = read_json(&home.join("providers-disabled.json"))?;
    update_mirrors(home, &names, None)?;
    let mut auth = read_json(&home.join("auth.json"))?;
    for dir in env_paths(home)? {
        edit_env(&dir.join(".env"), &names, None)?;
    }
    if let Some(pool) = auth["credential_pool"].as_object_mut() {
        pool.remove(&slug);
    }
    if let Some(providers) = auth["providers"].as_object_mut() {
        providers.remove(&slug);
    }
    if auth["active_provider"] == slug {
        auth.as_object_mut().unwrap().remove("active_provider");
    }
    write_json(&home.join("auth.json"), &auth)?;
    disabled[&slug] = json!(true);
    let epoch_key = format!("__epoch_{slug}");
    disabled[&epoch_key] = json!(disabled[&epoch_key].as_u64().unwrap_or(0).saturating_add(1));
    write_json(&home.join("providers-disabled.json"), &disabled)?;
    Ok(json!({"provider":slug,"configured":false}))
}
fn custom_profiles(cfg: &Value) -> Vec<Value> {
    let mut rows = Vec::new();
    let mut add = |name: &str, entry: &Value| {
        let base = entry["base_url"]
            .as_str()
            .or_else(|| entry["api"].as_str())
            .unwrap_or("");
        if name.is_empty() || base.is_empty() {
            return;
        }
        let slug = name.to_lowercase();
        let mut models = entry["models"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|m| {
                m.as_str()
                    .map(str::to_owned)
                    .or_else(|| m["id"].as_str().map(str::to_owned))
            })
            .collect::<Vec<_>>();
        if let Some(model) = entry["model"]
            .as_str()
            .or_else(|| entry["default_model"].as_str())
            && !models.iter().any(|m| m == model)
        {
            models.push(model.to_owned());
        }
        rows.push(json!({"name":slug,"display_name":name,"base_url":base,"api_key":entry["api_key"],"env_vars":entry["key_env"].as_str().map(|k|vec![k]).unwrap_or_default(),"api_mode":entry["api_mode"].as_str().unwrap_or("chat_completions"),"auth_type":"api_key","models":models,"aliases":[format!("custom:{slug}")]}));
    };
    if let Some(providers) = cfg["providers"].as_object() {
        for (name, entry) in providers {
            add(name, entry);
        }
    }
    if let Some(providers) = cfg["custom_providers"].as_array() {
        for entry in providers {
            add(string(entry, "name"), entry);
        }
    }
    rows
}
fn custom_key(home: &Path, p: &Value) -> Result<Option<String>> {
    let literal = string(p, "api_key");
    if let Some(name) = literal.strip_prefix("${").and_then(|s| s.strip_suffix('}')) {
        return Ok(common::env_values(home)?
            .get(name)
            .cloned()
            .or_else(|| std::env::var(name).ok()));
    }
    if !literal.is_empty() {
        return Ok(Some(literal.to_owned()));
    }
    key(home, p)
}
pub fn list_providers(home: &Path) -> Result<Value> {
    let mut rows=profiles().iter().map(|p|Ok(json!({"id":p["name"],"label":p["display_name"].as_str().unwrap_or(string(p,"name")),"configured":configured(home,p)?,"auth_type":p["auth_type"].as_str().unwrap_or("api_key"),"key_supported":p["env_vars"].as_array().is_some_and(|v|!v.is_empty()),"models_source":if string(p,"models_url").is_empty(){"registry"}else{"live"}}))).collect::<Result<Vec<Value>>>()?;
    for p in custom_profiles(&common::read_config(home)?) {
        rows.push(json!({"id":p["name"],"label":p["display_name"],"configured":true,"auth_type":"api_key","key_supported":!p["env_vars"].as_array().unwrap().is_empty(),"models_source":"live"}));
    }
    rows.sort_by_key(|p| {
        (
            !p["configured"].as_bool().unwrap_or(false),
            string(p, "label").to_lowercase(),
        )
    });
    Ok(json!({"providers":rows}))
}
fn catalog_models(slug: &str) -> Vec<String> {
    let mut models = profiles()
        .iter()
        .find(|p| p["name"] == slug)
        .and_then(|p| p["models"].as_array())
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for row in catalog()["curated"].as_array().unwrap() {
        if canonical_provider(string(row, "provider")) == slug {
            let id = string(row, "id").to_owned();
            if !models.contains(&id) {
                models.push(id)
            }
        }
    }
    models
}
fn metadata(cache: &Value, cfg: &Value, provider: &str, model: &str) -> Value {
    let mapped = pi_provider(provider);
    let raw = cache[provider]["models"]
        .get(model)
        .or_else(|| cache[&mapped]["models"].get(model));
    let mut data = raw.cloned().unwrap_or_else(|| json!({}));
    let overrides = &cfg["model_overrides"];
    let patch = overrides[provider]
        .get(model)
        .or_else(|| overrides[&mapped].get(model));
    let defaults = if raw.is_none() {
        overrides[provider]
            .get("_default")
            .or_else(|| overrides.get("_default"))
    } else {
        None
    };
    for patch in defaults.into_iter().chain(patch) {
        if let Some(context) = patch["context_window"].as_u64() {
            data["limit"]["context"] = json!(context)
        }
        if let Some(output) = patch["max_output_tokens"].as_u64() {
            data["limit"]["output"] = json!(output)
        }
        if let Some(reasoning) = patch["supports_reasoning"].as_bool() {
            data["reasoning"] = json!(reasoning)
        }
        if let Some(vision) = patch["supports_vision"].as_bool() {
            data["modalities"]["input"] = if vision {
                json!(["text", "image"])
            } else {
                json!(["text"])
            }
        }
    }
    data
}
fn model_row(cache: &Value, cfg: &Value, provider: &str, id: &str) -> Value {
    let data = metadata(cache, cfg, provider, id);
    let mut row = json!({"provider":provider,"id":id,"label":id});
    if let Some(context) = data["limit"]["context"].as_u64() {
        row["context"] = json!(context)
    }
    for (source, target) in [("input", "input_cost"), ("output", "output_cost")] {
        if let Some(cost) = data["cost"][source].as_f64() {
            row[target] = json!(if cost == 0.0 {
                "free".to_owned()
            } else {
                format!("${cost:.2}")
            })
        }
    }
    row
}
fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::new(5200, "HTTP client unavailable"))
}
fn http_error(e: reqwest::Error) -> Error {
    Error::new(
        4211,
        format!(
            "provider request failed: {}",
            if e.is_timeout() {
                "timeout"
            } else if e.is_connect() {
                "connection failed"
            } else {
                "invalid response"
            }
        ),
    )
}
async fn live_models(home: &Path, p: &Value) -> Result<Vec<String>> {
    let cfg = common::read_config(home)?;
    let slug = string(p, "name");
    let base = if canonical_provider(string(&cfg["model"], "provider")) == slug {
        cfg["model"]["base_url"]
            .as_str()
            .unwrap_or(string(p, "base_url"))
    } else {
        string(p, "base_url")
    };
    let url = if !string(p, "models_url").is_empty() {
        string(p, "models_url").to_owned()
    } else {
        format!("{}/models", base.trim_end_matches('/'))
    };
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Ok(vec![]);
    }
    let mut req = client()?.get(url);
    if let Some(k) = custom_key(home, p)? {
        req = if slug == "anthropic" {
            req.header("x-api-key", k)
                .header("anthropic-version", "2023-06-01")
        } else {
            req.bearer_auth(k)
        }
    }
    let response = req.send().await.map_err(http_error)?;
    if !response.status().is_success() {
        return Err(Error::new(
            4211,
            format!(
                "model catalog request failed (HTTP {})",
                response.status().as_u16()
            ),
        ));
    }
    let data: Value = response.json().await.map_err(http_error)?;
    let mut models = data["data"]
        .as_array()
        .or_else(|| data["models"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|m| m["id"].as_str().or_else(|| m["name"].as_str()))
        .map(|s| s.trim_start_matches("models/").to_owned())
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    Ok(models)
}
pub async fn model_options(home: &Path, p: &Value) -> Result<Value> {
    let cfg = common::read_config(home)?;
    let current = canonical_provider(string(&cfg["model"], "provider"));
    let mut rows = vec![];
    for provider in profiles() {
        let slug = string(provider, "name");
        let configured = configured(home, provider)?;
        let mut models = if configured || p["include_unconfigured"] == true {
            catalog_models(slug)
        } else {
            vec![]
        };
        let mut source = "catalog";
        let mut error = None;
        if p["refresh"] == true
            && configured
            && (string(p, "provider").is_empty()
                || canonical_provider(string(p, "provider")) == slug)
        {
            match live_models(home, provider).await {
                Ok(m) if !m.is_empty() => {
                    models = m;
                    source = "live"
                }
                Ok(_) => {}
                Err(e) => error = Some(e.message),
            }
        }
        let mut row = json!({"slug":slug,"name":provider["display_name"].as_str().unwrap_or(slug),"is_current":current==slug,"total_models":models.len(),"models":models,"authenticated":configured,"auth_type":provider["auth_type"].as_str().unwrap_or("api_key"),"key_env":provider["env_vars"][0].as_str().unwrap_or(""),"source":source,"pricing":{}});
        if let Some(error) = error {
            row["error"] = json!(error)
        }
        rows.push(row);
    }
    for provider in custom_profiles(&cfg) {
        let slug = string(&provider, "name");
        let active = current == slug || current == format!("custom:{slug}");
        let mut models = provider["models"].as_array().cloned().unwrap_or_default();
        if active
            && let Some(model) = cfg["model"]["default"].as_str()
            && !models.iter().any(|id| id == model)
        {
            models.push(json!(model));
        }
        let mut error = None;
        if p["refresh"] == true
            && (string(p, "provider").is_empty()
                || canonical_provider(string(p, "provider")) == slug
                || canonical_provider(string(p, "provider")) == format!("custom:{slug}"))
        {
            match live_models(home, &provider).await {
                Ok(ids) if !ids.is_empty() => models = ids.into_iter().map(Value::from).collect(),
                Err(e) => error = Some(e.message),
                _ => {}
            }
        }
        let mut row = json!({"slug":slug,"name":provider["display_name"],"aliases":provider["aliases"],"is_user_defined":true,"is_current":active,"total_models":models.len(),"models":models,"authenticated":true,"auth_type":"api_key","source":"custom","pricing":{}});
        if let Some(error) = error {
            row["error"] = json!(error);
        }
        rows.push(row);
    }
    Ok(
        json!({"providers":rows,"model":cfg["model"]["default"].as_str().unwrap_or(""),"provider":current}),
    )
}
pub async fn list_models(home: &Path, p: &Value) -> Result<Value> {
    let slug = canonical_provider(string(p, "provider"));
    let curated = catalog()["curated"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| slug.is_empty() || canonical_provider(string(m, "provider")) == slug)
        .cloned()
        .collect::<Vec<_>>();
    let mut options = p.clone();
    if !options.is_object() {
        options = json!({})
    }
    if !slug.is_empty() && options.get("include_unconfigured").is_none() {
        options["include_unconfigured"] = json!(true)
    }
    let options = model_options(home, &options).await?;
    let cache = read_json(&home.join("models_dev_cache.json")).unwrap_or_else(|_| json!({}));
    let cfg = common::read_config(home)?;
    let mut all = vec![];
    let mut live = false;
    let mut errors = vec![];
    for row in options["providers"].as_array().unwrap() {
        let provider = string(row, "slug");
        if !slug.is_empty()
            && slug != provider
            && !row["aliases"]
                .as_array()
                .is_some_and(|aliases| aliases.iter().any(|alias| alias == &slug))
        {
            continue;
        }
        live |= row["source"] == "live";
        if let Some(error) = row["error"].as_str() {
            errors.push(error.to_owned())
        }
        let mut ids = row["models"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if ids.is_empty() {
            ids = catalog_models(provider)
        }
        for id in ids {
            all.push(model_row(&cache, &cfg, provider, &id))
        }
    }
    all.sort_by_key(|v| string(v, "label").to_lowercase());
    let mut output = json!({"curated":curated,"all_source":if all.is_empty(){"none"}else if live{"mixed"}else{"catalog"},"all":all});
    if !errors.is_empty() {
        output["error"] = json!(errors.join("; "))
    }
    Ok(output)
}

/// Copy Hermes grants into a dedicated Pi directory without exposing credentials to RPC clients.
/// Pi refreshes supported OAuth credentials in this store. Never rewrite an existing newer grant.
pub fn prepare_pi(home: &Path, agent_dir: &Path) -> Result<()> {
    prepare_pi_config(home, None, agent_dir)
}
pub fn prepare_pi_for_bot(home: &Path, bot: &str, agent_dir: &Path) -> Result<()> {
    common::identifier(bot)?;
    prepare_pi_config(home, Some(&home.join("profiles").join(bot)), agent_dir)
}
fn prepare_pi_config(home: &Path, profile_home: Option<&Path>, agent_dir: &Path) -> Result<()> {
    let _lock = credentials_lock()
        .lock()
        .map_err(|_| Error::new(5200, "credentials lock unavailable"))?;
    let mut cfg = common::read_config(home)?;
    if let Some(profile_home) = profile_home {
        let profile_cfg = common::read_config(profile_home)?;
        for key in [
            "model_overrides",
            "providers",
            "custom_providers",
            "fallback_providers",
        ] {
            if profile_cfg.get(key).is_some() {
                cfg[key] = profile_cfg[key].clone();
            }
        }
        if let Some(model) = profile_cfg["model"].as_object() {
            if !cfg["model"].is_object() {
                cfg["model"] = json!({});
            }
            for (key, value) in model {
                cfg["model"][key] = value.clone();
            }
        }
    }
    let selected_provider = canonical_provider(string(&cfg["model"], "provider"));
    let mut fallbacks = cfg["fallback_providers"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for row in common::rows(
        &crate::db::open(home)?,
        "SELECT value FROM settings WHERE key='fallback_model'",
        &[],
    )? {
        if let Ok(Value::String(choice)) = serde_json::from_str::<Value>(string(&row, "value"))
            && let Some((provider, model)) = choice.split_once('/')
        {
            fallbacks.push(json!({"provider":provider,"model":model}));
        }
    }
    let mut auth = read_json(&agent_dir.join("auth.json"))?;
    let disabled = read_json(&home.join("providers-disabled.json"))?;
    for p in profiles() {
        let slug = string(p, "name");
        let pi = pi_provider(slug);
        // xAI API and subscription credentials share a Pi transport. Use the bot's selected grant.
        if matches!(slug, "xai" | "xai-oauth")
            && matches!(selected_provider.as_str(), "xai" | "xai-oauth")
            && slug != selected_provider
        {
            continue;
        }
        if slug == "copilot-acp" && disabled[slug] != true {
            auth[&pi] = json!({"type":"api_key","key":"external-process"});
        }
        if disabled[slug] == true {
            if let Some(object) = auth.as_object_mut() {
                object.remove(&pi);
            }
            continue;
        }
        let profile_key = profile_home.map(|dir| key(dir, p)).transpose()?.flatten();
        let inline_key = if slug == selected_provider {
            cfg["model"]["api_key"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        } else {
            None
        };
        if let Some(key) = inline_key.or(profile_key).or(key(home, p)?) {
            auth[&pi] = json!({"type":"api_key","key":key});
            continue;
        }
        let profile_state = profile_home
            .map(|dir| oauth(dir, slug))
            .transpose()?
            .unwrap_or(Value::Null);
        let mut state = if profile_state.is_object() {
            profile_state
        } else {
            oauth(home, slug)?
        };
        if slug == "qwen-oauth"
            && string(&state, "access_token").is_empty()
            && !state["tokens"].is_object()
        {
            state = import_qwen(home)?;
        }
        let tokens = if state["tokens"].is_object() {
            &state["tokens"]
        } else {
            &state
        };
        let access = string(tokens, "access_token");
        if access.is_empty() {
            continue;
        }
        let expires = tokens["expires_at"]
            .as_f64()
            .map(|v| v * 1000.0)
            .or_else(|| {
                tokens["expires_at"]
                    .as_str()
                    .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
                    .map(|v| v.timestamp_millis() as f64)
            })
            .unwrap_or(0.0);
        if auth[&pi]["type"] == "oauth" && auth[&pi]["expires"].as_f64().unwrap_or(0.0) >= expires {
            continue;
        }
        if matches!(slug, "openai-codex" | "xai-oauth" | "anthropic") {
            let mut credential = json!({"type":"oauth","access":access,"refresh":string(tokens,"refresh_token"),"expires":expires});
            if slug == "openai-codex"
                && let Some(claims) = jwt_claims(access)
            {
                credential["accountId"] =
                    claims["https://api.openai.com/auth"]["chatgpt_account_id"].clone();
                if expires == 0.0 {
                    credential["expires"] = json!(claims["exp"].as_f64().unwrap_or(0.0) * 1000.0)
                }
            }
            auth[&pi] = credential;
        } else {
            auth[&pi] = json!({"type":"api_key","key":state["agent_key"].as_str().filter(|s|!s.is_empty()).unwrap_or(access)});
        }
    }
    write_json(&agent_dir.join("auth.json"), &auth)?;
    let mut providers = json!({});
    // Providers Pi implements natively retain their own transport and model metadata.
    const NATIVE: &[&str] = &[
        "openai",
        "openai-codex",
        "anthropic",
        "google",
        "google-vertex",
        "amazon-bedrock",
        "github-copilot",
        "openrouter",
        "xai",
        "deepseek",
        "fireworks",
        "huggingface",
        "kimi-coding",
        "moonshotai",
        "moonshotai-cn",
        "minimax",
        "minimax-cn",
        "nvidia",
        "opencode",
        "opencode-go",
        "vercel-ai-gateway",
        "xiaomi",
        "zai",
        "groq",
        "cerebras",
        "mistral",
    ];
    // Snapshot of ids and transports from the pinned Pi SDK; built-in metadata stays intact.
    let pi_catalog: Value =
        serde_json::from_str(include_str!("pi_catalog.json")).expect("valid pinned Pi catalog");
    let cache = read_json(&home.join("models_dev_cache.json")).unwrap_or_else(|_| json!({}));
    for p in profiles() {
        let slug = string(p, "name");
        let pi = pi_provider(slug);
        let selected = canonical_provider(string(&cfg["model"], "provider")) == slug;
        // ACP's custom stream is registered by the bundled Pi extension.
        if slug == "copilot-acp" {
            continue;
        }
        let env_name = string(p, "base_url_env_var");
        let override_url = if env_name.is_empty() {
            None
        } else {
            profile_home
                .map(common::env_values)
                .transpose()?
                .and_then(|env| env.get(env_name).cloned())
                .or(common::env_values(home)?.get(env_name).cloned())
                .or_else(|| std::env::var(env_name).ok())
                .filter(|v| !v.is_empty())
        };
        let configured_url = if selected {
            cfg["model"]["base_url"].as_str().filter(|s| !s.is_empty())
        } else {
            None
        };
        let native = NATIVE.contains(&pi.as_str());
        let override_base = configured_url.is_some() || override_url.is_some() || slug == "zai";
        let base = configured_url
            .or(override_url.as_deref())
            .unwrap_or(string(p, "base_url"));
        if base.is_empty() {
            continue;
        }
        let mut ids = catalog_models(slug);
        for fallback in &fallbacks {
            if canonical_provider(string(fallback, "provider")) == slug
                && !ids.iter().any(|id| id == string(fallback, "model"))
            {
                ids.push(string(fallback, "model").to_owned());
            }
        }
        if selected {
            let model = string(&cfg["model"], "default");
            if !model.is_empty() && !ids.iter().any(|s| s == model) {
                ids.push(model.to_owned())
            }
        }
        if native {
            let known = pi_catalog["providers"][&pi]["models"].as_array();
            ids.retain(|id| !known.is_some_and(|known| known.iter().any(|v| v == id)));
            if ids.is_empty() {
                if override_base {
                    providers[&pi] = json!({"baseUrl":base});
                }
                continue;
            }
        }
        let models=ids.into_iter().map(|id|{
            let meta=metadata(&cache,&cfg,slug,&id);
            json!({"id":id,"name":id,"reasoning":meta["reasoning"].as_bool().unwrap_or(false),"input":meta["modalities"]["input"].as_array().cloned().unwrap_or_else(||vec![json!("text")]),"cost":{"input":meta["cost"]["input"].as_f64().unwrap_or(0.0),"output":meta["cost"]["output"].as_f64().unwrap_or(0.0),"cacheRead":meta["cost"]["cache_read"].as_f64().unwrap_or(0.0),"cacheWrite":meta["cost"]["cache_write"].as_f64().unwrap_or(0.0)},"contextWindow":meta["limit"]["context"].as_u64().unwrap_or(32768),"maxTokens":meta["limit"]["output"].as_u64().unwrap_or(8192)})
        }).collect::<Vec<_>>();
        let api = if native {
            string(&pi_catalog["providers"][&pi], "api")
        } else {
            match string(p, "api_mode") {
                "anthropic_messages" | "anthropic" => "anthropic-messages",
                "responses" | "codex_responses" => "openai-responses",
                _ => "openai-completions",
            }
        };
        let mut entry = json!({"baseUrl":base,"api":api,"models":models});
        if !native {
            entry["authHeader"] = json!(!matches!(slug, "custom" | "ollama" | "lmstudio"));
        }
        // xAI API and subscription auth share one Pi provider and contribute different ids.
        if let Some(existing) = providers[&pi]["models"].as_array() {
            let models = entry["models"].as_array_mut().unwrap();
            for model in existing {
                if !models.iter().any(|m| m["id"] == model["id"]) {
                    models.push(model.clone());
                }
            }
        }
        providers[&pi] = entry;
    }
    for custom in custom_profiles(&cfg) {
        let slug = string(&custom, "name");
        let mut ids = custom["models"].as_array().cloned().unwrap_or_default();
        let selected = selected_provider == slug || selected_provider == format!("custom:{slug}");
        for fallback in &fallbacks {
            let provider = canonical_provider(string(fallback, "provider"));
            if (provider == slug || provider == format!("custom:{slug}"))
                && !ids.iter().any(|id| id == string(fallback, "model"))
            {
                ids.push(json!(string(fallback, "model")));
            }
        }
        if selected
            && let Some(id) = cfg["model"]["default"].as_str()
            && !ids.iter().any(|m| m == id)
        {
            ids.push(json!(id));
        }
        let models=ids.into_iter().filter_map(|v|v.as_str().map(str::to_owned)).map(|id|{
            let meta=metadata(&cache,&cfg,slug,&id);
            json!({"id":id,"name":id,"contextWindow":meta["limit"]["context"].as_u64().unwrap_or(32768),"maxTokens":meta["limit"]["output"].as_u64().unwrap_or(8192),"reasoning":meta["reasoning"].as_bool().unwrap_or(false),"input":meta["modalities"]["input"].as_array().cloned().unwrap_or_else(||vec![json!("text")])})
        }).collect::<Vec<_>>();
        let api = match string(&custom, "api_mode") {
            "anthropic_messages" => "anthropic-messages",
            "responses" | "codex_responses" => "openai-responses",
            _ => "openai-completions",
        };
        let key = profile_home
            .map(|home| custom_key(home, &custom))
            .transpose()?
            .flatten()
            .or(custom_key(home, &custom)?);
        for id in [slug.to_owned(), format!("custom:{slug}")] {
            providers[&id] = json!({"baseUrl":custom["base_url"],"api":api,"models":models,"authHeader":key.is_some()});
            if let Some(key) = &key {
                auth[&id] = json!({"type":"api_key","key":key})
            }
        }
    }
    write_json(&agent_dir.join("auth.json"), &auth)?;
    let mut models = read_json(&agent_dir.join("models.json"))?;
    if !models["providers"].is_object() {
        models["providers"] = json!({})
    }
    for (k, v) in providers.as_object().unwrap() {
        models["providers"][k] = v.clone()
    }
    write_json(&agent_dir.join("models.json"), &models)
}
fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[derive(Clone)]
struct Login {
    home: PathBuf,
    caller: String,
    provider: String,
    public: Value,
    device: String,
    token_url: String,
    issuer: String,
    client_id: String,
    deadline: f64,
    next_poll: f64,
    interval: f64,
    epoch: u64,
}
fn logins() -> &'static tokio::sync::Mutex<HashMap<String, Login>> {
    static LOGINS: OnceLock<tokio::sync::Mutex<HashMap<String, Login>>> = OnceLock::new();
    LOGINS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}
fn endpoint(home: &Path, slug: &str, default: &str) -> Result<String> {
    // Endpoint overrides are operator-controlled files, never accepted in RPC input.
    let cfg = common::read_config(home)?;
    let value = cfg["provider_auth"][slug]["issuer"]
        .as_str()
        .unwrap_or(default)
        .trim_end_matches('/');
    let parsed = url::Url::parse(value).map_err(|_| Error::new(4211, "invalid provider issuer"))?;
    if parsed.scheme() != "https"
        && !(parsed.scheme() == "http"
            && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
    {
        return Err(Error::new(4211, "provider issuer requires HTTPS"));
    }
    Ok(value.to_owned())
}
async fn response_json(response: reqwest::Response) -> Result<Value> {
    let status = response.status();
    if !status.is_success() {
        return Err(Error::new(
            4211,
            format!("provider sign-in request failed (HTTP {})", status.as_u16()),
        ));
    }
    response.json().await.map_err(http_error)
}
async fn login_start(home: &Path, caller: &str, provider: &str) -> Result<Value> {
    let slug = canonical_provider(provider);
    if !matches!(slug.as_str(), "openai-codex" | "xai-oauth" | "nous") {
        return Ok(
            json!({"supported":false,"provider":slug,"message":"This provider requires an API key or an imported OAuth grant."}),
        );
    }
    let (default, client_id, path, scope) = match slug.as_str() {
        "openai-codex" => (
            "https://auth.openai.com",
            "app_EMoamEEZ73f0CkXaXp7hrann",
            "/api/accounts/deviceauth/usercode",
            "",
        ),
        "xai-oauth" => (
            "https://auth.x.ai",
            "b1a00492-073a-47ea-816f-4c329264a828",
            "/oauth2/device/code",
            "openid profile email offline_access grok-cli:access api:access",
        ),
        _ => (
            "https://portal.nousresearch.com",
            "hermes-cli",
            "/api/oauth/device/code",
            "inference:invoke",
        ),
    };
    let epoch = read_json(&home.join("providers-disabled.json"))?[format!("__epoch_{slug}")]
        .as_u64()
        .unwrap_or(0);
    let issuer = endpoint(home, &slug, default)?;
    let request = client()?.post(format!("{issuer}{path}"));
    let response = if slug == "openai-codex" {
        request.json(&json!({"client_id":client_id})).send().await
    } else {
        request
            .form(&[("client_id", client_id), ("scope", scope)])
            .send()
            .await
    }
    .map_err(http_error)?;
    let data = response_json(response).await?;
    let code = string(&data, "user_code");
    let device = string(
        &data,
        if slug == "openai-codex" {
            "device_auth_id"
        } else {
            "device_code"
        },
    );
    if code.is_empty() || device.is_empty() {
        return Err(Error::new(
            4211,
            "provider device-code response was incomplete",
        ));
    }
    let url = if slug == "openai-codex" {
        format!("{issuer}/codex/device")
    } else {
        data["verification_uri_complete"]
            .as_str()
            .or_else(|| data["verification_uri"].as_str())
            .unwrap_or("")
            .to_owned()
    };
    let parsed = url::Url::parse(&url).map_err(|_| Error::new(4211, "invalid verification URL"))?;
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && url.starts_with(&issuer)) {
        return Err(Error::new(4211, "untrusted verification URL"));
    }
    let id = common::id();
    let public = json!({"supported":true,"login_id":id,"provider":slug,"status":"pending","url":url,"code":code,"message":""});
    let now = common::now();
    let interval = data["interval"]
        .as_f64()
        .or_else(|| {
            data["interval"]
                .as_str()
                .and_then(|s| s.parse::<f64>().ok())
        })
        .unwrap_or(5.0)
        .clamp(1.0, 30.0);
    let token_url = format!(
        "{issuer}{}",
        match slug.as_str() {
            "openai-codex" => "/api/accounts/deviceauth/token",
            "xai-oauth" => "/oauth2/token",
            _ => "/api/oauth/token",
        }
    );
    let login = Login {
        home: home.to_path_buf(),
        caller: caller.to_owned(),
        provider: slug.clone(),
        public: public.clone(),
        device: device.to_owned(),
        token_url,
        issuer,
        client_id: client_id.to_owned(),
        deadline: now
            + data["expires_in"]
                .as_f64()
                .unwrap_or(900.0)
                .clamp(1.0, 900.0),
        next_poll: now + interval,
        interval,
        epoch,
    };
    let mut entries = logins().lock().await;
    entries.retain(|_, entry| entry.deadline + 900.0 > now);
    for entry in entries.values_mut() {
        if entry.home == home && entry.provider == slug && entry.public["status"] == "pending" {
            entry.public["status"] = json!("cancelled");
            entry.public["message"] = json!("Sign-in replaced by another request.")
        }
    }
    entries.insert(id.clone(), login);
    drop(entries);
    let home = home.to_path_buf();
    let caller = caller.to_owned();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs_f64(interval)).await;
            match login_poll(&home, &caller, &id, false).await {
                Ok(v) if v["status"] == "pending" => {}
                _ => break,
            }
        }
    });
    Ok(public)
}
async fn login_poll(home: &Path, caller: &str, id: &str, cancel: bool) -> Result<Value> {
    common::admin(home, caller)?;
    let mut entries = logins().lock().await;
    let entry = entries
        .get_mut(id)
        .filter(|e| e.home == home && e.caller == caller)
        .ok_or_else(|| Error::new(4210, "unknown sign-in"))?;
    if entry.public["status"] != "pending" {
        return Ok(entry.public.clone());
    }
    if cancel {
        entry.public["status"] = json!("cancelled");
        entry.public["message"] = json!("Sign-in cancelled.");
        return Ok(entry.public.clone());
    }
    let now = common::now();
    if now >= entry.deadline {
        entry.public["status"] = json!("error");
        entry.public["message"] = json!("Sign-in timed out. Start it again when you are ready.");
        return Ok(entry.public.clone());
    }
    if now < entry.next_poll {
        return Ok(entry.public.clone());
    }
    entry.next_poll = now + entry.interval;
    let login = entry.clone();
    drop(entries);
    let result = poll_token(&login).await;
    let mut entries = logins().lock().await;
    let entry = entries
        .get_mut(id)
        .ok_or_else(|| Error::new(4210, "unknown sign-in"))?;
    // Recheck after network activity: cancelling must never install a late grant.
    if entry.public["status"] != "pending" {
        return Ok(entry.public.clone());
    }
    match result {
        Ok(Some(tokens)) => match save_tokens(home, &login, &tokens) {
            Ok(()) => {
                entry.public["status"] = json!("done");
                entry.public["message"] = json!("Signed in.")
            }
            Err(e) => {
                entry.public["status"] = json!("error");
                entry.public["message"] = json!(e.message)
            }
        },
        Ok(None) => {}
        Err(e) if e.code == 4212 => {
            entry.interval = (entry.interval + 1.0).min(30.0);
            entry.next_poll = common::now() + entry.interval
        }
        Err(e) => {
            entry.public["status"] = json!("error");
            entry.public["message"] = json!(e.message)
        }
    }
    Ok(entry.public.clone())
}
async fn poll_token(login: &Login) -> Result<Option<Value>> {
    let request = client()?.post(&login.token_url);
    let response = if login.provider == "openai-codex" {
        request
            .json(&json!({"device_auth_id":login.device,"user_code":login.public["code"]}))
            .send()
            .await
    } else {
        request
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("client_id", login.client_id.as_str()),
                ("device_code", login.device.as_str()),
            ])
            .send()
            .await
    }
    .map_err(http_error)?;
    let status = response.status();
    if login.provider == "openai-codex" && matches!(status.as_u16(), 403 | 404) {
        return Ok(None);
    }
    let data: Value = response.json().await.map_err(http_error)?;
    if !status.is_success() {
        return match string(&data, "error") {
            "authorization_pending" => Ok(None),
            "slow_down" => Err(Error::new(4212, "authorization polling slowed")),
            _ => Err(Error::new(
                4211,
                format!("provider sign-in polling failed (HTTP {})", status.as_u16()),
            )),
        };
    }
    let tokens = if login.provider == "openai-codex" {
        let code = string(&data, "authorization_code");
        let verifier = string(&data, "code_verifier");
        if code.is_empty() || verifier.is_empty() {
            return Err(Error::new(
                4211,
                "provider authorization response was incomplete",
            ));
        }
        response_json(
            client()?
                .post(format!("{}/oauth/token", login.issuer))
                .form(&[
                    ("grant_type", "authorization_code"),
                    ("code", code),
                    (
                        "redirect_uri",
                        format!("{}/deviceauth/callback", login.issuer).as_str(),
                    ),
                    ("client_id", login.client_id.as_str()),
                    ("code_verifier", verifier),
                ])
                .send()
                .await
                .map_err(http_error)?,
        )
        .await?
    } else {
        data
    };
    if string(&tokens, "access_token").is_empty() {
        return Err(Error::new(4211, "provider did not return an access token"));
    }
    if login.provider == "nous" {
        validate_nous(&tokens)?;
    }
    Ok(Some(tokens))
}
fn save_tokens(home: &Path, login: &Login, tokens: &Value) -> Result<()> {
    let _lock = credentials_lock()
        .lock()
        .map_err(|_| Error::new(5200, "credentials lock unavailable"))?;
    let mut disabled = read_json(&home.join("providers-disabled.json"))?;
    if disabled[format!("__epoch_{}", login.provider)]
        .as_u64()
        .unwrap_or(0)
        != login.epoch
    {
        return Err(Error::new(
            4211,
            "Provider was disconnected during sign-in.",
        ));
    }
    let mut store = read_json(&home.join("auth.json"))?;
    if !store["providers"].is_object() {
        store["providers"] = json!({})
    }
    let mut tokens = tokens.clone();
    let now = common::now();
    tokens["expires_at"] = json!(now + tokens["expires_in"].as_f64().unwrap_or(3600.0));
    let state = if login.provider == "nous" {
        tokens["portal_base_url"] = json!(login.issuer);
        tokens["inference_base_url"] = json!("https://inference-api.nousresearch.com/v1");
        tokens["client_id"] = json!(login.client_id);
        tokens["scope"] = json!("inference:invoke");
        tokens
    } else {
        json!({"tokens":tokens})
    };
    store["providers"][&login.provider] = state;
    write_json(&home.join("auth.json"), &store)?;
    disabled[&login.provider] = json!(false);
    write_json(&home.join("providers-disabled.json"), &disabled)
}
pub async fn call(home: &Path, caller: &str, method: &str, p: &Value) -> Option<Result<Value>> {
    if !matches!(
        method,
        "hexbot.providers.list"
            | "hexbot.providers.set_key"
            | "hexbot.providers.clear_key"
            | "hexbot.providers.login_start"
            | "hexbot.providers.login_poll"
            | "hexbot.providers.login_cancel"
            | "hexbot.models.list"
            | "model.options"
            | "model.save_key"
            | "model.disconnect"
    ) {
        return None;
    }
    Some(async {
  common::user(home,caller)?;
  if !matches!(method,"hexbot.providers.list"|"hexbot.models.list"|"model.options"){common::admin(home,caller)?;}
  match method {
   "hexbot.providers.list"=>list_providers(home),
   "hexbot.providers.set_key"=>set_key(home,common::required(p,"provider")?,common::required(p,"key")?),
   "hexbot.providers.clear_key"=>clear_key(home,common::required(p,"provider")?),
   "hexbot.providers.login_start"=>login_start(home,caller,common::required(p,"provider")?).await,
   "hexbot.providers.login_poll"|"hexbot.providers.login_cancel"=>login_poll(home,caller,common::required(p,"login_id")?,method.ends_with("cancel")).await,
   "hexbot.models.list"=>list_models(home,p).await,
   "model.options"=>model_options(home,p).await,
   "model.save_key"=>{let slug=canonical_provider(common::required(p,"slug")?);set_key(home,&slug,common::required(p,"api_key")?)?;let options=model_options(home,&json!({})).await?;Ok(json!({"provider":options["providers"].as_array().unwrap().iter().find(|row|row["slug"]==slug)}))},
   "model.disconnect"=>{let slug=canonical_provider(common::required(p,"slug")?);clear_key(home,&slug)?;Ok(json!({"slug":slug,"name":profile(&slug)?["display_name"],"disconnected":true}))},
   _=>unreachable!()
  }
 }.await)
}

fn expires_at(tokens: &Value) -> f64 {
    tokens["expiry_date"]
        .as_f64()
        .map(|v| v / 1000.0)
        .or_else(|| tokens["expires_at"].as_f64())
        .or_else(|| {
            tokens["expires_at"]
                .as_str()
                .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
                .map(|v| v.timestamp() as f64)
        })
        .or_else(|| jwt_claims(string(tokens, "access_token")).and_then(|v| v["exp"].as_f64()))
        .unwrap_or(0.0)
}
fn validate_nous(tokens: &Value) -> Result<()> {
    let claims = jwt_claims(string(tokens, "access_token")).ok_or_else(|| {
        Error::new(
            4211,
            "Nous Portal did not return an inference JWT. Sign in again.",
        )
    })?;
    let scopes = format!(
        "{} {} {}",
        string(tokens, "scope"),
        string(&claims, "scope"),
        string(&claims, "scp")
    );
    let array_scope = claims["scp"]
        .as_array()
        .is_some_and(|a| a.iter().any(|v| v == "inference:invoke"));
    if !array_scope
        && !scopes
            .split(|c: char| c.is_whitespace() || c == ',')
            .any(|s| s == "inference:invoke")
    {
        return Err(Error::new(
            4211,
            "Nous Portal grant has no inference:invoke scope. Sign in again.",
        ));
    }
    if expires_at(tokens) <= common::now() + 30.0 {
        return Err(Error::new(
            4211,
            "Nous Portal inference token has expired. Sign in again.",
        ));
    }
    Ok(())
}
fn import_qwen(home: &Path) -> Result<Value> {
    let cfg = common::read_config(home)?;
    let path = if let Some(path) = cfg["provider_auth"]["qwen-oauth"]["auth_file"].as_str() {
        PathBuf::from(path)
    } else {
        let Some(user_home) = std::env::var_os("HOME") else {
            return Ok(Value::Null);
        };
        PathBuf::from(user_home).join(".qwen/oauth_creds.json")
    };
    if path.exists() {
        read_json(&path)
    } else {
        Ok(Value::Null)
    }
}
/// Resolve OAuth at the HTTP boundary, including long-running sessions. Returned headers
/// belong only on the private Pi bridge and must never be published as client events.
pub async fn request_auth(home: &Path, bot: &str, provider: &str) -> Result<Value> {
    common::identifier(bot)?;
    let slug = canonical_provider(provider);
    if !matches!(
        slug.as_str(),
        "nous" | "qwen-oauth" | "minimax-oauth" | "xai-oauth"
    ) {
        return Ok(json!({"headers":{}}));
    }
    static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _refresh = REFRESH.lock().await;
    let disabled = read_json(&home.join("providers-disabled.json"))?;
    if disabled[&slug] == true {
        return Err(Error::new(
            4211,
            format!("{slug} is disconnected. Sign in again."),
        ));
    }
    let epoch = disabled[format!("__epoch_{slug}")].as_u64().unwrap_or(0);
    let profile_home = home.join("profiles").join(bot);
    let p = profile(&slug)?;
    let root_cfg = common::read_config(home)?;
    let profile_cfg = common::read_config(&profile_home)?;
    let inline = [&profile_cfg, &root_cfg].into_iter().find_map(|cfg| {
        if canonical_provider(string(&cfg["model"], "provider")) == slug {
            cfg["model"]["api_key"]
                .as_str()
                .filter(|k| !k.is_empty())
                .map(str::to_owned)
        } else {
            None
        }
    });
    if let Some(key) = inline.or(key(&profile_home, p)?).or(key(home, p)?) {
        return Ok(json!({"headers":{"authorization":format!("Bearer {key}")}}));
    }
    let profile_state = oauth(&profile_home, &slug)?;
    let credential_home = if !string(&profile_state, "access_token").is_empty()
        || profile_state["tokens"].is_object()
    {
        profile_home.as_path()
    } else {
        home
    };
    let mut state = oauth(credential_home, &slug)?;
    if slug == "qwen-oauth" && string(&state, "access_token").is_empty() {
        state = import_qwen(home)?;
    }
    let mut tokens = if state["tokens"].is_object() {
        state["tokens"].clone()
    } else {
        state.clone()
    };
    if !tokens.is_object() {
        return Err(Error::new(
            4211,
            format!("No {slug} credentials are available. Sign in again."),
        ));
    }
    if slug == "xai-oauth" {
        let pi = read_json(&profile_home.join("pi/auth.json"))?;
        let credential = &pi["xai"];
        if credential["type"] == "oauth"
            && credential["expires"].as_f64().unwrap_or(0.0) / 1000.0 > expires_at(&tokens)
        {
            tokens["access_token"] = credential["access"].clone();
            tokens["refresh_token"] = credential["refresh"].clone();
            tokens["expires_at"] = json!(credential["expires"].as_f64().unwrap_or(0.0) / 1000.0);
        }
    }
    let should_refresh = expires_at(&tokens) <= common::now() + 120.0
        || (slug == "nous" && validate_nous(&tokens).is_err());
    if should_refresh {
        let refresh = string(&tokens, "refresh_token");
        if refresh.is_empty() {
            return Err(Error::new(
                4211,
                format!("{slug} has expired and has no refresh token. Sign in again."),
            ));
        }
        let (default, path, default_client) = match slug.as_str() {
            "nous" => (
                "https://portal.nousresearch.com",
                "/api/oauth/token",
                "hermes-cli",
            ),
            "xai-oauth" => (
                "https://auth.x.ai",
                "/oauth2/token",
                "b1a00492-073a-47ea-816f-4c329264a828",
            ),
            "qwen-oauth" => (
                "https://chat.qwen.ai",
                "/api/v1/oauth2/token",
                "f0304373b74a44d2b584a3fb70ca9e56",
            ),
            _ => (
                "https://api.minimax.io",
                "/oauth/token",
                "78257093-7e40-4613-99e0-527b14b39113",
            ),
        };
        let stored = string(&state, "portal_base_url");
        let stored_allowed = url::Url::parse(stored)
            .ok()
            .is_some_and(|url| match slug.as_str() {
                "nous" => matches!(
                    url.host_str(),
                    Some("portal.nousresearch.com" | "localhost" | "127.0.0.1")
                ),
                "minimax-oauth" => {
                    matches!(url.host_str(), Some("api.minimax.io" | "api.minimaxi.com"))
                }
                _ => false,
            });
        let default = if stored_allowed { stored } else { default };
        let issuer = endpoint(home, &slug, default)?;
        let id = state["client_id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(default_client);
        let response = client()?
            .post(format!("{issuer}{path}"))
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", id),
                ("refresh_token", refresh),
            ])
            .send()
            .await
            .map_err(http_error)?;
        let response = response_json(response).await?;
        if string(&response, "access_token").is_empty()
            || (slug == "minimax-oauth" && response["status"] != "success")
        {
            return Err(Error::new(
                4211,
                format!("{slug} refresh did not return valid credentials. Sign in again."),
            ));
        }
        let now = common::now();
        let expires = if slug == "minimax-oauth" {
            let raw = response["expired_in"]
                .as_f64()
                .ok_or_else(|| Error::new(4211, "MiniMax refresh response is missing expiry"))?;
            if raw > 100_000_000_000.0 {
                raw / 1000.0
            } else {
                now + raw.max(1.0)
            }
        } else {
            now + response["expires_in"].as_f64().unwrap_or(21600.0).max(1.0)
        };
        tokens["access_token"] = response["access_token"].clone();
        if !string(&response, "refresh_token").is_empty() {
            tokens["refresh_token"] = response["refresh_token"].clone()
        }
        if response["scope"].is_string() {
            tokens["scope"] = response["scope"].clone()
        }
        tokens["expires_at"] = json!(
            chrono::DateTime::from_timestamp(expires as i64, 0)
                .ok_or_else(|| Error::new(4211, "invalid token expiry"))?
                .to_rfc3339()
        );
        if slug == "qwen-oauth" {
            tokens["expiry_date"] = json!((expires * 1000.0) as u64)
        }
    }
    let access = string(&tokens, "access_token");
    if access.is_empty() {
        return Err(Error::new(
            4211,
            format!("{slug} has no access token. Sign in again."),
        ));
    }
    {
        let _lock = credentials_lock()
            .lock()
            .map_err(|_| Error::new(5200, "credentials lock unavailable"))?;
        let disabled = read_json(&home.join("providers-disabled.json"))?;
        if disabled[&slug] == true
            || disabled[format!("__epoch_{slug}")].as_u64().unwrap_or(0) != epoch
        {
            return Err(Error::new(
                4211,
                "Provider was disconnected during token refresh.",
            ));
        }
        let mut auth = read_json(&credential_home.join("auth.json"))?;
        if !auth["providers"].is_object() {
            auth["providers"] = json!({})
        }
        if state["tokens"].is_object() {
            state["tokens"] = tokens.clone();
            auth["providers"][&slug] = state
        } else {
            auth["providers"][&slug] = tokens.clone()
        }
        write_json(&credential_home.join("auth.json"), &auth)?;
    }
    // Persist rotated refresh tokens before validation, because an upstream rotation is irreversible.
    if slug == "nous" {
        validate_nous(&tokens)?
    }
    Ok(json!({"headers":{"authorization":format!("Bearer {access}"),"x-api-key":null}}))
}

pub fn selection_warning(model: &Value) -> Option<String> {
    let id = string(model, "id");
    let lower = id.trim().to_lowercase();
    let mut warnings = vec![];
    let input = model["cost"]["input"].as_f64();
    let output = model["cost"]["output"].as_f64();
    if input.is_some_and(|v| v > 20.0)
        || output.is_some_and(|v| v > 100.0)
        || lower == "openai/gpt-5.5-pro"
    {
        let cost = |value: Option<f64>| {
            value
                .map(|v| format!("${v:.2}/M"))
                .unwrap_or_else(|| "unknown".to_owned())
        };
        let mut message = format!(
            "{id} exceeds the model cost threshold of $20/M input or $100/M output. Input: {}. Output: {}. Confirm only if you intend to use this model.",
            cost(input),
            cost(output)
        );
        if lower == "openai/gpt-5.5-pro" {
            message.push_str(" Did you mean to select openai/gpt-5.5?");
        }
        warnings.push(message);
    }
    if lower.ends_with("-contributor") || lower.split('-').any(|part| part == "contributor") {
        warnings.push(format!("{id} is a contributor tier that permits training on your prompts and completions. Confirm only if this data use is acceptable. Select the standard model to avoid this tier. Source: https://dev.meta.ai/docs/pricing-rate-limits/"));
    }
    if warnings.is_empty() {
        None
    } else {
        Some(warnings.join("\n\n"))
    }
}

pub async fn xai_credentials(home: &Path, bot: &str) -> Result<Value> {
    common::identifier(bot)?;
    let profile_home = home.join("profiles").join(bot);
    let root_env = common::env_values(home)?;
    let profile_env = common::env_values(&profile_home)?;
    let base = profile_env
        .get("HERMES_XAI_BASE_URL")
        .or_else(|| profile_env.get("XAI_BASE_URL"))
        .or_else(|| root_env.get("HERMES_XAI_BASE_URL"))
        .or_else(|| root_env.get("XAI_BASE_URL"))
        .cloned()
        .or_else(|| std::env::var("XAI_BASE_URL").ok())
        .unwrap_or_else(|| "https://api.x.ai/v1".to_owned());
    let disabled = read_json(&home.join("providers-disabled.json"))?;
    if disabled["xai"] != true
        && let Some(api_key) = key(&profile_home, profile("xai")?)?.or(key(home, profile("xai")?)?)
    {
        return Ok(json!({"api_key":api_key,"base_url":base,"provider":"xai"}));
    }
    let headers = request_auth(home, bot, "xai-oauth").await?;
    let token = string(&headers["headers"], "authorization")
        .strip_prefix("Bearer ")
        .ok_or_else(|| Error::new(4211, "xAI credentials are unavailable"))?;
    Ok(json!({"api_key":token,"base_url":base,"provider":"xai-oauth"}))
}

/// Apply Hermes provider wire rules to the outgoing copy. Stored conversation messages
/// and the system-prompt/tool prefix remain unchanged.
pub fn adapt_request(home: &Path, bot: &str, session: &str, p: &Value) -> Result<Value> {
    common::identifier(bot)?;
    let provider = canonical_provider(string(p, "provider"));
    let model = string(p, "model").to_lowercase();
    let mut payload = p["payload"].clone();
    if !payload.is_object() {
        return Err(Error::new(
            4200,
            "provider request payload must be an object",
        ));
    }
    let root = common::read_config(home)?;
    let profile_cfg = common::read_config(&home.join("profiles").join(bot))?;
    let base = profile_cfg["model"]["base_url"]
        .as_str()
        .or_else(|| root["model"]["base_url"].as_str())
        .unwrap_or("");
    let effort = p["thinking"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| payload["reasoning_effort"].as_str())
        .map(str::to_lowercase);
    let off = effort
        .as_deref()
        .is_some_and(|s| matches!(s, "off" | "none" | "false"));
    let effort = effort.as_deref().map(|s| match s {
        "xhigh" | "ultra" => "max",
        "minimal" => "low",
        other => other,
    });
    let object = payload.as_object_mut().unwrap();
    match provider.as_str() {
        "qwen-oauth" => {
            object.insert("vl_high_resolution_images".into(), json!(true));
            if let Some(messages) = object.get_mut("messages").and_then(Value::as_array_mut) {
                let mut marked = false;
                for message in messages {
                    if let Some(text) = message["content"].as_str() {
                        message["content"] = json!([{"type":"text","text":text}]);
                    }
                    if let Some(parts) = message["content"].as_array_mut() {
                        for part in parts {
                            if let Some(text) = part.as_str() {
                                *part = json!({"type":"text","text":text});
                            }
                        }
                    }
                    if !marked && message["role"] == "system" {
                        if let Some(last) = message["content"]
                            .as_array_mut()
                            .and_then(|a| a.last_mut())
                            .filter(|v| v.is_object())
                        {
                            last["cache_control"] = json!({"type":"ephemeral"});
                        }
                        marked = true;
                    }
                }
            }
        }
        "nous" | "openrouter" => {
            object.insert("session_id".into(), json!(session));
            if provider == "nous" {
                object.insert(
                    "tags".into(),
                    json!(["product=hexbot", format!("conversation={session}")]),
                );
            }
            let prefs = profile_cfg
                .get("provider_preferences")
                .or_else(|| root.get("provider_preferences"));
            if let Some(prefs) = prefs.filter(|v| v.is_object()) {
                object.insert("provider".into(), prefs.clone());
            }
            if provider == "nous" && off {
                object.remove("reasoning");
                object.remove("reasoning_effort");
            }
        }
        "kimi-coding" | "kimi-coding-cn" => {
            object.remove("temperature");
            object.remove("thinking");
            object.remove("reasoning_effort");
            if off {
                object.insert("thinking".into(), json!({"type":"disabled"}));
            } else if let Some(effort) =
                effort.filter(|e| matches!(*e, "low" | "medium" | "high" | "max"))
            {
                object.insert(
                    "reasoning_effort".into(),
                    json!(if effort == "medium" { "high" } else { effort }),
                );
            } else {
                object.insert("thinking".into(), json!({"type":"enabled"}));
            }
        }
        "deepseek" if model.starts_with("deepseek-v") && !model.starts_with("deepseek-v3") => {
            object.insert(
                "thinking".into(),
                json!({"type":if off{"disabled"}else{"enabled"}}),
            );
            object.remove("reasoning_effort");
            if !off
                && let Some(effort) =
                    effort.filter(|e| matches!(*e, "low" | "medium" | "high" | "max"))
            {
                object.insert("reasoning_effort".into(), json!(effort));
            }
        }
        "zai"
            if (model.starts_with("glm-5")
                || model.starts_with("glm-4.5")
                || model.starts_with("glm-4.6")
                || model.starts_with("glm-4.7"))
                && effort.is_some() =>
        {
            object.insert(
                "thinking".into(),
                json!({"type":if off{"disabled"}else{"enabled"}}),
            );
            object.remove("reasoning_effort");
            if !off
                && (model.contains("5.2")
                    || model.contains("5.3")
                    || model.contains("5-2")
                    || model.contains("5-3")
                    || model.contains("5p2")
                    || model.contains("5p3"))
            {
                let mut effort = effort.unwrap_or("high");
                if model.contains("5.2") && effort != "max" {
                    effort = "high"
                }
                if matches!(effort, "low" | "medium" | "high" | "max") {
                    object.insert("reasoning_effort".into(), json!(effort));
                }
            }
        }
        "minimax" | "minimax-cn" | "minimax-oauth"
            if matches!(model.as_str(), "minimax-m3" | "minimax/minimax-m3")
                && base.trim_end_matches('/') == "https://api.minimax.io/v1" =>
        {
            object.insert("reasoning_split".into(), json!(true));
            object.remove("reasoning_effort");
            if effort.is_some() {
                object.insert(
                    "thinking".into(),
                    json!({"type":if off{"disabled"}else{"adaptive"}}),
                );
            }
        }
        "custom" => {
            if let Some(context) = profile_cfg["model"]["context_length"]
                .as_u64()
                .or_else(|| root["model"]["context_length"].as_u64())
            {
                object.entry("options").or_insert_with(|| json!({}))["num_ctx"] = json!(context);
            }
            if off {
                object.insert("reasoning_effort".into(), json!("none"));
                if url::Url::parse(base).ok().is_some_and(|u| {
                    u.port() == Some(11434)
                        || u.host_str().is_some_and(|h| {
                            h == "ollama.com"
                                || h.ends_with(".ollama.com")
                                || h.split('.').any(|p| p == "ollama")
                        })
                }) {
                    object.insert("think".into(), json!(false));
                }
            } else if let Some(effort) = effort {
                object.insert("reasoning_effort".into(), json!(effort));
            }
        }
        _ => {}
    }
    Ok(payload)
}

pub fn xai_configured(home: &Path, bot: &str) -> Result<bool> {
    common::identifier(bot)?;
    let profile_home = home.join("profiles").join(bot);
    let disabled = read_json(&home.join("providers-disabled.json"))?;
    if disabled["xai"] != true
        && (key(&profile_home, profile("xai")?)?.is_some() || key(home, profile("xai")?)?.is_some())
    {
        return Ok(true);
    }
    if disabled["xai-oauth"] == true {
        return Ok(false);
    }
    for path in [&profile_home, home] {
        let state = oauth(path, "xai-oauth")?;
        let tokens = if state["tokens"].is_object() {
            &state["tokens"]
        } else {
            &state
        };
        if !string(tokens, "access_token").is_empty() || !string(tokens, "refresh_token").is_empty()
        {
            return Ok(true);
        }
    }
    let pi = read_json(&profile_home.join("pi/auth.json"))?;
    Ok(pi["xai"]["type"] == "oauth" && pi["xai"]["access"].as_str().is_some_and(|s| !s.is_empty()))
}
