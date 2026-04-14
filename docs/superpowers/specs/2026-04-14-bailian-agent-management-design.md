# 百炼智能体管理 设计文档

## 目标

让用户在 AIComicBuilder 中管理自己的百炼平台智能体，并在项目的各个 pipeline 步骤中选择使用自定义智能体替代内置默认逻辑。内置 pipeline 作为"默认智能体"，用户可选择切换为自己在百炼平台创建的 agent。

## 核心决策

- **模式：混合模式** — 每个 pipeline 步骤可独立选择使用内置默认或用户自定义智能体
- **支持的步骤：** `script_outline`（故事大纲）、`script_parse`（剧本解析）、`character_extract`（角色提取）、`shot_split`（分镜拆分）
- **图片/视频步骤不支持** — 百炼 agent 是文本对话型，图片视频继续用现有 provider
- **输出校验：严格模式** — agent 返回必须符合 JSON schema，不符合直接报错
- **UI 入口：** 设置页新 tab + 项目级步骤选择器

## 架构

### 调用流程

```
Pipeline Handler 执行
  → 查询 agentBindings（projectId + category）
  → 有绑定？
    → 是：调用百炼 Agent API → JSON schema 校验 → 存入 DB
    → 否：走现有内置 pipeline（prompt template + AI provider）
```

### 百炼 Agent API

- **Endpoint:** `POST https://dashscope.aliyuncs.com/api/v1/apps/{APP_ID}/completion`
- **Auth:** `Authorization: Bearer {API_KEY}`
- **Request:**
```json
{
  "input": {
    "prompt": "用户输入（剧本/idea 等）"
  },
  "parameters": {}
}
```
- **Response:**
```json
{
  "status_code": 200,
  "output": {
    "text": "智能体返回的文本（需为符合 schema 的 JSON）",
    "finish_reason": "stop",
    "session_id": "..."
  },
  "usage": {
    "models": [{ "model_id": "...", "input_tokens": 142, "output_tokens": 296 }]
  }
}
```

关键：`output.text` 是智能体返回的文本内容，我们要求用户在百炼平台配置 agent 时确保输出为符合协议的 JSON。

## 数据模型

### 新增表：`agents`

| 字段 | 类型 | 说明 |
|------|------|------|
| id | text PK | nanoid |
| userId | text NOT NULL | 用户标识 |
| name | text NOT NULL | 智能体名称（用户自定义） |
| category | text NOT NULL | 枚举：script_outline / script_parse / character_extract / shot_split |
| appId | text NOT NULL | 百炼平台应用 ID |
| apiKey | text NOT NULL | DashScope API Key |
| description | text | 可选描述 |
| createdAt | text NOT NULL | ISO 时间戳 |
| updatedAt | text NOT NULL | ISO 时间戳 |

索引：`(userId, category)` — 按用户+分类查询

### 新增表：`agentBindings`

| 字段 | 类型 | 说明 |
|------|------|------|
| id | text PK | nanoid |
| projectId | text NOT NULL FK→projects.id | 项目 ID |
| category | text NOT NULL | 同 agents.category |
| agentId | text FK→agents.id | 绑定的智能体 ID，NULL 表示使用默认 |

约束：`UNIQUE(projectId, category)` — 每个项目每个步骤只能绑定一个智能体

## 输出协议（JSON Schema）

用户的百炼智能体必须返回符合以下格式的 JSON。校验失败将报错并提示用户修改智能体配置。

### script_outline

```json
{
  "outline": "string — 故事大纲文本"
}
```

### script_parse

```json
{
  "title": "string",
  "synopsis": "string",
  "scenes": [
    {
      "sceneNumber": "number",
      "setting": "string",
      "description": "string",
      "mood": "string",
      "dialogues": [
        {
          "character": "string",
          "text": "string",
          "emotion": "string"
        }
      ]
    }
  ]
}
```

### character_extract

```json
{
  "characters": [
    {
      "name": "string (必填)",
      "description": "string (必填)",
      "visualHint": "string (可选, 2-4字视觉标识)",
      "heightCm": "number (可选)",
      "bodyType": "string (可选)",
      "performanceStyle": "string (可选)"
    }
  ],
  "relationships": [
    {
      "characterA": "string",
      "characterB": "string",
      "relationType": "string",
      "description": "string (可选)"
    }
  ]
}
```

`relationships` 字段可选。

### shot_split

```json
[
  {
    "sceneTitle": "string",
    "sceneDescription": "string",
    "lighting": "string",
    "colorPalette": "string",
    "shots": [
      {
        "sequence": "number",
        "prompt": "string (画面描述)",
        "motionScript": "string (时间分段动作)",
        "videoScript": "string (30-60词视频描述)",
        "duration": "number (秒, 8-15)",
        "dialogues": [{ "character": "string", "text": "string" }],
        "cameraDirection": "string",
        "compositionGuide": "string",
        "focalPoint": "string",
        "depthOfField": "shallow | medium | deep",
        "soundDesign": "string",
        "musicCue": "string",
        "transitionIn": "string",
        "transitionOut": "string"
      }
    ]
  }
]
```

## API 路由

### 智能体 CRUD

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/agents` | 获取当前用户的所有智能体（通过 x-user-id header 过滤） |
| POST | `/api/agents` | 创建智能体 |
| PATCH | `/api/agents/[id]` | 更新智能体 |
| DELETE | `/api/agents/[id]` | 删除智能体 |

### 项目绑定

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/projects/[id]/agent-bindings` | 获取项目的智能体绑定 |
| PUT | `/api/projects/[id]/agent-bindings` | 设置/更新绑定（body: `{ category, agentId }` 或 `{ category, agentId: null }` 解绑） |

## Pipeline 改造

### 新增模块：`src/lib/ai/bailian-agent.ts`

百炼 Agent API 调用封装：

```typescript
interface BailianAgentConfig {
  appId: string;
  apiKey: string;
}

async function callBailianAgent(config: BailianAgentConfig, prompt: string): Promise<string>
```

- 调用 `POST https://dashscope.aliyuncs.com/api/v1/apps/{appId}/completion`
- 返回 `output.text` 字符串
- HTTP 错误或 `status_code !== 200` 时抛出错误

### 新增模块：`src/lib/ai/agent-schema.ts`

JSON schema 校验：

```typescript
function validateAgentOutput(category: AgentCategory, rawText: string): unknown
```

- 从 `rawText` 中提取 JSON（支持 markdown code block 包裹）
- 按 category 校验必填字段和类型
- 校验通过返回解析后的对象，失败抛出描述性错误

### Pipeline Handler 改造

在 `character-extract.ts`、`shot-split.ts`、`script-parse.ts`、`script-outline.ts` 中，在现有逻辑之前插入路由判断：

```typescript
// 在 handler 开头
const binding = await getAgentBinding(projectId, "character_extract");
if (binding) {
  const agent = await getAgent(binding.agentId);
  const rawText = await callBailianAgent(
    { appId: agent.appId, apiKey: agent.apiKey },
    prompt  // 将剧本/idea 作为 prompt 传入
  );
  const result = validateAgentOutput("character_extract", rawText);
  // 用 result 执行后续 DB 操作（和现有逻辑相同的存储部分）
  return result;
}
// else: 现有逻辑不变
```

## UI 设计

### 1. 设置页 — 智能体管理 Tab

位于设置页面，与模型管理并列的新 tab。

- 智能体列表：卡片式，按分类分组显示
- 每个卡片显示：名称、分类标签、appId（脱敏）、描述
- 操作：编辑、删除
- "添加智能体"按钮 → 表单：名称、分类（下拉）、应用 ID、API Key、描述

### 2. 项目级 — 步骤选择器

在项目的生成面板中（触发生成操作的地方），每个文本类步骤旁边显示小的下拉选择器：

```
[角色提取] [默认 ▾]  →  下拉：默认 / 我的角色大师 / 角色分析 Pro
[分镜拆分] [默认 ▾]  →  下拉：默认 / 分镜专家
```

选择后写入 `agentBindings` 表，持久化到项目级别。

## 不在范围内

- 多轮对话（session_id）— 当前只做单轮调用
- 流式输出 — agent 返回通常较短，同步即可
- agent 的测试/预览功能 — 后续版本考虑
- 图片/视频类步骤的 agent 替代
