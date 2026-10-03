import torch

from transformers import Qwen3_5ForConditionalGeneration
from peft import PeftModel


BASE_MODEL = "./model/Qwen3.5-2B"

LORA_PATH = "./model/qwen-esconv-qlora-checkpoints-171"

OUTPUT_PATH = "./Qwen3.5-2B-esconv"



print("=" * 60)
print("Loading Base Qwen...")
print("=" * 60)


model = Qwen3_5ForConditionalGeneration.from_pretrained(
    BASE_MODEL,
    dtype=torch.float16,
    trust_remote_code=True,
)


print("Base model loaded.")


print("=" * 60)
print("Loading esconv LoRA...")
print("=" * 60)


model = PeftModel.from_pretrained(
    model,
    LORA_PATH,
    adapter_name="esconv"
)

print("LoRA loaded.")


print("=" * 60)
print("Merging LoRA...")
print("=" * 60)


model = model.merge_and_unload()


print("LoRA merged.")


print("=" * 60)
print("Saving merged model...")
print("=" * 60)


model.save_pretrained(
    OUTPUT_PATH,
    safe_serialization=True,
)


print("Merged model saved to:")
print(OUTPUT_PATH)

print("=" * 60)
print("DONE")
print("=" * 60)
