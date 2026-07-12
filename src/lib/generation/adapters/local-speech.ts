/**
 * v2.0 本地语音生成适配器
 *
 * 手册 §20：通过 ComfyUI 传输适配器调用本地语音合成模型。
 * 支持语音配置、速度/音调控制和音频输出。
 */

import type { SpeechProvider, SpeechRequest, SpeechResult, ExecutionContext } from "@/lib/generation/contracts";
import type { ComfyUITransport } from "@/lib/generation/transports";
import { submitPrompt, probeHistory, downloadOutput } from "@/lib/generation/transports";
import { isEnabled, FF } from "@/lib/feature-flags";

/** 语音合成节点类型 */
const SPEECH_NODE = {
  LOADER: "SpeechLoader",
  VOCAL: "SpeechVocalLoader",
  ENCODER: "SpeechEncoder",
  DECODER: "SpeechDecoder",
  OUTPUT: "SaveAudio",
} as const;

/** 语音配置 */
export interface VoiceProfile {
  id: string;
  name: string;
  /** 声纹嵌入路径 */
  embeddingPath: string;
  /** 默认语速 */
  defaultSpeed: number;
  /** 默认音调 */
  defaultPitch: number;
}

/** 构建语音合成工作流 */
export function buildSpeechWorkflow(
  request: SpeechRequest,
  voiceProfile: VoiceProfile,
): Record<string, unknown> {
  const speed = request.speed ?? voiceProfile.defaultSpeed ?? 1.0;
  const pitch = request.pitch ?? voiceProfile.defaultPitch ?? 1.0;

  return {
    nodes: {
      "1": {
        class_type: SPEECH_NODE.LOADER,
        inputs: {
          model_name: "speech-v1",
        },
      },
      "2": {
        class_type: SPEECH_NODE.VOCAL,
        inputs: {
          embedding_path: voiceProfile.embeddingPath,
          text: request.text,
          speed,
          pitch,
        },
      },
      "3": {
        class_type: SPEECH_NODE.ENCODER,
        inputs: {
          vocal: ["2", 0],
          model: ["1", 0],
        },
      },
      "4": {
        class_type: SPEECH_NODE.DECODER,
        inputs: {
          encoded: ["3", 0],
          model: ["1", 0],
        },
      },
      "5": {
        class_type: SPEECH_NODE.OUTPUT,
        inputs: {
          audio: ["4", 0],
          filename_prefix: "ai-m-speech",
        },
      },
    },
    outputs: {
      "5": { class_type: SPEECH_NODE.OUTPUT, node_id: "5" },
    },
  };
}

/** 本地语音适配器 */
export class LocalSpeechAdapter implements SpeechProvider {
  private voiceProfiles: Map<string, VoiceProfile> = new Map();

  constructor(
    private readonly transport: ComfyUITransport,
  ) {}

  /** 注册声纹配置 */
  registerVoiceProfile(profile: VoiceProfile): void {
    this.voiceProfiles.set(profile.id, profile);
  }

  /** 列出可用的声纹配置 */
  listVoiceProfiles(): VoiceProfile[] {
    return Array.from(this.voiceProfiles.values());
  }

  async generateSpeech(request: SpeechRequest, context: ExecutionContext): Promise<SpeechResult> {
    if (!isEnabled(FF.V2_LOCAL_SPEECH)) {
      throw new Error("v2.0 local speech generation is not enabled");
    }

    const profile = this.voiceProfiles.get(request.voiceProfileId);
    if (!profile) {
      throw new Error(`Voice profile not found: ${request.voiceProfileId}`);
    }

    const clientId = (this.transport as { getClientId?: () => string }).getClientId?.() ?? "unknown";

    const workflow = buildSpeechWorkflow(request, profile);

    const response = await submitPrompt(this.transport, workflow, clientId);

    console.log(`[Speech] Submitted prompt ${response.promptId}`);

    // 轮询直到完成
    const result = await this.waitForCompletion(response.promptId);

    // 收集音频输出
    let audioFile: { filename: string; subfolder: string; type: string } | null = null;
    for (const [, nodeOutputs] of Object.entries(result.outputs)) {
      if (nodeOutputs.audio && nodeOutputs.audio.length > 0) {
        audioFile = nodeOutputs.audio[0];
        break;
      }
    }

    if (!audioFile) {
      throw new Error("No audio output found in speech result");
    }

    const buffer = await downloadOutput(this.transport, audioFile);
    const audioFilePath = `data/artifacts/${context.jobId ?? "speech"}-${Date.now()}.wav`;

    return {
      audioFilePath,
      storageKey: `audio/${audioFile.subfolder}/${audioFile.filename}`,
      durationMs: 0, // 实际长度需要解析音频文件
      format: audioFile.filename.endsWith(".mp3") ? "mp3" : "wav",
    };
  }

  private async waitForCompletion(
    promptId: string,
    maxWaitMs: number = 300_000,
  ): Promise<{ outputs: Record<string, { audio?: Array<{ filename: string; subfolder: string; type: string }> }> }> {
    const startedAt = Date.now();
    const pollInterval = 2000;

    while (Date.now() - startedAt < maxWaitMs) {
      const history = await probeHistory(this.transport, promptId);
      const entry = history[promptId];

      if (entry && entry.status.completed) {
        return entry;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Speech execution timed out after ${maxWaitMs}ms for prompt ${promptId}`);
  }
}

/** 创建本地语音适配器 */
export function createLocalSpeechAdapter(transport: ComfyUITransport): LocalSpeechAdapter {
  return new LocalSpeechAdapter(transport);
}