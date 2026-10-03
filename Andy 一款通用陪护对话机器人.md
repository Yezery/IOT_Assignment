# Andy 一款医护陪护对话机器人

技术栈

Iot: esp32S3 N16R8、arduino框架

Mqtt broker：EMQX（公有云）

全栈开发：next.js + sqlite-vec

Herness开发：langchain + DeepAgent(TS) + Skills + MCP + RAG

Embedding Model：bge-large-zh-v1.5

LLM： Qwen3.5-2B +   + Unsloth 的微调框架 +微调方法为LoRa+数据集ESConv

LLM 推理与服务：把微调后的模型进行 rola 融合后进行 gguf 转换，然后量化为Q6_K，然后部署到ollama

