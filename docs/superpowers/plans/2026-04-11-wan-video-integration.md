# 通义万相 (Wan) 视频模型接入方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标:** 将阿里云百炼的 Wan2.6 和 Wan2.7 视频生成模型（文生视频、图生视频、参考生视频）接入 AIComicBuilder。

**架构:** 在现有 provider 体系中新增 `"wan"` 协议。创建 `WanVideoProvider` 类实现 `VideoProvider` 接口，使用 DashScope 异步任务 API（提交任务 → 轮询结果）。串联 provider factory、model store、设置 UI、模型时长限制。

**技术栈:** DashScope REST API（Bearer token 认证 + `X-DashScope-Async: enable` 请求头）、Zustand model store、Next.js API 路由。

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/lib/ai/providers/wan-video.ts` | 新建 | WanVideoProvider：提交任务 + 轮询结果，支持所有 Wan 视频模型 |
| `src/stores/model-store.ts` | 修改 | Protocol 联合类型增加 `"wan"` |
| `src/lib/ai/provider-factory.ts` | 修改 | `createVideoProvider` switch 增加 `"wan"` 分支 |
| `src/components/settings/provider-form.tsx` | 修改 | 设置界面增加 `"wan"` 协议选项 + 默认 Base URL |
| `src/app/api/models/list/route.ts` | 修改 | 模型列表 API 增加 Wan 模型硬编码列表 |
| `src/lib/ai/model-limits.ts` | 修改 | 增加 Wan 模型时长上限 |

---

### 任务 1：Protocol 类型增加 `"wan"`

**文件:**
- 修改: `src/stores/model-store.ts:5`

- [ ] **步骤 1: 修改 Protocol 联合类型**

在 `src/stores/model-store.ts` 第 5 行：

```typescript
// 改前:
export type Protocol = "openai" | "gemini" | "seedance" | "kling";

// 改后:
export type Protocol = "openai" | "gemini" | "seedance" | "kling" | "wan";
```

- [ ] **步骤 2: 验证无类型错误**

执行: `npx tsc --noEmit 2>&1 | head -20`
预期: 无新增错误（下游文件会在后续任务中添加 `"wan"` 分支）。

- [ ] **步骤 3: 提交**

```bash
git add src/stores/model-store.ts
git commit -m "feat: add wan protocol type for Alibaba Wan video models"
```

---

### 任务 2：创建 WanVideoProvider

**文件:**
- 新建: `src/lib/ai/providers/wan-video.ts`

该 provider 处理三种视频生成模式：
- **关键帧模式** (firstFrame + lastFrame)：wan2.7 用 `wan2.7-r2v` 的 `first_frame` media 类型；wan2.6 用 `wan2.6-i2v-flash` 图生视频
- **参考图模式** (initialImage + 可选 referenceImages)：wan2.7 用 `wan2.7-r2v` 的 `reference_image` media；wan2.6 用 `wan2.6-r2v` 参考生视频
- **纯文本模式**：wan2.7 用 `wan2.7-t2v`；wan2.6 用 `wan2.6-t2v`

DashScope API 为异步模式：POST 创建任务 → GET 轮询状态。

**API 规格:**
- Base URL: `https://dashscope.aliyuncs.com/api/v1`
- 提交端点: `POST /services/aigc/video-generation/video-synthesis`
- 轮询端点: `GET /tasks/{task_id}`
- 必须请求头: `Authorization: Bearer {key}`, `X-DashScope-Async: enable`, `Content-Type: application/json`
- 任务状态: PENDING → RUNNING → SUCCEEDED/FAILED

**wan2.7 vs wan2.6 差异:**
- wan2.7 用 `parameters.resolution`（"720P"/"1080P"）+ `parameters.ratio`（"16:9", "9:16", "1:1", "4:3", "3:4"）
- wan2.6 用 `parameters.size`（"1280*720", "720*1280" 等像素尺寸）
- wan2.7-r2v 用 `input.media[]` 数组传媒体对象
- wan2.6 图生视频用 `input.img_url`，参考生视频格式不同

- [ ] **步骤 1: 创建 provider 文件**

创建 `src/lib/ai/providers/wan-video.ts`：

```typescript
import type { VideoProvider, VideoGenerateParams, VideoGenerateResult } from "../types";
import fs from "node:fs";
import path from "node:path";
import { id as genId } from "@/lib/id";

/** 本地文件转 data:image URL，http URL 直接透传 */
function toImageUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    return pathOrUrl;
  }
  const ext = path.extname(pathOrUrl).toLowerCase().replace(".", "");
  const mime =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "png"
        ? "image/png"
        : ext === "webp"
          ? "image/webp"
          : "image/png";
  const base64 = fs.readFileSync(pathOrUrl, { encoding: "base64" });
  return `data:${mime};base64,${base64}`;
}

/** ratio 字符串映射到 wan2.6 的 size 字符串（720P） */
function ratioToSize(ratio: string): string {
  const sizeMap: Record<string, string> = {
    "16:9": "1280*720",
    "9:16": "720*1280",
    "1:1": "960*960",
    "4:3": "1088*832",
    "3:4": "832*1088",
  };
  return sizeMap[ratio] || "1280*720";
}

interface DashScopeTaskResponse {
  output: {
    task_id: string;
    task_status: string;
    video_url?: string;
    orig_prompt?: string;
  };
  request_id: string;
  usage?: Record<string, unknown>;
}

export class WanVideoProvider implements VideoProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private uploadDir: string;

  constructor(params?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    uploadDir?: string;
  }) {
    this.apiKey = params?.apiKey || process.env.DASHSCOPE_API_KEY || "";
    this.baseUrl = (
      params?.baseUrl ||
      process.env.DASHSCOPE_BASE_URL ||
      "https://dashscope.aliyuncs.com/api/v1"
    ).replace(/\/+$/, "");
    this.model = params?.model || "wan2.7-t2v";
    this.uploadDir = params?.uploadDir || process.env.UPLOAD_DIR || "./uploads";
  }

  private isWan27(): boolean {
    return this.model.startsWith("wan2.7");
  }

  /** 根据生成模式推断实际模型 ID */
  private resolveModel(mode: "t2v" | "i2v" | "r2v"): string {
    // 用户选了具体模型变体，直接用
    if (this.model.includes("-t2v") || this.model.includes("-i2v") || this.model.includes("-r2v")) {
      return this.model;
    }
    // 否则从基础版本号 + 模式后缀拼接
    const base = this.model.replace(/-(?:t2v|i2v|r2v).*$/, "");
    return `${base}-${mode}`;
  }

  async generateVideo(params: VideoGenerateParams): Promise<VideoGenerateResult> {
    let body: Record<string, unknown>;

    if ("firstFrame" in params && params.firstFrame) {
      body = this.isWan27()
        ? this.buildWan27KeyframeBody(params as VideoGenerateParams & { firstFrame: string; lastFrame: string })
        : this.buildWan26I2VBody(params as VideoGenerateParams & { firstFrame: string });
    } else if ("initialImage" in params && params.initialImage) {
      body = this.isWan27()
        ? this.buildWan27ReferenceBody(params as VideoGenerateParams & { initialImage: string })
        : this.buildWan26R2VBody(params as VideoGenerateParams & { initialImage: string });
    } else {
      body = this.isWan27()
        ? this.buildWan27T2VBody(params)
        : this.buildWan26T2VBody(params);
    }

    console.log(`[Wan] Submitting task: model=${(body as { model: string }).model}, duration=${params.duration}s`);

    const submitUrl = `${this.baseUrl}/services/aigc/video-generation/video-synthesis`;
    const submitRes = await fetch(submitUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "X-DashScope-Async": "enable",
      },
      body: JSON.stringify(body),
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text();
      throw new Error(`Wan submit failed: ${submitRes.status} ${errText}`);
    }

    const submitResult = (await submitRes.json()) as DashScopeTaskResponse;
    const taskId = submitResult.output.task_id;
    console.log(`[Wan] Task submitted: ${taskId}`);

    const videoUrl = await this.pollForResult(taskId);

    // 下载视频到本地
    const videoRes = await fetch(videoUrl);
    const buffer = Buffer.from(await videoRes.arrayBuffer());
    const filename = `${genId()}.mp4`;
    const dir = path.join(this.uploadDir, "videos");
    fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, buffer);

    console.log(`[Wan] Saved to ${filepath}`);
    return { filePath: filepath };
  }

  // ── wan2.7 请求体构建 ──

  private buildWan27T2VBody(params: VideoGenerateParams): Record<string, unknown> {
    return {
      model: this.resolveModel("t2v"),
      input: { prompt: params.prompt },
      parameters: {
        duration: params.duration || 5,
        resolution: "720P",
        ratio: params.ratio || "16:9",
        prompt_extend: true,
        watermark: false,
      },
    };
  }

  private buildWan27KeyframeBody(params: VideoGenerateParams & { firstFrame: string; lastFrame: string }): Record<string, unknown> {
    const media: Record<string, unknown>[] = [
      { type: "first_frame", url: toImageUrl(params.firstFrame) },
    ];
    // wan2.7-r2v 官方仅支持 first_frame 媒体类型，lastFrame 的语义通过 prompt 传递
    return {
      model: this.resolveModel("r2v"),
      input: {
        prompt: params.prompt,
        media,
      },
      parameters: {
        duration: params.duration || 5,
        resolution: "720P",
        ratio: params.ratio || "16:9",
        prompt_extend: false,
        watermark: false,
      },
    };
  }

  private buildWan27ReferenceBody(params: VideoGenerateParams & { initialImage: string }): Record<string, unknown> {
    const media: Record<string, unknown>[] = [];

    // initialImage 作为首帧
    media.push({ type: "first_frame", url: toImageUrl(params.initialImage) });

    // 角色参考图（如有）
    if (params.referenceImages && params.referenceImages.length > 0) {
      for (const refImg of params.referenceImages.slice(0, 4)) {
        media.push({ type: "reference_image", url: toImageUrl(refImg) });
      }
    }

    return {
      model: this.resolveModel("r2v"),
      input: {
        prompt: params.prompt,
        media,
      },
      parameters: {
        duration: params.duration || 5,
        resolution: "720P",
        ratio: params.ratio || "16:9",
        prompt_extend: false,
        watermark: false,
      },
    };
  }

  // ── wan2.6 请求体构建 ──

  private buildWan26T2VBody(params: VideoGenerateParams): Record<string, unknown> {
    return {
      model: this.resolveModel("t2v"),
      input: { prompt: params.prompt },
      parameters: {
        size: ratioToSize(params.ratio || "16:9"),
        duration: params.duration || 5,
        prompt_extend: true,
        watermark: false,
      },
    };
  }

  private buildWan26I2VBody(params: VideoGenerateParams & { firstFrame: string }): Record<string, unknown> {
    return {
      model: this.resolveModel("i2v"),
      input: {
        prompt: params.prompt,
        img_url: toImageUrl(params.firstFrame),
      },
      parameters: {
        size: ratioToSize(params.ratio || "16:9"),
        duration: params.duration || 5,
        prompt_extend: false,
        watermark: false,
      },
    };
  }

  private buildWan26R2VBody(params: VideoGenerateParams & { initialImage: string }): Record<string, unknown> {
    return {
      model: this.resolveModel("r2v"),
      input: {
        prompt: params.prompt,
        img_url: toImageUrl(params.initialImage),
      },
      parameters: {
        size: ratioToSize(params.ratio || "16:9"),
        duration: params.duration || 5,
        prompt_extend: false,
        watermark: false,
      },
    };
  }

  // ── 轮询 ──

  private async pollForResult(taskId: string): Promise<string> {
    const maxAttempts = 60; // 15s × 60 = 15 分钟
    const interval = 15_000; // DashScope 建议 15 秒间隔

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, interval));

      const res = await fetch(`${this.baseUrl}/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      if (!res.ok) {
        console.warn(`[Wan] Poll ${i + 1}: HTTP ${res.status}`);
        continue;
      }

      const result = (await res.json()) as DashScopeTaskResponse;
      const status = result.output.task_status;
      console.log(`[Wan] Poll ${i + 1}: status=${status}`);

      if (status === "SUCCEEDED" && result.output.video_url) {
        return result.output.video_url;
      }
      if (status === "FAILED") {
        throw new Error(`Wan video generation failed: ${JSON.stringify(result.output)}`);
      }
    }

    throw new Error("Wan video generation timed out after 15 minutes");
  }
}
```

- [ ] **步骤 2: 验证编译通过**

执行: `npx tsc --noEmit 2>&1 | head -20`
预期: wan-video.ts 无错误。

- [ ] **步骤 3: 提交**

```bash
git add src/lib/ai/providers/wan-video.ts
git commit -m "feat: add WanVideoProvider for DashScope async video API"
```

---

### 任务 3：在 Provider Factory 中注册

**文件:**
- 修改: `src/lib/ai/provider-factory.ts`（import 区 + switch 语句）

- [ ] **步骤 1: 添加 import**

在 `src/lib/ai/provider-factory.ts` 顶部，KlingVideoProvider import 之后加：

```typescript
import { WanVideoProvider } from "./providers/wan-video";
```

- [ ] **步骤 2: switch 增加 `"wan"` 分支**

在 `createVideoProvider` 函数的 switch 语句中，`default:` 之前加：

```typescript
    case "wan":
      return new WanVideoProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
```

- [ ] **步骤 3: 验证编译**

执行: `npx tsc --noEmit 2>&1 | head -20`
预期: 无错误。

- [ ] **步骤 4: 提交**

```bash
git add src/lib/ai/provider-factory.ts
git commit -m "feat: register WanVideoProvider in provider factory"
```

---

### 任务 4：设置界面添加 Wan 协议选项

**文件:**
- 修改: `src/components/settings/provider-form.tsx`（DEFAULT_BASE_URLS 和视频协议选项列表）

- [ ] **步骤 1: 添加默认 Base URL**

在 `DEFAULT_BASE_URLS` 对象的 `kling` 条目后加：

```typescript
  wan: "https://dashscope.aliyuncs.com/api/v1",
```

- [ ] **步骤 2: 视频协议选项增加 `"wan"`**

在 `getProtocolOptions` 函数的 video 返回数组中添加：

```typescript
    { value: "wan", label: "Wan (通义万相)" },
```

完整的 video 返回值变为：

```typescript
  return [
    { value: "seedance", label: "Seedance" },
    { value: "gemini", label: "Gemini (Veo)" },
    { value: "kling", label: "Kling" },
    { value: "wan", label: "Wan (通义万相)" },
  ];
```

- [ ] **步骤 3: 验证无类型错误**

执行: `npx tsc --noEmit 2>&1 | head -20`
预期: 无错误。

- [ ] **步骤 4: 提交**

```bash
git add src/components/settings/provider-form.tsx
git commit -m "feat: add Wan protocol option to video settings UI"
```

---

### 任务 5：模型列表 API 增加 Wan 模型

**文件:**
- 修改: `src/app/api/models/list/route.ts`

- [ ] **步骤 1: 添加 Wan 模型列表**

在 `POST` 函数中，`kling` 协议块之后添加：

```typescript
    if (body.protocol === "wan") {
      return NextResponse.json({
        models: [
          { id: "wan2.7-t2v", name: "Wan 2.7 文生视频" },
          { id: "wan2.7-r2v", name: "Wan 2.7 参考生视频" },
          { id: "wan2.6-t2v", name: "Wan 2.6 文生视频" },
          { id: "wan2.6-i2v-flash", name: "Wan 2.6 图生视频 Flash" },
          { id: "wan2.6-i2v", name: "Wan 2.6 图生视频" },
          { id: "wan2.6-r2v", name: "Wan 2.6 参考生视频" },
          { id: "wan2.6-r2v-flash", name: "Wan 2.6 参考生视频 Flash" },
        ],
      });
    }
```

- [ ] **步骤 2: 验证编译**

执行: `npx tsc --noEmit 2>&1 | head -20`
预期: 无错误。

- [ ] **步骤 3: 提交**

```bash
git add src/app/api/models/list/route.ts
git commit -m "feat: add Wan model list to models/list API"
```

---

### 任务 6：添加 Wan 模型时长限制

**文件:**
- 修改: `src/lib/ai/model-limits.ts`

- [ ] **步骤 1: MODEL_MAX_DURATIONS 增加 Wan 条目**

在 `MODEL_MAX_DURATIONS` 对象中添加：

```typescript
  "wan2.7-t2v": 15,
  "wan2.7-r2v": 15,
  "wan2.6-t2v": 15,
  "wan2.6-i2v-flash": 15,
  "wan2.6-i2v": 10,
  "wan2.6-r2v": 10,
  "wan2.6-r2v-flash": 10,
```

- [ ] **步骤 2: 添加 Wan 系列兜底规则**

在 `FAMILY_MAX_DURATIONS` 数组中添加（放在末尾之前）：

```typescript
  ["wan2.7", 15],
  ["wan2.6", 15],
  ["wan", 15],
```

- [ ] **步骤 3: 验证编译**

执行: `npx tsc --noEmit 2>&1 | head -20`
预期: 无错误。

- [ ] **步骤 4: 提交**

```bash
git add src/lib/ai/model-limits.ts
git commit -m "feat: add Wan model duration limits"
```

---

### 任务 7：最终验证

- [ ] **步骤 1: 全量类型检查**

执行: `npx tsc --noEmit`
预期: 零错误。

- [ ] **步骤 2: 开发服务器冒烟测试**

执行: `npm run dev`，确认无启动错误。

- [ ] **步骤 3: 验证设置界面**

打开浏览器 → 设置 → 添加视频供应商 → 确认协议列表中出现 "Wan (通义万相)"。选择后 Base URL 应自动填充为 `https://dashscope.aliyuncs.com/api/v1`。点击「获取模型」应返回 Wan 模型列表。
