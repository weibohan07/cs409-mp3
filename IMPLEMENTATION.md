# MP3 实现、运行与修改指南

这份基础实现以仓库的 [README](README.md) 和 [FAQ](FAQ.md) 为验收标准，目标是完整覆盖公开评分要求，方便你继续修改。**本地测试通过不等于官方满分**：实际分数需要对接 Atlas、部署 Render 后运行课程自测；最终还要提交课程表单。

## 1. 项目做什么

这是任务管理系统的 REST API（通过 HTTP 读写资源的接口）。作业需要后端接口，不要求前端页面或登录系统。路径统一以 `/api` 开头。

| 路径 | 方法 | 行为 |
| --- | --- | --- |
| `/api/users` | GET、POST | 查询用户列表、创建用户 |
| `/api/users/:id` | GET、PUT、DELETE | 查询、完整替换、删除用户 |
| `/api/tasks` | GET、POST | 查询任务列表、创建任务 |
| `/api/tasks/:id` | GET、PUT、DELETE | 查询、完整替换、删除任务 |

业务响应统一为 `{ "message": "说明", "data": ... }`。POST 成功返回 `201` 和创建后的对象；GET、PUT 成功返回 `200`。根据 2026-11-03 实际课程评分器的反馈，DELETE 成功必须返回 **`204 No Content` 且响应体完全为空**（之前的 `200 + JSON` 导致两个 DELETE 测试失分）。CORS 预检 OPTIONS 同样返回 `204` 且不发送响应体。失败请求仍返回带 `message` 和 `data` 的 JSON。

字段和默认值：

| 模型 | 必填 | 可选字段及默认值 |
| --- | --- | --- |
| User | `name`、`email` | `pendingTasks: []`；`dateCreated` 由服务器生成 |
| Task | `name`、`deadline` | `description: ""`、`completed: false`、`assignedUser: ""`、`assignedUserName: "unassigned"`；`dateCreated` 由服务器生成 |

客户端传入 `dateCreated` 会被忽略；PUT 保留原创建时间。用户邮箱不能重复。`pendingTasks` 存放任务 ID 字符串，`assignedUser` 存放用户 ID 字符串。JSON 请求严格检查类型，例如 `completed` 应为布尔值 `false`，不能写成字符串 `"false"`。同时支持 `application/x-www-form-urlencoded` 表单：其中 `completed=true/false` 字符串会转换为布尔值，`pendingTasks` 可用 JSON 数组字符串提供。

## 2. 最容易丢分的规则

### PUT 是完整替换

`PUT /api/tasks/:id` 仍然必须包含 `name` 和 `deadline`；省略 `completed` 会恢复 `false`，省略 `assignedUser` 会取消指派。用户 PUT 必须包含 `name`、`email`，省略 `pendingTasks` 等价于提交空列表。这不是 PATCH；修改一个字段时，请同时发送希望保留的其他可写字段。

### 用户和任务必须双向一致

`pendingTasks` 的含义是“这个用户已被指派、而且尚未完成的任务”。实现把相关写操作放进 MongoDB transaction（事务：一组数据库修改全部成功才提交），避免只改了一边。

| 操作 | 应当发生的联动 |
| --- | --- |
| 给用户指派未完成任务 | 任务保存用户 ID 和姓名；用户列表包含任务 ID |
| 把任务从 A 改派给 B | 从 A 的列表移除，再加入 B 的列表 |
| 完成任务 | 从用户待办列表移除；任务仍保存指派关系 |
| 把已完成任务恢复为未完成 | 若仍有负责人，重新加入负责人的待办列表 |
| 更新用户的待办列表 | 被移除的任务取消指派；新增任务归该用户；从其他用户移来的任务也同步移除旧关系 |
| 用户改名 | 已指派的任务同步姓名，包括已完成任务 |
| 删除任务 | 从负责人的待办列表移除 |
| 删除用户 | 该用户的所有任务取消指派，包括已完成任务；任务本身保留 |

已完成任务不能加入用户 `pendingTasks`，但可以通过任务 PUT 改派给其他用户。指定 `assignedUser` 后，可以省略 `assignedUserName` 让服务器补齐；明确提供错误的姓名应返回 `400`。

### 错误状态码和失败回滚

| 情况 | 返回 |
| --- | --- |
| URL 中的用户/任务 ID 格式错误，或对应资源不存在 | `404` |
| 必填字段缺失、字段类型错误、重复邮箱 | `400` |
| 请求体中的关联 ID 格式错误 | `400` |
| 关联 ID 格式合法，但关联用户/任务不存在 | `404` |
| 把已完成任务放入待办列表，或指派的 ID 与姓名不匹配 | `400` |
| 意外数据库/服务器错误 | `500`，不暴露数据库错误细节 |

PUT 先检查 URL 资源，然后检查字段，再检查关联资源。失败请求不能留下局部修改。测试应同时检查 HTTP 响应和随后 GET 到的数据库状态。

### 查询在数据库中执行

集合 GET 支持 JSON 编码的 `where`、`sort`、`select`、`skip`、`limit`、`count`，可组合使用，通过 Mongoose 查询完成过滤、排序、投影和分页。tasks 默认最多 `100` 条，users 默认不限数量。

- `count=true`：本实现返回满足 `where` 的**总数**，不受 `skip`、`limit` 影响；仍检查已提供参数的格式。公开文档未单独给出分页计数示例，这里按“匹配查询的文档数量”解释。
- 集合没有匹配项：`200`，`data` 为 `[]`；计数模式为 `0`。
- 单资源 GET 只应用 `select`，忽略 `where`、`sort`、`skip`、`limit`、`count`，包括这些被忽略参数中的非法 JSON。
- `select` 使用 MongoDB 的包含/排除规则；`_id` 可以特别排除，其他字段不能随意混合包含与排除。

例如查询未完成任务，按截止时间升序排序，只取名称和截止时间：

```bash
curl -G http://localhost:3000/api/tasks \
  --data-urlencode 'where={"completed":false}' \
  --data-urlencode 'sort={"deadline":1}' \
  --data-urlencode 'select={"name":1,"deadline":1,"_id":0}' \
  --data-urlencode 'limit=10'
```

## 3. 本地运行

需要 Node 24 LTS；`.nvmrc` 和 `package.json` 已固定这个主版本。

```bash
nvm install
nvm use
npm ci
cp .env.example .env
```

在 `.env` 中填写自己的 `MONGODB_URI`，然后：

```bash
npm start
```

默认地址为 `http://localhost:3000`。`GET /` 和 `GET /api` 提供健康响应；业务从 `/api/users`、`/api/tasks` 开始。`npm run dev` 可在文件修改后自动重启。服务启动时会连接数据库并等待索引建立，成功后才监听端口。

**数据库要求：**线上使用 Atlas；本地如自行运行 MongoDB，需要配置 replica set（副本集），因为跨 User/Task 的写操作使用事务。单独启动一个未配置副本集的 `mongod` 不支持这些事务。

Atlas 配置要点：使用数据库用户的用户名和密码，不是 Atlas 网站登录密码；URI 中密码的特殊字符需要 URL 编码；选用独立的 MP3 数据库名；按课程要求配置 Network Access，让 Render 能访问集群。把真实 URI 留在 `.env` 或 Render 环境变量中。

快速创建用户：

```bash
curl -i http://localhost:3000/api/users \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com"}'
```

快速创建未指派任务：

```bash
curl -i http://localhost:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"name":"Read MP3 FAQ","deadline":"2026-11-03T23:00:00Z"}'
```

## 4. 运行测试

```bash
npm run check
npm test
```

也可以分别运行 `npm run test:unit` 和 `npm run test:integration`。集成测试通过 `mongodb-memory-server` 启动真实 MongoDB 的临时单节点副本集，并通过 HTTP 请求检查接口；它不是对数据库接口的 mock（模拟替身），不需要自己的 Atlas URI。安装依赖或首次运行时可能下载 MongoDB 可执行文件，因此需要网络；无法下载时应修复环境后重试，不能把“测试未运行”当成通过。

重点验收内容是创建/验证、替换语义、创建时间不变、单资源投影、查询参数组合、双向关系、删除后的引用清理，以及失败请求的状态回滚。测试结果以实际运行输出为准；这些测试不代表课程所有未公开用例。

## 5. 部署到 Render

仓库包含 `render.yaml`，可用 Render Blueprint 导入；也可以手动创建 Web Service：

| 配置项 | 值 |
| --- | --- |
| Runtime | Node |
| Node 版本 | `24` |
| Instance | Free |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/api` |
| 环境变量 | `NODE_ENV=production`，`MONGODB_URI=<自己的 Atlas URI>` |

Blueprint 的 `MONGODB_URI` 配置为 `sync: false`，导入时填写真实值；代码没有内置数据库凭据。Render 自动注入 `PORT`，无需写死端口。选择包含这次实现的分支后部署，检查构建/启动日志，再访问公开的 `/api/users`、`/api/tasks` 确认数据库连接成功。

当前基础代码不包含你的 Atlas 凭据或实际部署地址；写好 Blueprint 不等于服务已经创建或上线。

## 6. 官方自测与正式提交

部署后，任选一种方式配置公开根地址，例如 `https://my-mp3.onrender.com`：

1. 在 `.env` 中加入 `API_URL=https://my-mp3.onrender.com`；或通过进程环境变量提供它。
2. 也可以按官方 README 修改 `submit.js` 顶部的 `API_URL` 常量。

环境变量优先；脚本清理末尾 `/`。**不要附加 `/api`**，课程 grader 会自己添加它。脚本会拒绝 localhost、明显的内网地址、带路径/查询/凭据的地址；实际可访问性仍由部署状态决定。`AUTOGRADER_URL` 保持课程原值。

```bash
npm run submit
```

Render 免费服务闲置后可能休眠，先打开服务根地址等待响应，再运行自测。一次可能需要数分钟；课程说明约每 2 分钟最多 5 次，不要密集重复运行。自测会在数据库中创建并尝试删除测试数据。

公开评分权重：

| 项目 | 权重 |
| --- | --- |
| 创建与验证用户/任务 | 20% |
| 单资源 `select` | 7.5% |
| 更新不存在的资源 | 10% |
| 双向引用与一致性 | 27.5% |
| 任务查询参数 | 15% |
| 删除用户/任务 | 20% |

每项大约 75% 看行为、25% 看 HTTP 状态码；还要保留 `.gitignore`、避免提交 `.env`，否则各有独立的 1% 扣分。正式要求仍以 [README 的 Grading、Tips、Submission Details 和 LLM Policy](README.md) 为准。

**`npm run submit` 只是自测，不是交作业。** 最后必须完成 [课程提交表单](https://forms.gle/4V1v2VWU78XwM3H57)，提交要求的源代码/部署信息，并保持服务可访问。README 的截止时间是 **2026 年 11 月 3 日 23:59 CT**。README 要求个人账户下的 public repository；若当前仓库仍是 private，需要在正式提交前自行处理其可见性。

使用 ChatGPT 生成代码后，还必须随源码提交**真实聊天记录**并回答评分表单中的 LLM 使用问卷。`SOURCES.md` 记录来源和 AI 使用说明，但不能替代聊天记录。你应保留和提交实际会话导出，不应补写或模拟一份“聊天记录”。

## 7. 如何在这份基础上修改

| 想修改的内容 | 主要位置 |
| --- | --- |
| 字段和默认值、数据库索引 | `models/user.js`、`models/task.js` |
| 请求体类型/必填校验 | `lib/validation.js` |
| GET 参数解析与 Mongoose 查询 | `lib/query.js`、`routes/users.js`、`routes/tasks.js` |
| 指派、完成状态、改名、删除等业务联动 | `services/users.js`、`services/tasks.js` |
| 状态码和 JSON 错误格式 | `lib/errors.js` |
| 中间件、CORS、路由注册 | `app.js`、`routes/index.js` |
| 数据库连接、启动/关闭 | `server.js` |
| 自动验收用例 | `test/` |

建议先保留当前可用版本，再逐项修改；每完成一项运行 `npm test`。新增业务字段时，要同时决定默认值、PUT 中省略时的含义和 GET 的筛选/投影行为。若增加前端，继续让原有 `/api` 路径及响应结构符合课程协议。若增加鉴权，不要让课程要求的接口意外变成需要登录才能调用。
