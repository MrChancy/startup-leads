---
description: 端到端实现一个 GitHub issue（TDD + 三层 review）。用法：/work-issue <N>
allowed-tools: Bash, Read, Write, Edit, Agent, Skill, AskUserQuestion, TaskCreate, TaskUpdate
---

# /work-issue $ARGUMENTS

你是 issue #$ARGUMENTS 在 `MrChancy/startup-leads` 上的 orchestrator。**全程对照 `CLAUDE.local.md` 的规则——pr-review / code-review 会把它当 checklist 用。**

下面的每个 gate（commit / push / merge）默认都要问用户。其它步骤直接做。

---

## 0. Pre-flight（不问，直接 fail-fast）

1. `git status --short` 必须空；`git branch --show-current` 必须是 `main`。否则停下来报告。
2. `gh issue view $ARGUMENTS --json title,body,labels,state` 读 issue。
   - 若 `state == CLOSED`，停下来告诉用户该 issue 已关闭。
   - 抽取 title（做 branch slug 用）、acceptance criteria、"Blocked by" 段。
3. 若 "Blocked by" 里任何 issue 还 open，停下来报告，**不要开始**。
4. 读 `docs/startup-leads-spec-final.md` 中与本 issue 相关的章节（issue body 通常会指明）。

## 1. Branch

5. slug = title 取 TB-N + 前 2-3 个语义词的小写连字符。例：`TB-3a: HTTP layer — HttpClient + QPS + 指数退避 + nock 拦截` → `tb-3a-http-layer`。≤ 35 字符。
6. `git checkout -b <slug>`。

## 2. 用 ts-coder 写代码（Agent + subagent_type=ts-coder）

7. Prompt 必须包含：
   - **完整 issue body**（粘贴原文）。
   - **相关 spec 片段**（不要塞全文）。
   - **out-of-scope 清单**：列出依赖图里其它 TB 的范围，让 ts-coder 别"顺手"做掉。
   - **TDD 节奏**："每条 AC 先写失败测试，再最小实现，再 refactor。不许大爆写完再补测试。"
   - **技术栈约束**：bun 1.3+, `bun:sqlite`, ESM, TS strict, `bun test`。
   - **CLAUDE.local.md 必读**："违反 S-/E-/A-/I-/T- 任一规则都会被下一个 reviewer 拒。"
   - **绝对禁止**："不许 `git commit` / `git push` / `gh pr create`。orchestrator 来做。"
   - **完工回执要求**："列出新增/修改文件、AC↔测试的映射、明确说明的取舍。"

## 3. Orchestrator 独立验证（不信子 agent 自评，W-1）

8. 跑以下命令，必须**全部**绿：
   ```bash
   bun test
   bun run typecheck
   bun run lint
   ```
9. 业务 smoke 跑**两遍**（S-3：walking skeleton 也得幂等）。比如 collector 类的：`bun run src/cli/index.ts collect` 连续两次，第二次不能崩。
10. 任何失败 → orchestrator 用 TDD 自己修（先写失败测试，再修）。**不重新调 ts-coder**，除非问题大到需要整段重写。
11. 验证完后再次跑 `git status` 和 `git diff --stat`，确认改动范围合理。

## 4. Commit（**gate：问用户**）

12. 整理 staged diff。`git add -A`。
13. 问用户："要提交这一笔吗？" 给出 diff stat。
14. 用户同意后 commit。Message 格式：
    ```
    feat: <slug 描述> (refs #$ARGUMENTS)

    <2-3 行 body 说明做了什么、关键取舍>

    Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
    ```

## 5. Pre-PR review（Agent + subagent_type=pr-review）

15. Prompt 必须包含：
    - 分支名 + 对照 `main`。
    - **out-of-scope 清单**（同 step 7）——避免它抓"缺这个缺那个"。
    - **特别关注项**：本 issue 的 AC 边界 + CLAUDE.local.md 高危规则。
16. 读 verdict：
    - **SHIP** → 走 step 17。
    - **FIX FIRST** → 按 TDD 修 HIGH/MEDIUM finding（每条都先写失败测试），新建 commit（**不要 amend**），跑 step 8-11 再验证，回 step 13 再次问用户。
    - **REWORK** → 把 verdict 转给 ts-coder，从 step 7 重来一次。

## 6. Push + 开 PR

17. `git push -u origin <slug>`。
18. `gh pr create` body 结构：
    ```
    ## Summary
    - <一句话>
    Closes #$ARGUMENTS.

    ## Scope notes
    <out-of-scope 说明 + TB 之间的取舍>

    ## Review history
    <pr-review verdict + 改了啥>

    ## Test plan
    - [x] bun test ...
    - [x] bun run typecheck ...
    ...
    ```

## 7. Post-PR review（Skill: /code-review --comment）

19. 选 effort：
    - diff `< 500` 行 → `low`
    - `500-2000` 行 → `medium`（默认）
    - `> 2000` 行 或跨多模块 → `high`
    - **永远不要 xhigh / ultra**，除非用户明确要求。（W-2）
20. 读取 findings：
    - **HIGH severity 在本 PR 内修**（TDD：先写失败测试，再修，新 commit）。
    - **MEDIUM/LOW 起 follow-up issue**，**合并成 1-2 个**而非 5 个（W-3）。issue body 引用 PR URL + code-review comment URL。

## 8. Merge（**gate：问用户**）

21. 问用户："要合并 PR 吗？默认 `gh pr merge --merge --delete-branch`（保留 TDD commit 历史，不 squash）。"
22. 同意后合并。
23. `git checkout main && git pull --ff-only`。
24. `gh issue view $ARGUMENTS --json state` 确认自动关闭（PR body 里 `Closes #$ARGUMENTS` 应该触发）。

## 9. Cleanup

25. 列出依赖了 #$ARGUMENTS 的 open issue：`gh issue list --search "Blocked by #$ARGUMENTS"` 或读它们 body 里的 Blocked by。
26. 对那些**只依赖** #$ARGUMENTS 的 issue：`gh issue edit <N> --remove-label blocked`。仍有其它 open blocker 的不动。
27. 若本轮发现了 CLAUDE.local.md 还没记录的新型 bug 类别：建议用户更新规则文件（不要自动写）。

## 10. Final report

最后输出：
- PR URL + merge SHA
- 解锁的 issue 列表（号 + title）
- follow-up issue 列表（如有）
- CLAUDE.local.md 建议变更（如有）

---

## 全程约束

- **三个 gate** 必须等用户：commit、merge、（如果用户没事先授权）任何破坏性 git 操作。
- **同时最多 2 个后台 Agent**——大并发会撞 session 限额（W-2）。
- 调 Agent 时 `run_in_background: true`，让主 session 不阻塞。
- 任何步骤撞限额 / 报错 / 不确定 → 停下来报告，不要硬撑。
- 主 session 的对话历史就是审计 trail——把每个 gate 的决策和原因留在对话里。
