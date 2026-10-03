# Andy ESP32-S3

基于 ESP32-S3 (esp32-s3-devkitm-1) 的 AIoT 固件。PlatformIO + Arduino 框架。

## 功能

### 已实现

- Wi-Fi SoftAP 配网（Captive Portal）
- MQTT 连接 EMQX Cloud（`mqtts://ie0e7e23.ala.cn-shenzhen.emqxsl.cn:8883`）
- 通过 MQTT 与 Next.js 后端（`andy-studio`）做 LLM chat 往返
  - 请求主题：`device/esp32-001/chat/request`
  - 回复主题：`device/esp32-001/chat/reply`
- BOOT 按钮
  - 短按（< 1.5s）→ 发送 `{"prompt":"你好"}` chat 请求
  - 长按（≥ 1.5s）→ 清除 Wi-Fi 凭据并重新进入配网
- I2S 音频输出（LittleFS 本地文件 / HTTP URL）

### 计划中

- 语音唤醒（Wake Word）：本地常驻监听唤醒词，命中后切换到对话态，取代 BOOT 短按作为发起消息的入口
- ASR（自动语音识别）：对话态下采集用户语音，上传至后端转写为文字，再作为 chat request 的 `prompt`
- TTS（文本转语音）：收到 `chat/reply` 后调用后端 TTS，把音频 URL 通过 EventBus 投递给 AudioManager 播放
- 显示屏表情：板载屏幕（如 OLED / TFT）展示状态（在线 / 监听 / 思考 / 说话）+ 表情动画，与 Audio 状态联动
- 后端 IM / 语音流对接

## 计划中的交互流程

```text
[Idle] 等待唤醒词
   ↓ Wake Word 命中
[Listening] 录音 + ASR
   ↓ 文字结果
[Thinking] 发布 chat/request
   ↓ 等待 chat/reply
[Speaking] TTS 播放（AudioManager）
   ↓ 播完
[Idle]
```

| 状态 | 显示屏表情 | Audio | MQTT |
|------|------------|-------|------|
| Idle | 待眠 | 静音 | — |
| Listening | 耳朵 | 蜂鸣提示 | — |
| Thinking | 思考气泡 | 静音 | 发布 `chat/request` |
| Speaking | 嘴巴 | TTS 播放 | — |

## 目录结构

```text
src/
├── main.cpp
├── core/
│   ├── app_manager.{h,cpp}        总线编排
│   ├── event_bus.{h,cpp}          事件总线
│   └── ...
├── modules/
│   ├── wifi/wifi_manager.{h,cpp}
│   ├── mqtt/mqtt_manager.{h,cpp}
│   ├── boot/boot_manager.{h,cpp}
│   ├── provision/                 AP 配网 + Captive Portal
│   ├── preferences/preferences_manager.{h,cpp}
│   ├── audio/audio_manager.{h,cpp}
│   ├── wake_word/                 (计划)
│   ├── asr/                       (计划)
│   ├── tts/                       (计划)
│   └── display/                   (计划)
└── ...
include/config.h                    设备 ID / MQTT / 主题宏
```

## 构建与烧录

```bash
pio run -t upload
pio device monitor -b 115200
```

依赖（已在 `platformio.ini`）：

- `bblanchon/ArduinoJson`
- `knolleary/PubSubClient`
- `adafruit/Adafruit NeoPixel`
- `schreibfaul1/ESP32-audioI2S`

## 配置

`include/config.h`：

```cpp
#define DEVICE_ID     "esp32-001"
#define MQTT_SERVER   "ie0e7e23.ala.cn-shenzhen.emqxsl.cn"
#define MQTT_PORT     8883
#define MQTT_USERNAME "root"
#define MQTT_PASSWORD "..."
```

## 音频接线

```cpp
#define I2S_BCLK 15
#define I2S_LRC  16
#define I2S_DOUT 7
```

## API：AudioManager

```cpp
extern AudioManager AudioI2S;

AudioI2S.playFile("/hello.wav");
AudioI2S.playUrl("https://example.com/voice.mp3");
AudioI2S.setVolume(15);
AudioI2S.stop();
```

事件总线：

```cpp
EventBus::instance().emitAudioPlay("/sfx/click.wav", false);
EventBus::instance().emitAudioPlay("https://...", true);
```

## 后端

- Next.js 后端：`/Users/yezery/Desktop/ESP32Code/Andy_studio/andy-studio`
- Backend 文档：`/Users/yezery/Desktop/ESP32Code/Andy_studio/README.md`
- Wire contract：`/Users/yezery/Desktop/ESP32Code/Andy_studio/ESP32_INTEGRATION_PROMPT.md`