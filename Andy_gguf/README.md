# Andy — GGUF 情感陪伴模型

基于 **Qwen3.5-2B** 微调的情感陪伴助手，使用 **ESConv** 数据集进行 LoRA 指令微调，最终转换为 **GGUF** 格式以便于本地推理部署（llama.cpp / Ollama）。

> 模型定位是「情感陪伴」(emotional support companion)，不是医生，不进行医学诊断。

---

## 项目结构

```
Andy_gguf/
├── README.md                       # 本文件
├── Modelfile                       # Ollama 模型定义 (system prompt + 参数)
├── merge_lora.py                   # 合并 LoRA 与基模型的脚本
├── AndyQwen3_5LoRaFT.ipynb         # LoRA 微调全流程 (Jupyter Notebook)
├── pyproject.toml                  # Python 依赖 (uv / pip)
├── uv.lock                         # 依赖锁定文件
├── .python-version                 # Python 3.13
│
├── model/
│   ├── Qwen3.5-2B/                 # 基座模型 (HuggingFace)
│   ├── esconv_lora/                # LoRA 适配器
│   └── esconv_lora-273-0908/       # 最终 LoRA (273 步, 2026-09-08)
│
├── Qwen3.5-2B-esconv/              # 合并后的模型 (base + LoRA)
│   ├── config.json
│   ├── model.safetensors           # FP16 权重 (~3.5 GB)
│   ├── tokenizer.json
│   └── tokenizer_config.json
│
├── FROM ./qwen35_2b_esconv.gguf                # 最终 GGUF 模型 (FP16, 3.5 GB)
│
└── llama.cpp/                      # llama.cpp 源码 (含 convert_hf_to_gguf.py)
```

---

## 完整流程

```
 ┌─────────────────────┐
 │  Qwen3.5-2B (HF)    │  基座模型
 └──────────┬──────────┘
            │  + LoRA (ESConv, r=16, α=32)
            ▼
 ┌─────────────────────┐
 │  esconv_lora-273    │  LoRA 适配器 (~50 MB)
 └──────────┬──────────┘
            │  merge_lora.py
            ▼
 ┌─────────────────────┐
 │  Qwen3.5-2B-esconv  │  合并后的 HF 模型
 └──────────┬──────────┘
            │  convert_hf_to_gguf.py (FP16)
            ▼
 ┌─────────────────────┐
 │  FROM ./qwen35_2b_esconv.gguf   │  GGUF 模型 (llama.cpp / Ollama)
 └─────────────────────┘
```

### 数据来源

训练集 [ESConv (Emotional Support Conversations)](https://github.com/thu-coai/Emotional-Support_Conversation) — 一个结构化的中文情感支持对话数据集，每个样本包含：

- `emotion_type` — 用户情绪类型
- `problem_type` — 问题类型
- `situation` — 具体情境描述
- `strategy` — 支持策略
- 多轮 seeker / supporter 对话

微调时把这些结构化信息转换为 `<think>...</think>` 内部思考，最终只输出面向用户的回复（`SYSTEM_PROMPT` 中明确要求）。

---

## 1. 环境准备

### Python (用于合并 / 转换)

Python ≥ 3.13。使用 [uv](https://github.com/astral-sh/uv)（推荐）：

```bash
uv sync
```

或 pip：

```bash
pip install accelerate peft safetensors sentencepiece tiktoken tokenizers transformers
```

### Ollama (用于本地推理)

```bash
brew install ollama        # macOS
# 或参见 https://ollama.com/download
ollama serve               # 启动服务
```

### llama.cpp (可选，用于 CLI / HTTP 服务)

```bash
cd llama.cpp
cmake -B build
cmake --build build --config Release -j
```

---

## 2. 重新生成模型

如果你已经拥有基座模型和 LoRA，可以从合并开始；如果你想完全重新训练，从第 0 步开始。

### 0. LoRA 微调 (可选)

打开 `AndyQwen3_5LoRaFT.ipynb`，按顺序运行 cell。

主要超参数：

| 项目           | 值                             |
| -------------- | ------------------------------ |
| 框架           | Unsloth + TRL SFTTrainer       |
| 基座           | Qwen3.5-2B                     |
| LoRA rank      | 16                             |
| LoRA alpha     | 32                             |
| LoRA dropout   | 0.05                           |
| target_modules | q_proj, k_proj, v_proj, o_proj |
| batch size     | 8 (per device)                 |
| learning rate  | 2e-4                           |
| epochs         | 3                              |
| 最终步数       | 273                            |
| 精度           | bf16                           |
| 优化器         | AdamW 8-bit                    |
| 推荐硬件       | NVIDIA A10 (22 GB) 或同级      |

输出：LoRA 权重 → `model/esconv_lora-273-0908/`

### 1. 合并 LoRA

```bash
uv run python merge_lora.py
```

读取：

- `./model/Qwen3.5-2B`
- `./model/esconv_lora-273-0908`

输出：`./Qwen3.5-2B-esconv/`（FP16 safetensors）

### 2. 转换为 GGUF

在 `llama.cpp/` 目录下执行：

```bash
python convert_hf_to_gguf.py ../Qwen3.5-2B-esconv --outfile ../qwen35_2b_esconv.gguf --outtype f16
```

输出：`./FROM ./qwen35_2b_esconv.gguf`（FP16，约 3.5 GB）

> 如需量化版本，把 `--outtype f16` 换成 `q4_k_m`、`q5_k_m`、`q8_0` 等。

### 3. 创建 Ollama 模型

```bash
ollama create FROM ./qwen35_2b_esconv.gguf -f Modelfile
ollama run FROM ./qwen35_2b_esconv.gguf
```

`Modelfile` 内容：

```dockerfile
FROM ./FROM ./qwen35_2b_esconv.gguf

PARAMETER temperature 0.7
PARAMETER top_p 0.9

SYSTEM """
你是一名情感陪伴助手。

你的任务：
- 理解用户的情绪
- 理解用户当前的问题
- 选择合适的情感支持策略
- 提供自然、共情、积极的回应

注意：
- 你不是医生
- 不能进行医学诊断
- 不要武断判断用户存在心理疾病
- 不要暴露内部思考过程
- 只能输出纯文本，不能输出代码，不能输出表情包，不能输出图片
- 输出要简洁、清晰、直接、具体、积极、有温度
"""
```

---

## 3. 推理使用

### Ollama

```bash
ollama run FROM ./qwen35_2b_esconv.gguf
>>> 我最近压力很大，感觉什么都做不好。
```

HTTP API：

```bash
curl http://localhost:11434/api/chat -d '{
  "model": "FROM ./qwen35_2b_esconv.gguf",
  "messages": [{"role": "user", "content": "我最近压力很大"}],
  "stream": false
}'
```

### llama.cpp CLI

```bash
./llama.cpp/build/bin/llama-cli -m FROM ./qwen35_2b_esconv.gguf \
    -p "你是一名情感陪伴助手。用户最近压力很大，请回应。" \
    -n 512 --temp 0.7
```

### llama.cpp HTTP 服务 (OpenAI 兼容)

```bash
./llama.cpp/build/bin/llama-server -m FROM ./qwen35_2b_esconv.gguf \
    --host 0.0.0.0 --port 8080 -c 4096
```

然后用 OpenAI 客户端：

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8080/v1", api_key="sk-no-key")
resp = client.chat.completions.create(
    model="FROM ./qwen35_2b_esconv.gguf",
    messages=[{"role": "user", "content": "我最近压力很大"}],
)
print(resp.choices[0].message.content)
```

---

## 4. 模型与训练细节

| 字段         | 值                                        |
| ------------ | ----------------------------------------- |
| 架构         | Qwen3_5ForCausalLM（线性 + 全注意力混合） |
| 参数量       | 2 B                                       |
| Hidden size  | 2048                                      |
| 层数         | 24                                        |
| 词表大小     | 248,320                                   |
| 最大上下文   | 262,144 tokens                            |
| 输出精度     | FP16（可量化至 Q4_K_M / Q5_K_M / Q6_K）   |
| 训练数据     | ESConv（中文情感支持对话）                |
| 可训练参数   | 10,911,744 / 2,224,153,408（0.49%）       |
| 默认推理参数 | `temperature=0.7`, `top_p=0.9`            |

---

## 5. 注意事项

- **不是医疗工具**：本模型仅做情感陪伴，不能替代专业心理咨询或医疗诊断。
- **不做心理疾病诊断**：system prompt 明确禁止武断判断用户存在心理疾病。
- **不暴露内部思考**：训练时使用 `<think>...</think>` 作为内部推理，最终只输出共情回复。
- **GGUF 文件较大**：FP16 约 3.5 GB，若设备资源紧张请使用量化版本（Q4_K_M 约 1.2 GB）。
- **推理硬件建议**：FP16 推荐 ≥ 6 GB 显存或 ≥ 8 GB 内存；Q4_K_M 量化版本可在 Apple Silicon / 普通笔记本流畅运行。

---

## 6. 目录说明

| 路径                                      | 用途                                                |
| ----------------------------------------- | --------------------------------------------------- |
| `merge_lora.py`                           | 把 LoRA 合并进基座模型                              |
| `AndyQwen3_5LoRaFT.ipynb`                 | 完整的 LoRA SFT 训练流程（数据加载 / 训练 / 保存）  |
| `Modelfile`                               | Ollama 模型定义                                     |
| `FROM ./qwen35_2b_esconv.gguf` | 最终可用于推理的 GGUF 模型                          |
| `llama.cpp/`                              | 第三方 C/C++ 推理引擎（含 `convert_hf_to_gguf.py`） |

---

## 7. 致谢

- [Qwen3.5](https://huggingface.co/Qwen) — 基座模型
- [ESConv](https://github.com/thu-coai/Emotional-Support_Conversation) — 情感支持对话数据集
- [Unsloth](https://github.com/unslothai/unsloth) — 高效 LoRA 训练框架
- [llama.cpp](https://github.com/ggerganov/llama.cpp) — GGUF 推理引擎
- [Ollama](https://ollama.com) — 本地模型运行时
